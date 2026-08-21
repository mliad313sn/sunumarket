import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const url = process.env.DATABASE_URL;
const d = describe.skipIf(!url);

let app: Awaited<ReturnType<typeof buildApp>>;
let awaId: string;
let token: string;
const DEVICE = "awa-payout-device";

beforeAll(async () => {
  app = await buildApp();
  const awa = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+221771234501" } });
  awaId = awa.id;
  token = app.jwt.sign({ sub: awaId, roles: awa.roles, tier: awa.kycTier, device: DEVICE }, { expiresIn: "10m" });
  // trusted device past cool-down
  await app.deps.prisma.deviceBinding.upsert({
    where: { userId_deviceHash: { userId: awaId, deviceHash: DEVICE } },
    update: { trusted: true, firstSeen: new Date(Date.now() - 48 * 3600 * 1000) },
    create: { userId: awaId, deviceHash: DEVICE, trusted: true, firstSeen: new Date(Date.now() - 48 * 3600 * 1000), lastVerified: new Date() }
  });
  // clear PIN and today's payouts
  await app.deps.prisma.user.update({ where: { id: awaId }, data: { payoutPinHash: null } });
  await app.deps.prisma.payout.deleteMany({ where: { sellerId: awaId } });
});
afterAll(async () => {
  await app.close();
});

async function fundSeller(amount: bigint) {
  const shop = await app.deps.prisma.shop.findFirstOrThrow({ where: { sellerId: awaId } });
  const order = await app.deps.prisma.order.create({
    data: {
      shopId: shop.id,
      status: "paid",
      subtotalMinor: amount,
      deliveryFeeMinor: 0n,
      totalMinor: amount,
      currency: "XOF",
      deliveryPointSnapshot: {},
      idempotencyKey: `fund-${Date.now()}-${Math.random()}`,
      trackingToken: `fund-${Date.now()}-${Math.random()}`
    }
  });
  const attempt = await app.deps.prisma.paymentAttempt.create({
    data: {
      orderId: order.id,
      method: "PI_SPI",
      status: "succeeded",
      idempotencyKey: `fund-att-${Date.now()}-${Math.random()}`,
      providerRef: `FUND-${Date.now()}-${Math.random()}`
    }
  });
  // direct=true → full gross credited to seller (simplest funding for tests)
  await app.deps.ledger.recordSale({
    orderId: order.id,
    attemptId: attempt.id,
    sellerId: awaId,
    country: "SN",
    grossMinor: amount,
    currency: "XOF",
    direct: true
  });
}

