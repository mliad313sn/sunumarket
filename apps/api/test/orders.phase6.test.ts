import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const url = process.env.DATABASE_URL;
const d = describe.skipIf(!url);

let app: Awaited<ReturnType<typeof buildApp>>;
let shopId: string;
let buyerToken: string;

const CI_PIN = { lat: 5.33, lng: -4.0, landmark: "En face de la pharmacie du Plateau" };

async function makeProduct(stock: number, price = 10000n) {
  return app.deps.prisma.product.create({
    data: {
      shopId,
      title: `race-test-${Date.now()}-${Math.random()}`,
      priceMinor: price,
      currency: "XOF",
      stock,
      status: "active"
    }
  });
}

function orderPayload(productId: string, key: string, qty = 1) {
  return {
    shop_id: shopId,
    items: [{ product_id: productId, qty }],
    delivery_point: { pin: CI_PIN },
    guest_phone: "+2250701239999",
    idempotency_key: key
  };
}

beforeAll(async () => {
  app = await buildApp();
  const shop = await app.deps.prisma.shop.findUniqueOrThrow({ where: { slug: "adjoua-beaute" } });
  shopId = shop.id;
  const buyer = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+2250701234502" } });
  buyerToken = app.jwt.sign({ sub: buyer.id, roles: buyer.roles, tier: 0, device: "t" }, { expiresIn: "10m" });
});
afterAll(async () => {
  await app.close();
});

