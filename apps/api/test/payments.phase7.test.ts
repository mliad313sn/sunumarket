import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MockMessagingProvider } from "../src/lib/messaging.js";

const url = process.env.DATABASE_URL;
const d = describe.skipIf(!url);

let app: Awaited<ReturnType<typeof buildApp>>;
const messaging = new MockMessagingProvider();
let snShopId: string; // chez-awa-mode (SN: WAVE, ORANGE_MONEY, COD, PI_SPI)
let ciShopId: string; // adjoua-beaute (CI)

const SN_PIN = { lat: 14.68, lng: -17.44, landmark: "À côté de la boulangerie Jaune" };
const CI_PIN = { lat: 5.33, lng: -4.0, landmark: "En face de la pharmacie" };

let seq = 0;
function key(prefix: string): string {
  return `${prefix}-${Date.now()}-${seq++}`;
}

async function makeOrder(shopId: string, pin: typeof SN_PIN, phone = "+221771230000") {
  const shop = await app.deps.prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  const product = await app.deps.prisma.product.create({
    data: { shopId, title: `pay-test-${key("p")}`, priceMinor: 10000n, currency: "XOF", stock: 10, status: "active" }
  });
  void shop;
  const res = await app.inject({
    method: "POST",
    url: "/orders",
    payload: {
      shop_id: shopId,
      items: [{ product_id: product.id, qty: 1 }],
      delivery_point: { pin },
      guest_phone: phone,
      idempotency_key: key("order")
    }
  });
  if (res.statusCode !== 201) throw new Error(`order failed: ${res.body}`);
  return res.json() as { id: string; total: { amount_minor: string } };
}

async function attempt(orderId: string, method: string, scenario?: string) {
  return app.inject({
    method: "POST",
    url: `/orders/${orderId}/attempts`,
    payload: {
      method,
      idempotency_key: key("att"),
      ...(scenario ? { mock_scenario: scenario } : {})
    }
  });
}

async function postWebhook(provider: string, rawBody: string, signature: string) {
  return app.inject({
    method: "POST",
    url: `/webhooks/${provider}`,
    headers: { "content-type": "application/json", "x-signature": signature },
    payload: rawBody
  });
}

beforeAll(async () => {
  app = await buildApp({ messaging });
  snShopId = (await app.deps.prisma.shop.findUniqueOrThrow({ where: { slug: "chez-awa-mode" } })).id;
  ciShopId = (await app.deps.prisma.shop.findUniqueOrThrow({ where: { slug: "adjoua-beaute" } })).id;
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  app.deps.mockAggA.forcedScenario = null;
  app.deps.mockAggA.down = false;
  app.deps.mockAggB.forcedScenario = null;
  app.deps.mockAggB.down = false;
  app.deps.packs.clearOverrides();
  app.deps.router.resetBreakers();
});

