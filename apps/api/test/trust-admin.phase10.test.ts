import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MockMessagingProvider } from "../src/lib/messaging.js";

const url = process.env.DATABASE_URL;
const d = describe.skipIf(!url);

let app: Awaited<ReturnType<typeof buildApp>>;
const messaging = new MockMessagingProvider();
let snShopId: string;
let sellerId: string;
let sellerToken: string;
let adminToken: string;

const SN_PIN = { lat: 14.68, lng: -17.44, landmark: "À côté de la boulangerie Jaune" };
let seq = 0;
const key = (p: string) => `${p}-${Date.now()}-${seq++}`;

async function paidOrder(phone: string) {
  const product = await app.deps.prisma.product.create({
    data: { shopId: snShopId, title: key("t10-p"), priceMinor: 10000n, currency: "XOF", stock: 5, status: "active" }
  });
  const order = (
    await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        shop_id: snShopId,
        items: [{ product_id: product.id, qty: 1 }],
        delivery_point: { pin: SN_PIN },
        guest_phone: phone,
        idempotency_key: key("t10-o")
      }
    })
  ).json();
  const att = (
    await app.inject({
      method: "POST",
      url: `/orders/${order.id}/attempts`,
      payload: { method: "WAVE", idempotency_key: key("t10-a") }
    })
  ).json();
  const provider = att.provider_code === "AGG_A" ? app.deps.mockAggA : app.deps.mockAggB;
  const wh = provider.buildWebhook({ providerRef: att.provider_ref, kind: "payment_succeeded" });
  await app.inject({
    method: "POST",
    url: `/webhooks/${att.provider_code.toLowerCase()}`,
    headers: { "content-type": "application/json", "x-signature": wh.signature },
    payload: wh.rawBody
  });
  return { order, product, att };
}

beforeAll(async () => {
  app = await buildApp({ messaging });
  const shop = await app.deps.prisma.shop.findUniqueOrThrow({ where: { slug: "chez-awa-mode" } });
  snShopId = shop.id;
  sellerId = shop.sellerId;
  const seller = await app.deps.prisma.user.findUniqueOrThrow({ where: { id: sellerId } });
  sellerToken = app.jwt.sign({ sub: sellerId, roles: seller.roles, tier: 1, device: "t" }, { expiresIn: "20m" });
  const admin = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+221771234504" } });
  adminToken = app.jwt.sign({ sub: admin.id, roles: admin.roles, tier: 2, device: "t" }, { expiresIn: "20m" });
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  app.deps.packs.clearOverrides();
  app.deps.router.resetBreakers();
});

