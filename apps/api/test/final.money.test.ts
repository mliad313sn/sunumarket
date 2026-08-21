import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MockMessagingProvider } from "../src/lib/messaging.js";
import { PayoutError } from "../src/modules/payouts/payouts.service.js";

/**
 * Final money-correctness audit suite (committee fixes 1-9):
 *  1 — dispute refund failure keeps the payout freeze + surfaces a mapped error
 *  2 — refundOrder is idempotent (second call = 200) and reverses the ledger once
 *  3 — concurrent payouts cannot overdraw (advisory-lock serialization)
 *  4 — rail-down payout settles nothing, debits nothing, returns 503
 *  5 — reconciliation ingest + run-match are wired over HTTP (admin-only)
 *  6/7 — KYC decisions, fraud reviews, dispute resolutions and recon flag
 *        resolutions all write append-only audit_log rows with the admin actor
 *  8 — stale webhooks (occurred_at outside the freshness window) are rejected
 *        with a fraud_events row; fresh webhooks still land normally
 */
const url = process.env.DATABASE_URL;
const d = describe.skipIf(!url);

let app: Awaited<ReturnType<typeof buildApp>>;
const messaging = new MockMessagingProvider();

const SN_PIN = { lat: 14.68, lng: -17.44, landmark: "À côté de la boulangerie Jaune" };
let seq = 0;
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const key = (p: string) => `${p}-${run}-${seq++}`;
const uniquePhone = () => `+2217718${String(Math.floor(10000 + Math.random() * 89999))}`;

let adminId: string;
let adminToken: string;
// seller A: order/dispute/refund/webhook/recon scenarios
let sellerAId: string;
let shopAId: string;
// seller B: payout scenarios (isolated ledger balance)
let sellerBId: string;
let shopBId: string;
let sellerBToken: string;
const DEVICE_B = `fm-device-${run}`;

async function paidOrder(phone: string) {
  const product = await app.deps.prisma.product.create({
    data: { shopId: shopAId, title: key("fm-p"), priceMinor: 10000n, currency: "XOF", stock: 5, status: "active" }
  });
  const order = (
    await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        shop_id: shopAId,
        items: [{ product_id: product.id, qty: 1 }],
        delivery_point: { pin: SN_PIN },
        guest_phone: phone,
        idempotency_key: key("fm-o")
      }
    })
  ).json();
  const att = (
    await app.inject({
      method: "POST",
      url: `/orders/${order.id}/attempts`,
      payload: { method: "WAVE", idempotency_key: key("fm-a") }
    })
  ).json();
  const provider = att.provider_code === "AGG_A" ? app.deps.mockAggA : app.deps.mockAggB;
  const wh = provider.buildWebhook({ providerRef: att.provider_ref, kind: "payment_succeeded" });
  const res = await app.inject({
    method: "POST",
    url: `/webhooks/${att.provider_code.toLowerCase()}`,
    headers: { "content-type": "application/json", "x-signature": wh.signature },
    payload: wh.rawBody
  });
  expect(res.statusCode).toBe(200);
  return { order, att, provider } as {
    order: { id: string; total: { amount_minor: string }; tracking_token: string };
    att: { id: string; provider_code: string; provider_ref: string };
    provider: typeof app.deps.mockAggA;
  };
}

async function fundSellerB(amount: bigint) {
  const order = await app.deps.prisma.order.create({
    data: {
      shopId: shopBId,
      status: "paid",
      subtotalMinor: amount,
      deliveryFeeMinor: 0n,
      totalMinor: amount,
      currency: "XOF",
      deliveryPointSnapshot: {},
      idempotencyKey: key("fm-fund"),
      trackingToken: key("fm-track")
    }
  });
  const attempt = await app.deps.prisma.paymentAttempt.create({
    data: {
      orderId: order.id,
      method: "PI_SPI",
      status: "succeeded",
      idempotencyKey: key("fm-fund-att"),
      providerRef: `FMFUND-${randomUUID()}`
    }
  });
  await app.deps.ledger.recordSale({
    orderId: order.id,
    attemptId: attempt.id,
    sellerId: sellerBId,
    country: "SN",
    grossMinor: amount,
    currency: "XOF",
    direct: true
  });
}