d("phase 7 — method matrix (FR-13)", () => {
  it("SN checkout shows Wave first; BF pack has no Wave; seller subset applies", async () => {
    const order = await makeOrder(snShopId, SN_PIN);
    const res = await app.inject({ method: "GET", url: `/checkout/${order.id}/methods` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.country).toBe("SN");
    expect(body.methods[0].method).toBe("WAVE");
    // seller subset: chez-awa-mode enables WAVE, ORANGE_MONEY, COD, PI_SPI only
    expect(body.methods.map((m: { method: string }) => m.method)).not.toContain("CARD");
    expect(body.methods.map((m: { method: string }) => m.method)).not.toContain("MANUAL_TRANSFER");
    // USSD methods carry their dial code (DC-14)
    const om = body.methods.find((m: { method: string }) => m.method === "ORANGE_MONEY");
    expect(om.ussd_dial_code).toBe("#144#");
    expect(body.first_payment_guided).toBeDefined(); // DC-2
  });
});

d("phase 7 — webhook confirm, replay, tamper, isolation (DC-8.1, NFR-3)", () => {
  it("WAVE attempt → signed webhook → paid; replay ×5 → single paid, outcome duplicate", async () => {
    const order = await makeOrder(snShopId, SN_PIN);
    const res = await attempt(order.id, "WAVE");
    expect(res.statusCode).toBe(201);
    const att = res.json();
    expect(att.status).toBe("initiated");
    expect(att.provider_code).toBe("AGG_A"); // SN primary
    expect(att.next_action.kind).toBe("redirect");

    const wh = app.deps.mockAggA.buildWebhook({ providerRef: att.provider_ref, kind: "payment_succeeded" });
    const first = await postWebhook("agg_a", wh.rawBody, wh.signature);
    expect(first.statusCode).toBe(200);
    expect(first.json().outcome).toBe("applied");

    for (let i = 0; i < 5; i++) {
      const replay = await postWebhook("agg_a", wh.rawBody, wh.signature);
      expect(replay.json().outcome).toBe("duplicate");
    }
    const orderAfter = await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(orderAfter.status).toBe("paid");
    const events = await app.deps.prisma.webhookEvent.count({
      where: { payload: { path: ["provider_ref"], equals: att.provider_ref } }
    });
    expect(events).toBe(1); // dedupe stored once
  });

  it("tampered signature → 401 + fraud event; cross-provider signature rejected (isolation)", async () => {
    const order = await makeOrder(snShopId, SN_PIN);
    const att = (await attempt(order.id, "WAVE")).json();
    const wh = app.deps.mockAggA.buildWebhook({ providerRef: att.provider_ref, kind: "payment_succeeded" });

    const tampered = await postWebhook("agg_a", wh.rawBody, "deadbeef".repeat(8));
    expect(tampered.statusCode).toBe(401);
    const fraudRows = await app.deps.prisma.fraudEvent.count({ where: { kind: "webhook_signature_invalid" } });
    expect(fraudRows).toBeGreaterThanOrEqual(1);

    // A valid AGG_B signature must NOT authorize an AGG_A webhook (per-provider secrets).
    const crossSigned = app.deps.mockAggB.buildWebhook({ providerRef: att.provider_ref, kind: "payment_succeeded" });
    const cross = await postWebhook("agg_a", crossSigned.rawBody, crossSigned.signature);
    expect(cross.statusCode).toBe(401);

    const orderAfter = await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(orderAfter.status).toBe("payment_pending"); // still unpaid — SMS/screenshot can't fake this
  });
});

d("phase 7 — failover & circuit breaker (golden path 9 part 1)", () => {
  it("primary down mid-checkout → same createAttempt call fails over to AGG_B → paid; breaker opens", async () => {
    app.deps.mockAggA.down = true;
    const order = await makeOrder(snShopId, SN_PIN);
    const res = await attempt(order.id, "WAVE");
    expect(res.statusCode).toBe(201);
    const att = res.json();
    expect(att.provider_code).toBe("AGG_B"); // fallback served it
    expect(att.status).toBe("initiated");

    // Attempt rows record which provider served each try (settlement needs this).
    const wh = app.deps.mockAggB.buildWebhook({ providerRef: att.provider_ref, kind: "payment_succeeded" });
    const ok = await postWebhook("agg_b", wh.rawBody, wh.signature);
    expect(ok.json().outcome).toBe("applied");
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("paid");
  });

  it("breaker opens after repeated failures; next attempts route straight to fallback; half-open probe closes on recovery", async () => {
    app.deps.mockAggA.down = true;
    // burn failures to open the breaker for (AGG_A, ORANGE_MONEY)
    for (let i = 0; i < 3; i++) {
      const o = await makeOrder(snShopId, SN_PIN, `+2217712311${10 + i}`);
      await attempt(o.id, "ORANGE_MONEY");
    }
    expect(app.deps.router.breakerState("AGG_A", "ORANGE_MONEY")).toBe("open");

    // While open, AGG_A is not even called for new attempts.
    const callsBefore = app.deps.mockAggA.initCalls.length;
    const o2 = await makeOrder(snShopId, SN_PIN, "+221771231199");
    const att = (await attempt(o2.id, "ORANGE_MONEY")).json();
    expect(att.provider_code).toBe("AGG_B");
    expect(app.deps.mockAggA.initCalls.length).toBe(callsBefore);
  });

  it("both providers down → 503, order stays reserved, friendly DC-3 message", async () => {
    app.deps.mockAggA.down = true;
    app.deps.mockAggB.down = true;
    const order = await makeOrder(snShopId, SN_PIN, "+221771231200");
    const res = await attempt(order.id, "WAVE");
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toContain("réservée 30 min");
    const after = await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("payment_pending"); // NOT lost (NFR-2)
  });
});

d("phase 7 — USSD confirmation flow (DC-14, Tantie Rokia)", () => {
  it("ussd_pending → confirm webhook → paid, without abandonment", async () => {
    const order = await makeOrder(ciShopId, CI_PIN, "+2250701231201");
    const res = await attempt(order.id, "ORANGE_MONEY");
    const att = res.json();
    expect(att.status).toBe("ussd_pending");
    expect(att.ussd.dial_code).toBe("#144#");
    expect(att.ussd.expires_in_s).toBe(120);
    expect(att.ussd.can_resend).toBe(true);

    // resend restarts the countdown
    const resend = await app.inject({ method: "POST", url: `/attempts/${att.id}/ussd-resend` });
    expect(resend.statusCode).toBe(200);

    const wh = app.deps.mockAggA.buildWebhook({ providerRef: att.provider_ref, kind: "payment_succeeded" });
    await postWebhook("agg_a", wh.rawBody, wh.signature);
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("paid");
  });

  it("ussd timeout → failed with friendly reason; switch-method escape works (retry = golden path 3)", async () => {
    const order = await makeOrder(ciShopId, CI_PIN, "+2250701231202");
    const att = (await attempt(order.id, "ORANGE_MONEY")).json();
    expect(att.status).toBe("ussd_pending");

    // simulate countdown passing
    await app.deps.prisma.paymentAttempt.update({
      where: { id: att.id },
      data: { updatedAt: new Date(Date.now() - 3 * 60 * 1000) }
    });
    const n = await app.deps.payments.sweepUssdTimeouts();
    expect(n).toBeGreaterThanOrEqual(1);
    const failed = await app.deps.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: att.id } });
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("ussd_timeout");

    // switch method on the SAME order: WAVE fail → MTN pay (golden path 3 shape)
    const wave = (await attempt(order.id, "WAVE", "decline")).json();
    expect(wave.status).toBe("failed");
    const mtn = (await attempt(order.id, "MTN_MOMO")).json();
    expect(mtn.status).toBe("ussd_pending");
    expect(mtn.provider_code).toBe("AGG_B"); // CI: MTN primary is AGG_B
    const wh = app.deps.mockAggB.buildWebhook({ providerRef: mtn.provider_ref, kind: "payment_succeeded" });
    await postWebhook("agg_b", wh.rawBody, wh.signature);
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("paid");
  });
});