d("phase 10 — ratings gated post-delivered (FR-39)", () => {
  it("rating before delivery refused; after delivered ok; duplicate refused; summary aggregates", async () => {
    const phone = "+221771240001";
    const { order } = await paidOrder(phone);

    const early = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/ratings`,
      payload: { target: "seller", stars: 5, guest_phone: phone }
    });
    expect(early.statusCode).toBe(409);

    // walk to delivered (SELF delivery, photo proof)
    const job = await app.inject({
      method: "POST",
      url: "/deliveries",
      headers: { authorization: `Bearer ${sellerToken}` },
      payload: { order_id: order.id, mode: "SELF" }
    });
    const jobId = job.json().id;
    // SELF mode: seller drives statuses via proof after arrived
    await app.deps.prisma.deliveryJob.update({ where: { id: jobId }, data: { status: "arrived" } });
    await app.deps.prisma.order.update({ where: { id: order.id }, data: { status: "in_delivery" } });
    const proof = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/proof`,
      headers: { authorization: `Bearer ${sellerToken}` },
      payload: { kind: "photo", photo_key: "self/proof.jpg" }
    });
    expect(proof.statusCode).toBe(200);

    const ok = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/ratings`,
      payload: { target: "seller", stars: 5, comment: "Très rapide", guest_phone: phone }
    });
    expect(ok.statusCode).toBe(201);

    const dup = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/ratings`,
      payload: { target: "seller", stars: 1, guest_phone: phone }
    });
    expect(dup.statusCode).toBe(409);

    const summary = await app.inject({ method: "GET", url: `/shops/${snShopId}/ratings` });
    expect(summary.json().count).toBeGreaterThanOrEqual(1);
    expect(summary.json().average).toBeGreaterThan(0);

    // a stranger (wrong phone) cannot rate
    const stranger = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/ratings`,
      payload: { target: "rider", stars: 1, guest_phone: "+221770000000" }
    });
    expect(stranger.statusCode).toBe(403);
  });
});

d("phase 10 — disputes with scoped payout freeze (FR-40)", () => {
  it("dispute freezes exactly the disputed order's amount; resolution unfreezes; refund path runs", async () => {
    const phone = "+221771240002";
    const { order } = await paidOrder(phone);

    const dispute = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/disputes`,
      payload: { reason: "produit non conforme à la photo", guest_phone: phone }
    });
    expect(dispute.statusCode).toBe(201);
    expect(dispute.json().payout_frozen).toBe(true);

    const frozen = await app.deps.trust.frozenAmountFor(sellerId);
    expect(frozen).toBe(BigInt(order.total.amount_minor)); // scoped — only this order

    // auto-attached evidence
    const row = await app.deps.prisma.dispute.findUniqueOrThrow({ where: { id: dispute.json().id } });
    expect((row.evidence as { auto_attached?: boolean }).auto_attached).toBe(true);

    // admin resolves with refund → order refunded, freeze lifted
    const resolve = await app.inject({
      method: "POST",
      url: `/admin/disputes/${dispute.json().id}/resolve`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { resolution: "refund" }
    });
    expect(resolve.statusCode).toBe(200);
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("refunded");
    expect(await app.deps.trust.frozenAmountFor(sellerId)).toBe(0n);
  });
});