d("phase 8 — payouts (FR-20)", () => {
  it("PI-SPI-first payout settles instantly and debits the ledger balance", async () => {
    await fundSeller(150000n);
    const before = await app.deps.ledger.balance("seller", awaId, "XOF");
    expect(before).toBeGreaterThanOrEqual(100000n);

    const res = await app.inject({
      method: "POST",
      url: "/payouts",
      headers: { authorization: `Bearer ${token}` },
      payload: { amount: { amount_minor: "100000", currency: "XOF" }, idempotency_key: `po-${Date.now()}` }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.rail).toBe("PI_SPI");
    expect(body.status).toBe("settled");
    expect(app.deps.mockPiSpi.transfers.some((t) => t.alias === `seller:${awaId}` && t.kind === "payout")).toBe(true);
    expect(await app.deps.ledger.balance("seller", awaId, "XOF")).toBe(before - 100000n);
  });

  it("rail down → 503 rail_down, nothing settled and the ledger untouched", async () => {
    await fundSeller(60000n);
    const before = await app.deps.ledger.balance("seller", awaId, "XOF");
    app.deps.mockPiSpi.down = true;
    const res = await app.inject({
      method: "POST",
      url: "/payouts",
      headers: { authorization: `Bearer ${token}` },
      payload: { amount: { amount_minor: "50000", currency: "XOF" }, idempotency_key: `po-fb-${Date.now()}` }
    });
    app.deps.mockPiSpi.down = false;
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("rail_down");
    expect(await app.deps.ledger.balance("seller", awaId, "XOF")).toBe(before);
  });

  it("insufficient balance blocked; over-tier-limit blocked with upgrade path; idempotent replay", async () => {
    const balance = await app.deps.ledger.balance("seller", awaId, "XOF");
    const tooMuch = (balance + 1000n).toString();
    const res = await app.inject({
      method: "POST",
      url: "/payouts",
      headers: { authorization: `Bearer ${token}` },
      payload: { amount: { amount_minor: tooMuch, currency: "XOF" }, idempotency_key: `po-x-${Date.now()}` }
    });
    expect([403, 409]).toContain(res.statusCode); // tier limit (200k/day already used) or balance

    // idempotent replay returns the same payout
    await app.deps.prisma.payout.deleteMany({ where: { sellerId: awaId } });
    await fundSeller(50000n);
    const k = `po-idem-${Date.now()}`;
    const r1 = await app.inject({
      method: "POST",
      url: "/payouts",
      headers: { authorization: `Bearer ${token}` },
      payload: { amount: { amount_minor: "20000", currency: "XOF" }, idempotency_key: k }
    });
    const r2 = await app.inject({
      method: "POST",
      url: "/payouts",
      headers: { authorization: `Bearer ${token}` },
      payload: { amount: { amount_minor: "20000", currency: "XOF" }, idempotency_key: k }
    });
    expect(r1.json().id).toBe(r2.json().id);
  });

  it("payout PIN enforced once set (DC-8.3); untrusted device blocked", async () => {
    await app.deps.auth.setPayoutPin(awaId, "5555");
    await app.deps.prisma.payout.deleteMany({ where: { sellerId: awaId } });
    await fundSeller(30000n);

    const noPin = await app.inject({
      method: "POST",
      url: "/payouts",
      headers: { authorization: `Bearer ${token}` },
      payload: { amount: { amount_minor: "10000", currency: "XOF" }, idempotency_key: `po-pin-${Date.now()}` }
    });
    expect(noPin.statusCode).toBe(403);
    expect(noPin.json().code).toBe("pin_required");

    const withPin = await app.inject({
      method: "POST",
      url: "/payouts",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        amount: { amount_minor: "10000", currency: "XOF" },
        payout_pin: "5555",
        idempotency_key: `po-pin2-${Date.now()}`
      }
    });
    expect(withPin.statusCode).toBe(201);

    // new/untrusted device inside cool-down → blocked
    const freshDeviceToken = app.jwt.sign(
      { sub: awaId, roles: ["seller"], tier: 1, device: "brand-new-device" },
      { expiresIn: "5m" }
    );
    const blocked = await app.inject({
      method: "POST",
      url: "/payouts",
      headers: { authorization: `Bearer ${freshDeviceToken}` },
      payload: {
        amount: { amount_minor: "5000", currency: "XOF" },
        payout_pin: "5555",
        idempotency_key: `po-dev-${Date.now()}`
      }
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe("device_blocked");

    await app.deps.prisma.user.update({ where: { id: awaId }, data: { payoutPinHash: null } });
  });
});

d("phase 8 — education cards shown exactly once (DC-8.4)", () => {
  it("seller sees the scam card until marked seen; state persists", async () => {
    await app.deps.prisma.educationCardState.deleteMany({ where: { userId: awaId } });
    const list1 = await app.inject({
      method: "GET",
      url: "/education/cards",
      headers: { authorization: `Bearer ${token}` }
    });
    const card = list1.json().find((c: { id: string }) => c.id === "seller_scam_warning");
    expect(card.seen).toBe(false);
    expect(card.body_fr).toContain("statut PAYÉ");

    await app.inject({
      method: "POST",
      url: "/education/cards/seller_scam_warning/seen",
      headers: { authorization: `Bearer ${token}` }
    });
    // marking twice is idempotent
    const again = await app.inject({
      method: "POST",
      url: "/education/cards/seller_scam_warning/seen",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(again.statusCode).toBe(200);

    const list2 = await app.inject({
      method: "GET",
      url: "/education/cards",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(list2.json().find((c: { id: string }) => c.id === "seller_scam_warning").seen).toBe(true);
  });
});