beforeAll(async () => {
  app = await buildApp({ messaging });

  const admin = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+221771234504" } });
  adminId = admin.id;
  adminToken = app.jwt.sign({ sub: adminId, roles: admin.roles, tier: 2, device: "t" }, { expiresIn: "20m" });

  // fresh run-unique sellers + shops — never mutate seed shops (chez-awa-mode et al.)
  const awaShop = await app.deps.prisma.shop.findUniqueOrThrow({ where: { slug: "chez-awa-mode" } });
  const sellerA = await app.deps.prisma.user.create({
    data: { phone: uniquePhone(), country: "SN", roles: ["seller"], kycTier: 2 }
  });
  sellerAId = sellerA.id;
  const shopA = await app.deps.prisma.shop.create({
    data: {
      sellerId: sellerAId,
      slug: `fm-shop-a-${run}`,
      name: "Final Money Shop A",
      country: "SN",
      cityId: awaShop.cityId,
      enabledMethods: ["WAVE", "COD", "PI_SPI"]
    }
  });
  shopAId = shopA.id;

  const sellerB = await app.deps.prisma.user.create({
    data: { phone: uniquePhone(), country: "SN", roles: ["seller"], kycTier: 2 }
  });
  sellerBId = sellerB.id;
  const shopB = await app.deps.prisma.shop.create({
    data: {
      sellerId: sellerBId,
      slug: `fm-shop-b-${run}`,
      name: "Final Money Shop B",
      country: "SN",
      cityId: awaShop.cityId,
      enabledMethods: ["WAVE", "COD", "PI_SPI"]
    }
  });
  shopBId = shopB.id;
  sellerBToken = app.jwt.sign({ sub: sellerBId, roles: ["seller"], tier: 2, device: DEVICE_B }, { expiresIn: "20m" });
  await app.deps.prisma.deviceBinding.create({
    data: {
      userId: sellerBId,
      deviceHash: DEVICE_B,
      trusted: true,
      firstSeen: new Date(Date.now() - 48 * 3600 * 1000),
      lastVerified: new Date()
    }
  });
});
afterAll(async () => {
  await app.close();
});