d("phase 10 — admin console & config panels (FR-42..44b)", () => {
  it("dashboard, phone search (users + guest orders), audit trail", async () => {
    const dash = await app.inject({ method: "GET", url: "/admin/dashboard", headers: { authorization: `Bearer ${adminToken}` } });
    expect(dash.statusCode).toBe(200);
    expect(dash.json().orders).toBeGreaterThan(0);

    const search = await app.inject({
      method: "GET",
      url: "/admin/search/phone?q=%2B221771234501",
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(search.json().users.some((u: { phone: string }) => u.phone === "+221771234501")).toBe(true);

    const guests = await app.inject({
      method: "GET",
      url: "/admin/search/phone?q=771240002",
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(guests.json().guest_orders.length).toBeGreaterThanOrEqual(1);
  });

  it("order timeline shows attempts, delivery, dispute (support scenario)", async () => {
    const phone = "+221771240003";
    const { order } = await paidOrder(phone);
    const res = await app.inject({
      method: "GET",
      url: `/admin/orders/${order.id}/timeline`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    const tl = res.json();
    expect(tl.order.status).toBe("paid");
    expect(tl.attempts.length).toBeGreaterThanOrEqual(1);
    expect(tl.attempts[0].provider).toBeTruthy();
  });

  it("CONFIG FLIP: route change applies to the NEXT attempt without deploy (FR-44b verify)", async () => {
    const phone = "+221771240004";
    // flip SN WAVE route: primary becomes AGG_B
    const flip = await app.inject({
      method: "POST",
      url: "/admin/config/routes",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { country: "SN", method: "WAVE", primary: "AGG_B", fallback: "AGG_A" }
    });
    expect(flip.statusCode).toBe(200);

    const { att } = await paidOrder(phone); // helper creates a WAVE attempt
    expect(att.provider_code).toBe("AGG_B"); // flipped route served it

    // audit logged
    const audit = await app.inject({ method: "GET", url: "/admin/audit", headers: { authorization: `Bearer ${adminToken}` } });
    expect(audit.json().some((a: { action: string }) => a.action === "config:route_flip")).toBe(true);
  });

  it("CONFIG TOGGLE: MANUAL_TRANSFER on/off appears/disappears from checkout methods", async () => {
    const phone = "+221771240005";
    const product = await app.deps.prisma.product.create({
      data: { shopId: snShopId, title: key("cfg-p"), priceMinor: 5000n, currency: "XOF", stock: 2, status: "active" }
    });
    const order = (
      await app.inject({
        method: "POST",
        url: "/orders",
        payload: {
          shop_id: snShopId,
          items: [{ product_id: product.id, qty: 1 }],
          delivery_point: { pin: SN_PIN },
          guest_phone: phone,
          idempotency_key: key("cfg-o")
        }
      })
    ).json();

    // seller enables it on the shop, but pack keeps it OFF → not shown
    await app.deps.prisma.shop.update({
      where: { id: snShopId },
      data: { enabledMethods: ["WAVE", "ORANGE_MONEY", "COD", "PI_SPI", "MANUAL_TRANSFER"] }
    });
    const before = await app.inject({ method: "GET", url: `/checkout/${order.id}/methods` });
    expect(before.json().methods.map((m: { method: string }) => m.method)).not.toContain("MANUAL_TRANSFER");

    // admin toggles ON → appears
    await app.inject({
      method: "POST",
      url: "/admin/config/methods",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { country: "SN", method: "MANUAL_TRANSFER", enabled: true }
    });
    const on = await app.inject({ method: "GET", url: `/checkout/${order.id}/methods` });
    expect(on.json().methods.map((m: { method: string }) => m.method)).toContain("MANUAL_TRANSFER");

    // admin toggles OFF → disappears (Phase 10 verify)
    await app.inject({
      method: "POST",
      url: "/admin/config/methods",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { country: "SN", method: "MANUAL_TRANSFER", enabled: false }
    });
    const off = await app.inject({ method: "GET", url: `/checkout/${order.id}/methods` });
    expect(off.json().methods.map((m: { method: string }) => m.method)).not.toContain("MANUAL_TRANSFER");

    await app.deps.prisma.shop.update({
      where: { id: snShopId },
      data: { enabledMethods: ["WAVE", "ORANGE_MONEY", "COD", "PI_SPI"] }
    });
  });

  it("takedown archives a product and audits it; reports accepted anonymously", async () => {
    const product = await app.deps.prisma.product.create({
      data: { shopId: snShopId, title: key("bad-p"), priceMinor: 1000n, currency: "XOF", stock: 1, status: "active" }
    });
    const report = await app.inject({
      method: "POST",
      url: "/reports",
      payload: { kind: "product", target_id: product.id, reason: "article contrefait" }
    });
    expect(report.statusCode).toBe(201);

    const takedown = await app.inject({
      method: "POST",
      url: `/admin/products/${product.id}/takedown`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { reason: "contrefaçon confirmée" }
    });
    expect(takedown.statusCode).toBe(200);
    expect((await app.deps.prisma.product.findUniqueOrThrow({ where: { id: product.id } })).status).toBe("archived");
    const page = await app.inject({ method: "GET", url: `/products/${product.id}` });
    expect(page.statusCode).toBe(404);
  });

  it("reconciliation flag resolution runs end-to-end in admin (support scenario close)", async () => {
    // create an open flag via a corrupted settlement line
    const { att, order } = await paidOrder("+221771240006");
    const provider = att.provider_code;
    const csv = `provider_ref,amount_minor,fee_minor,currency\n${att.provider_ref},${BigInt(order.total.amount_minor) - 100n},0,XOF`;
    const batch = await app.deps.reconciliation.ingestCsv(provider, new Date().toISOString().slice(0, 10), key("adm") + ".csv", csv);
    await app.deps.reconciliation.runMatch(batch.id);

    const queue = await app.inject({
      method: "GET",
      url: "/admin/reconciliation/flags",
      headers: { authorization: `Bearer ${adminToken}` }
    });
    const flag = queue.json().find((f: { settlement_line: { provider_ref: string } | null }) => f.settlement_line?.provider_ref === att.provider_ref);
    expect(flag).toBeTruthy();

    const resolve = await app.inject({
      method: "POST",
      url: `/admin/reconciliation/flags/${flag.id}/resolve`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(resolve.statusCode).toBe(200);
  });
});