d("phase 7 — retry, late webhook (ADR-0007), COD", () => {
  it("late webhook after expiry: attempt succeeded_late, auto-refund queued, order stays expired", async () => {
    const order = await makeOrder(snShopId, SN_PIN, "+221771231203");
    const att = (await attempt(order.id, "WAVE")).json();

    await app.deps.prisma.order.update({
      where: { id: order.id },
      data: { paymentExpiresAt: new Date(Date.now() - 1000) }
    });
    await app.deps.orders.expireOverdueOrders();

    const wh = app.deps.mockAggA.buildWebhook({ providerRef: att.provider_ref, kind: "payment_succeeded" });
    const res = await postWebhook("agg_a", wh.rawBody, wh.signature);
    expect(res.json().outcome).toBe("late");

    const after = await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("expired"); // never resurrected
    const attempt2 = await app.deps.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: att.id } });
    expect(attempt2.status).toBe("succeeded_late");
    expect(app.deps.mockAggA.refunds.some((r) => r.providerRef === att.provider_ref)).toBe(true);
    expect(messaging.sent.some((m) => m.body.includes("trop tard"))).toBe(true);
  });

  it("late webhook for a cancelled attempt while order still payable → applied to the order (ADR-0007 exception)", async () => {
    const order = await makeOrder(snShopId, SN_PIN, "+221771231204");
    const first = (await attempt(order.id, "WAVE")).json();
    // buyer switches method — first attempt cancelled
    const second = (await attempt(order.id, "ORANGE_MONEY")).json();
    expect(second.status).toBe("ussd_pending");

    // then the FIRST attempt's money arrives
    const wh = app.deps.mockAggA.buildWebhook({ providerRef: first.provider_ref, kind: "payment_succeeded" });
    const res = await postWebhook("agg_a", wh.rawBody, wh.signature);
    expect(res.json().outcome).toBe("applied");
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("paid");
    // the newer pending attempt got cancelled
    const newer = await app.deps.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: second.id } });
    expect(newer.status).toBe("cancelled");
  });

  it("COD confirms the order for fulfilment (cash settles via rider ledger in phase 9)", async () => {
    const order = await makeOrder(snShopId, SN_PIN, "+221771231205");
    const res = await attempt(order.id, "COD");
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("succeeded");
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("paid");
  });

  it("attempt idempotency: same key returns the same attempt", async () => {
    const order = await makeOrder(snShopId, SN_PIN, "+221771231206");
    const k = key("idem");
    const r1 = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/attempts`,
      payload: { method: "WAVE", idempotency_key: k }
    });
    const r2 = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/attempts`,
      payload: { method: "WAVE", idempotency_key: k }
    });
    expect(r1.json().id).toBe(r2.json().id);
  });
});