d("fix 1 — dispute refund runs BEFORE the freeze is lifted", () => {
  it("refund failure keeps the dispute open + frozen and answers 502; retry resolves cleanly", async () => {
    const phone = uniquePhone();
    const { order, provider } = await paidOrder(phone);

    const dispute = (
      await app.inject({
        method: "POST",
        url: `/orders/${order.id}/disputes`,
        payload: { reason: "produit défectueux à la réception", guest_phone: phone }
      })
    ).json();
    expect(await app.deps.trust.frozenAmountFor(sellerAId)).toBe(BigInt(order.total.amount_minor));

    const balanceBefore = await app.deps.ledger.balance("seller", sellerAId, "XOF");
    const originalRefund = provider.refund.bind(provider);
    provider.refund = async () => {
      throw new Error("refund rail down");
    };
    try {
      const fail = await app.inject({
        method: "POST",
        url: `/admin/disputes/${dispute.id}/resolve`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { resolution: "refund" }
      });
      expect(fail.statusCode).toBe(502);
      expect(fail.json().code).toBe("refund_failed");
    } finally {
      provider.refund = originalRefund;
    }

    // freeze kept, dispute still open, order NOT refunded, ledger untouched
    const row = await app.deps.prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(row.status).toBe("open");
    expect(row.payoutFrozen).toBe(true);
    expect(await app.deps.trust.frozenAmountFor(sellerAId)).toBe(BigInt(order.total.amount_minor));
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("paid");
    expect(await app.deps.ledger.balance("seller", sellerAId, "XOF")).toBe(balanceBefore);
    const failAudit = await app.deps.prisma.auditLog.findFirst({
      where: { action: "dispute:refund_failed", actorId: adminId },
      orderBy: { at: "desc" }
    });
    expect((failAudit?.detail as { dispute_id?: string }).dispute_id).toBe(dispute.id);

    // provider back up → retry succeeds and only now lifts the freeze
    const ok = await app.inject({
      method: "POST",
      url: `/admin/disputes/${dispute.id}/resolve`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { resolution: "refund" }
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("resolved_refund");
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("refunded");
    expect(await app.deps.trust.frozenAmountFor(sellerAId)).toBe(0n);
    const audit = await app.deps.prisma.auditLog.findFirst({
      where: { action: "dispute:resolve", actorId: adminId },
      orderBy: { at: "desc" }
    });
    expect((audit?.detail as { dispute_id?: string }).dispute_id).toBe(dispute.id);
  });

  it("reject path still works and is audited", async () => {
    const phone = uniquePhone();
    const { order } = await paidOrder(phone);
    const dispute = (
      await app.inject({
        method: "POST",
        url: `/orders/${order.id}/disputes`,
        payload: { reason: "changement d'avis sans motif", guest_phone: phone }
      })
    ).json();
    const res = await app.inject({
      method: "POST",
      url: `/admin/disputes/${dispute.id}/resolve`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { resolution: "reject" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("resolved_reject");
    // order untouched, freeze lifted
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("paid");
    expect(await app.deps.trust.frozenAmountFor(sellerAId)).toBe(0n);
  });
});

d("fix 2 — refund idempotency + provider-first ordering", () => {
  it("second refund call answers 200 without double ledger reversal", async () => {
    const phone = uniquePhone();
    const { order, att } = await paidOrder(phone);
    const balancePaid = await app.deps.ledger.balance("seller", sellerAId, "XOF");

    const r1 = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/refund`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { reason: "accord commercial" }
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ status: "refunded", already_refunded: false });
    const balanceRefunded = await app.deps.ledger.balance("seller", sellerAId, "XOF");
    expect(balanceRefunded).toBeLessThan(balancePaid); // sale net reversed

    const r2 = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/refund`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { reason: "accord commercial" }
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toMatchObject({ status: "refunded", already_refunded: true });
    expect(await app.deps.ledger.balance("seller", sellerAId, "XOF")).toBe(balanceRefunded);

    // exactly one refund transaction reverses the sale
    const attempt = await app.deps.prisma.paymentAttempt.findUniqueOrThrow({
      where: { id: att.id },
      include: { transaction: true }
    });
    const refunds = await app.deps.prisma.ledgerTransaction.findMany({
      where: { kind: "refund", sourceRef: { endsWith: `:${attempt.transaction!.id}` } }
    });
    expect(refunds.length).toBe(1);
  });

  it("provider refund failure leaves the order paid and the ledger untouched (mapped 502)", async () => {
    const phone = uniquePhone();
    const { order, provider } = await paidOrder(phone);
    const before = await app.deps.ledger.balance("seller", sellerAId, "XOF");
    const originalRefund = provider.refund.bind(provider);
    provider.refund = async () => ({ ok: false, reason: "provider maintenance" });
    try {
      const res = await app.inject({
        method: "POST",
        url: `/orders/${order.id}/refund`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { reason: "test provider down" }
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe("refund_failed");
    } finally {
      provider.refund = originalRefund;
    }
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("paid");
    expect(await app.deps.ledger.balance("seller", sellerAId, "XOF")).toBe(before);
  });
});

d("fix 3 — payout double-spend window closed by per-seller advisory lock", () => {
  it("two concurrent payouts that together exceed the balance: one fails, ledger never negative", async () => {
    await fundSellerB(50000n);
    const before = await app.deps.ledger.balance("seller", sellerBId, "XOF");
    expect(before).toBeGreaterThanOrEqual(50000n);
    const amount = (before + 10000n) / 2n; // two of these overdraw by 10 000

    const opts = (k: string) => ({ pin: undefined, deviceHash: DEVICE_B, idempotencyKey: key(k) });
    const results = await Promise.allSettled([
      app.deps.payouts.requestPayout(sellerBId, amount, opts("fm-race-1")),
      app.deps.payouts.requestPayout(sellerBId, amount, opts("fm-race-2"))
    ]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const ko = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(ko.length).toBe(1);
    expect(ko[0]!.reason).toBeInstanceOf(PayoutError);
    expect((ko[0]!.reason as PayoutError).code).toBe("insufficient_balance");

    const after = await app.deps.ledger.balance("seller", sellerBId, "XOF");
    expect(after).toBe(before - amount);
    expect(after).toBeGreaterThanOrEqual(0n);
  });
});

d("fix 4 — rail down: nothing settled, nothing debited, 503", () => {
  it("PI-SPI outage → 503 rail_down, no payout row, ledger untouched", async () => {
    await fundSellerB(20000n);
    const before = await app.deps.ledger.balance("seller", sellerBId, "XOF");
    const payoutsBefore = await app.deps.prisma.payout.count({ where: { sellerId: sellerBId } });

    app.deps.mockPiSpi.down = true;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/payouts",
        headers: { authorization: `Bearer ${sellerBToken}` },
        payload: { amount: { amount_minor: "15000", currency: "XOF" }, idempotency_key: key("fm-rail") }
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("rail_down");
    } finally {
      app.deps.mockPiSpi.down = false;
    }

    expect(await app.deps.ledger.balance("seller", sellerBId, "XOF")).toBe(before);
    expect(await app.deps.prisma.payout.count({ where: { sellerId: sellerBId } })).toBe(payoutsBefore);
  });
});

d("fix 5 — reconciliation wired over HTTP (admin-only)", () => {
  it("ingest + run-match produce matched settlement lines; anonymous is rejected", async () => {
    const { order, att } = await paidOrder(uniquePhone());
    const csv = `provider_ref,amount_minor,fee_minor,currency\n${att.provider_ref},${order.total.amount_minor},150,XOF`;

    const anon = await app.inject({
      method: "POST",
      url: "/admin/reconciliation/ingest",
      payload: { provider_code: att.provider_code, settlement_date: "2026-08-21", source_file: key("fm") + ".csv", csv }
    });
    expect(anon.statusCode).toBe(401);

    const ingest = await app.inject({
      method: "POST",
      url: "/admin/reconciliation/ingest",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        provider_code: att.provider_code,
        settlement_date: new Date().toISOString().slice(0, 10),
        source_file: key("fm-recon") + ".csv",
        csv
      }
    });
    expect(ingest.statusCode).toBe(201);
    const batchId = ingest.json().id;

    const match = await app.inject({
      method: "POST",
      url: "/admin/reconciliation/run-match",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { batch_id: batchId }
    });
    expect(match.statusCode).toBe(200);
    expect(match.json().matched).toBeGreaterThanOrEqual(1);

    const line = await app.deps.prisma.settlementLine.findFirstOrThrow({
      where: { batchId, providerRef: att.provider_ref }
    });
    expect(line.matchKind).not.toBe("unmatched");
    expect(line.matchedTransactionId).toBeTruthy();
  });
});

d("fix 6/7 — admin decisions land in the append-only audit_log", () => {
  it("recon flag resolve requires a reason and records actor + reason", async () => {
    const { order, att } = await paidOrder(uniquePhone());
    // amount mismatch → open flag
    const csv = `provider_ref,amount_minor,fee_minor,currency\n${att.provider_ref},${BigInt(order.total.amount_minor) - 500n},0,XOF`;
    const batch = (
      await app.inject({
        method: "POST",
        url: "/admin/reconciliation/ingest",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          provider_code: att.provider_code,
          settlement_date: new Date().toISOString().slice(0, 10),
          source_file: key("fm-flag") + ".csv",
          csv
        }
      })
    ).json();
    await app.inject({
      method: "POST",
      url: "/admin/reconciliation/run-match",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { batch_id: batch.id }
    });
    const flag = await app.deps.prisma.reconciliationFlag.findFirstOrThrow({
      where: { status: "open", settlementLine: { providerRef: att.provider_ref } }
    });

    const noReason = await app.inject({
      method: "POST",
      url: `/admin/reconciliation/flags/${flag.id}/resolve`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {}
    });
    expect(noReason.statusCode).toBe(400);

    const res = await app.inject({
      method: "POST",
      url: `/admin/reconciliation/flags/${flag.id}/resolve`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { reason: "écart validé avec le fournisseur" }
    });
    expect(res.statusCode).toBe(200);
    const audit = await app.deps.prisma.auditLog.findFirst({
      where: { action: "recon:flag_resolve", actorId: adminId },
      orderBy: { at: "desc" }
    });
    const detail = audit?.detail as { flag_id?: string; reason?: string };
    expect(detail.flag_id).toBe(flag.id);
    expect(detail.reason).toBe("écart validé avec le fournisseur");
  });

  it("KYC decision writes kyc:decision with the admin actor and outcome", async () => {
    const subject = await app.deps.prisma.user.create({
      data: { phone: uniquePhone(), country: "SN", roles: ["seller"], kycTier: 0 }
    });
    const rec = await app.deps.prisma.kycRecord.create({
      data: { userId: subject.id, tier: 1, documents: { id_document: "kyc/fm.jpg" } }
    });
    const res = await app.inject({
      method: "POST",
      url: `/admin/kyc/${rec.id}/decide`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { approve: true }
    });
    expect(res.statusCode).toBe(200);
    expect((await app.deps.prisma.user.findUniqueOrThrow({ where: { id: subject.id } })).kycTier).toBe(1);
    const audit = await app.deps.prisma.auditLog.findFirst({
      where: { action: "kyc:decision", actorId: adminId },
      orderBy: { at: "desc" }
    });
    const detail = audit?.detail as { record_id?: string; user_id?: string; outcome?: string };
    expect(detail.record_id).toBe(rec.id);
    expect(detail.user_id).toBe(subject.id);
    expect(detail.outcome).toBe("approved");
  });

  it("fraud review writes fraud:review with the admin actor and outcome", async () => {
    const marker = key("fm-fraud");
    await app.deps.fraud.record("test_anomaly", { detail: { marker } });
    const event = await app.deps.prisma.fraudEvent.findFirstOrThrow({
      where: { kind: "test_anomaly", detail: { path: ["marker"], equals: marker } }
    });
    const res = await app.inject({
      method: "POST",
      url: `/admin/fraud/${event.id}/review`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: "cleared" }
    });
    expect(res.statusCode).toBe(200);
    const audit = await app.deps.prisma.auditLog.findFirst({
      where: { action: "fraud:review", actorId: adminId },
      orderBy: { at: "desc" }
    });
    const detail = audit?.detail as { event_id?: string; outcome?: string };
    expect(detail.event_id).toBe(event.id);
    expect(detail.outcome).toBe("cleared");
  });
});

d("fix 8 — webhook freshness window (DC-8.1 hardening)", () => {
  it("a signed but stale webhook is rejected 400, flagged, and does not pay the order", async () => {
    const product = await app.deps.prisma.product.create({
      data: { shopId: shopAId, title: key("fm-stale-p"), priceMinor: 8000n, currency: "XOF", stock: 2, status: "active" }
    });
    const order = (
      await app.inject({
        method: "POST",
        url: "/orders",
        payload: {
          shop_id: shopAId,
          items: [{ product_id: product.id, qty: 1 }],
          delivery_point: { pin: SN_PIN },
          guest_phone: uniquePhone(),
          idempotency_key: key("fm-stale-o")
        }
      })
    ).json();
    const att = (
      await app.inject({
        method: "POST",
        url: `/orders/${order.id}/attempts`,
        payload: { method: "WAVE", idempotency_key: key("fm-stale-a") }
      })
    ).json();
    const provider = att.provider_code === "AGG_A" ? app.deps.mockAggA : app.deps.mockAggB;

    const staleEventId = randomUUID();
    const stale = provider.buildWebhook({
      providerRef: att.provider_ref,
      kind: "payment_succeeded",
      eventId: staleEventId,
      occurredAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() // 30 min old > 10 min window
    });
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${att.provider_code.toLowerCase()}`,
      headers: { "content-type": "application/json", "x-signature": stale.signature },
      payload: stale.rawBody
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().outcome).toBe("stale");

    // order NOT paid, attempt untouched, fraud event recorded
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("payment_pending");
    const fraudRow = await app.deps.prisma.fraudEvent.findFirstOrThrow({
      where: { kind: "webhook_stale", detail: { path: ["event_id"], equals: staleEventId } }
    });
    expect(fraudRow).toBeTruthy();

    // a fresh webhook (new event id) still pays the order — DC-8.1 path intact
    const fresh = provider.buildWebhook({ providerRef: att.provider_ref, kind: "payment_succeeded" });
    const ok = await app.inject({
      method: "POST",
      url: `/webhooks/${att.provider_code.toLowerCase()}`,
      headers: { "content-type": "application/json", "x-signature": fresh.signature },
      payload: fresh.rawBody
    });
    expect(ok.statusCode).toBe(200);
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("paid");

    // future-dated beyond skew is rejected too
    const future = provider.buildWebhook({
      providerRef: att.provider_ref,
      kind: "payment_succeeded",
      occurredAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
    });
    const resFuture = await app.inject({
      method: "POST",
      url: `/webhooks/${att.provider_code.toLowerCase()}`,
      headers: { "content-type": "application/json", "x-signature": future.signature },
      payload: future.rawBody
    });
    expect(resFuture.statusCode).toBe(400);
  });
});