d("phase 6 — order creation", () => {
  it("guest checkout: creates a payment_pending order with fee, totals, tracking token, 30-min hold", async () => {
    const p = await makeProduct(5, 12000n);
    const res = await app.inject({ method: "POST", url: "/orders", payload: orderPayload(p.id, `k-${p.id}`, 2) });
    expect(res.statusCode).toBe(201);
    const order = res.json();
    expect(order.status).toBe("payment_pending");
    expect(order.subtotal.amount_minor).toBe("24000");
    expect(order.delivery_fee.amount_minor).toBe("1000"); // Plateau-Cocody zone
    expect(order.total.amount_minor).toBe("25000");
    expect(order.tracking_token).toBeTruthy();
    const holdMs = new Date(order.payment_expires_at).getTime() - Date.now();
    expect(holdMs).toBeGreaterThan(29 * 60 * 1000);
    expect(holdMs).toBeLessThan(31 * 60 * 1000);

    const after = await app.deps.prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.stock).toBe(3); // decremented immediately (reservation)
  });

  it("guest without phone is rejected; token users don't need guest_phone", async () => {
    const p = await makeProduct(2);
    const { guest_phone: _g, ...noPhone } = orderPayload(p.id, `k2-${p.id}`);
    const bad = await app.inject({ method: "POST", url: "/orders", payload: noPhone });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${buyerToken}` },
      payload: noPhone
    });
    expect(ok.statusCode).toBe(201);
  });

  it("out-of-zone delivery point is refused pre-payment (FR-24)", async () => {
    const p = await makeProduct(2);
    const payload = orderPayload(p.id, `k3-${p.id}`);
    payload.delivery_point = { pin: { lat: 48.85, lng: 2.35, landmark: "Paris" } };
    const res = await app.inject({ method: "POST", url: "/orders", payload });
    expect(res.statusCode).toBe(422);
  });

  it("duplicate idempotency key returns the SAME order, no double stock decrement", async () => {
    const p = await makeProduct(5);
    const key = `dup-${p.id}`;
    const r1 = await app.inject({ method: "POST", url: "/orders", payload: orderPayload(p.id, key) });
    const r2 = await app.inject({ method: "POST", url: "/orders", payload: orderPayload(p.id, key) });
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().id).toBe(r1.json().id);
    const after = await app.deps.prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.stock).toBe(4); // exactly one decrement
  });

  it("RACE: 20 parallel orders on stock=1 → exactly 1 winner (Phase 6 gate)", async () => {
    const p = await makeProduct(1);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        app.inject({ method: "POST", url: "/orders", payload: orderPayload(p.id, `race-${p.id}-${i}`) })
      )
    );
    const winners = results.filter((r) => r.statusCode === 201);
    const losers = results.filter((r) => r.statusCode === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(19);
    const after = await app.deps.prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.stock).toBe(0);
  });
});

d("phase 6 — expiry restores stock exactly once (FR-17)", () => {
  it("expired order restores stock; double-expiry sweep does not double-restore", async () => {
    const p = await makeProduct(3);
    const res = await app.inject({ method: "POST", url: "/orders", payload: orderPayload(p.id, `exp-${p.id}`, 2) });
    const orderId = res.json().id as string;
    expect((await app.deps.prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stock).toBe(1);

    await app.deps.prisma.order.update({
      where: { id: orderId },
      data: { paymentExpiresAt: new Date(Date.now() - 60_000) }
    });

    const n = await app.deps.orders.expireOverdueOrders();
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("expired");
    expect((await app.deps.prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stock).toBe(3);

    // Sweep again + direct restore attempt: stock must stay 3 (exactly-once guard).
    await app.deps.orders.expireOverdueOrders();
    expect((await app.deps.prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stock).toBe(3);
  });

  it("illegal transition is rejected by the state machine (e.g. expired → paid)", async () => {
    const p = await makeProduct(1);
    const res = await app.inject({ method: "POST", url: "/orders", payload: orderPayload(p.id, `ill-${p.id}`) });
    const orderId = res.json().id as string;
    await app.deps.prisma.order.update({
      where: { id: orderId },
      data: { paymentExpiresAt: new Date(Date.now() - 1000) }
    });
    await app.deps.orders.expireOverdueOrders();
    await expect(app.deps.orders.transition(orderId, "paid")).rejects.toThrow(/illegal/);
  });
});

d("phase 6 — tracking & inbox", () => {
  it("tokenized tracking works unauthenticated; rotation invalidates the old link", async () => {
    const p = await makeProduct(2);
    const res = await app.inject({ method: "POST", url: "/orders", payload: orderPayload(p.id, `trk-${p.id}`) });
    const { id, tracking_token } = res.json();

    const track = await app.inject({ method: "GET", url: `/track/${tracking_token}` });
    expect(track.statusCode).toBe(200);
    expect(track.json().status).toBe("payment_pending");
    // Pass-3 (B3): the tracking view exposes the order id for dispute/rating posts.
    expect(track.json().order_id).toBe(id);

    const seller = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+2250701234505" } });
    const sellerToken = app.jwt.sign({ sub: seller.id, roles: seller.roles, tier: 1, device: "t" }, { expiresIn: "5m" });
    const rot = await app.inject({
      method: "POST",
      url: `/orders/${id}/rotate-tracking`,
      headers: { authorization: `Bearer ${sellerToken}` }
    });
    expect(rot.statusCode).toBe(200);
    const old = await app.inject({ method: "GET", url: `/track/${tracking_token}` });
    expect(old.statusCode).toBe(404);
    const fresh = await app.inject({ method: "GET", url: `/track/${rot.json().tracking_token}` });
    expect(fresh.statusCode).toBe(200);
  });

  it("seller inbox lists shop orders; other sellers are isolated", async () => {
    const seller = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+2250701234505" } });
    const sellerToken = app.jwt.sign({ sub: seller.id, roles: seller.roles, tier: 1, device: "t" }, { expiresIn: "5m" });
    const inbox = await app.inject({
      method: "GET",
      url: `/shops/${shopId}/orders`,
      headers: { authorization: `Bearer ${sellerToken}` }
    });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().length).toBeGreaterThan(0);

    const otherSeller = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+221771234501" } });
    const otherToken = app.jwt.sign({ sub: otherSeller.id, roles: otherSeller.roles, tier: 1, device: "t" }, { expiresIn: "5m" });
    const denied = await app.inject({
      method: "GET",
      url: `/shops/${shopId}/orders`,
      headers: { authorization: `Bearer ${otherToken}` }
    });
    expect(denied.statusCode).toBe(403);
  });
});