d("phase 7 — PI-SPI method (golden path 10 pay leg)", () => {
  it("pay-by-QR from any wallet → instant confirm → paid (DC-6/DC-7)", async () => {
    const order = await makeOrder(snShopId, SN_PIN, "+221771231207");
    const res = await attempt(order.id, "PI_SPI");
    const att = res.json();
    expect(att.provider_code).toBe("PISPI");
    expect(att.next_action.kind).toBe("qr");
    expect(att.next_action.qr_payload).toContain("pispi://");

    const wh = app.deps.mockPiSpi.buildWebhook({ providerRef: att.provider_ref, kind: "payment_succeeded" });
    const ok = await postWebhook("pispi", wh.rawBody, wh.signature);
    expect(ok.json().outcome).toBe("applied");
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("paid");
  });
});

d("phase 7 — MANUAL_TRANSFER hardened (DC-8.2, golden path 4)", () => {
  it("is blocked unless admin-enabled; then unique ref, forged ref rejected, seller balance-check gates paid", async () => {
    const order = await makeOrder(snShopId, SN_PIN, "+221771231208");
    // default OFF
    const blocked = await attempt(order.id, "MANUAL_TRANSFER");
    expect(blocked.statusCode).toBe(400);

    // admin runtime toggle (FR-44b) + seller enables it on the shop
    app.deps.packs.setMethodOverride("SN", "MANUAL_TRANSFER", true);
    await app.deps.prisma.shop.update({
      where: { id: snShopId },
      data: { enabledMethods: { push: "MANUAL_TRANSFER" } }
    });

    const res = await attempt(order.id, "MANUAL_TRANSFER");
    expect(res.statusCode).toBe(201);
    const att = res.json();
    const reference = att.next_action.manual_reference as string;
    expect(reference).toMatch(/^SM-[A-Z0-9]{8}$/);

    // forged reference → rejected + fraud event
    const forged = await app.inject({
      method: "POST",
      url: `/attempts/${att.id}/manual-proof`,
      payload: { reference: "SM-FORGED01" }
    });
    expect(forged.statusCode).toBe(400);
    expect(await app.deps.prisma.fraudEvent.count({ where: { kind: "forged_manual_reference" } })).toBeGreaterThanOrEqual(1);

    // real reference → payment_review (NOT paid — advisory proof only)
    const proof = await app.inject({
      method: "POST",
      url: `/attempts/${att.id}/manual-proof`,
      payload: { reference }
    });
    expect(proof.statusCode).toBe(200);
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("payment_review");

    // seller must confirm actual balance — refusing balance_checked fails
    const seller = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+221771234501" } });
    const sellerToken = app.jwt.sign({ sub: seller.id, roles: seller.roles, tier: 1, device: "t" }, { expiresIn: "5m" });
    const noCheck = await app.inject({
      method: "POST",
      url: `/attempts/${att.id}/seller-confirm`,
      headers: { authorization: `Bearer ${sellerToken}` },
      payload: { balance_checked: false }
    });
    expect(noCheck.statusCode).toBe(409);

    const confirmed = await app.inject({
      method: "POST",
      url: `/attempts/${att.id}/seller-confirm`,
      headers: { authorization: `Bearer ${sellerToken}` },
      payload: { balance_checked: true }
    });
    expect(confirmed.statusCode).toBe(200);
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("paid");

    // restore seed state
    await app.deps.prisma.shop.update({
      where: { id: snShopId },
      data: { enabledMethods: ["WAVE", "ORANGE_MONEY", "COD", "PI_SPI"] }
    });
  });
});
