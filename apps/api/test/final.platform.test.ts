import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { buildDeps } from "../src/deps.js";
import { MockMessagingProvider, OutboxMessagingProvider } from "../src/lib/messaging.js";
import { FixedWindowRateLimiter } from "../src/lib/rate-limit.js";
import { assertProductionSecrets } from "../src/lib/secrets.js";
import { MockPartnerAdapter } from "../src/modules/delivery/partner-adapter.js";

/**
 * Committee remediation — pass 2 (final platform review). One block per fix:
 *   1  partner webhook secret isolation (per-partner env-indirection + fraud event)
 *   2  COD remittance idempotency (append-only ledger — replay posts nothing)
 *   3  rider incident → re-dispatch (job back to broadcasting, order recoverable)
 *   4  deterministic rebroadcast event ids (escalation SMS can't double-fire)
 *   5  order-confirmation SMS with the tracking link
 *   6  buyer cancel via tracking token (payment_pending only, restock once)
 *   7  rider earnings visibility (earned_total on GET /rider/cash)
 *   8  production secrets startup assertion
 *   9  per-IP rate limiting (OTP + webhooks)
 *   10 worker heartbeat + deep /health
 *   11 privacy scrub extension (shops, guest_phone, sms bodies, job_events.gps)
 *   13 seller self-service GET /me/shop
 */
const url = process.env.DATABASE_URL;
const d = describe.skipIf(!url);

let app: Awaited<ReturnType<typeof buildApp>>;
const inner = new MockMessagingProvider();

let bfShopId: string;
let bfSellerId: string;
let sellerToken: string;
let sellerPhone: string;

const BF_PIN = { lat: 12.36, lng: -1.51, landmark: "Derrière le marché de Koulouba" };
const runId = Math.floor(1000000 + Math.random() * 9000000);
let seq = 0;
const key = (p: string) => `${p}-${runId}-${Date.now()}-${seq++}`;
const bfPhone = (n: number) => `+22670${(runId + n).toString().slice(-6)}`;
const snPhone = (n: number) => `+22177${(runId + n).toString().slice(-7)}`;

async function makeRider(n: number) {
  const user = await app.deps.prisma.user.create({
    data: { phone: bfPhone(700 + n), country: "BF", roles: ["rider"], kycTier: 2 }
  });
  await app.deps.prisma.rider.create({ data: { userId: user.id, vehicle: "moto", active: true } });
  const token = app.jwt.sign({ sub: user.id, roles: ["rider"], tier: 2, device: "t" }, { expiresIn: "20m" });
  return { id: user.id, token };
}

async function makeCodOrder(phone: string, priceMinor = 20000n) {
  const product = await app.deps.prisma.product.create({
    data: { shopId: bfShopId, title: key("fp-p"), priceMinor, currency: "XOF", stock: 5, status: "active" }
  });
  const orderRes = await app.inject({
    method: "POST",
    url: "/orders",
    payload: {
      shop_id: bfShopId,
      items: [{ product_id: product.id, qty: 1 }],
      delivery_point: { pin: BF_PIN },
      guest_phone: phone,
      idempotency_key: key("fp-o")
    }
  });
  expect(orderRes.statusCode).toBe(201);
  const order = orderRes.json() as { id: string; tracking_token: string; total: { amount_minor: string } };
  await app.inject({
    method: "POST",
    url: `/orders/${order.id}/attempts`,
    payload: { method: "COD", idempotency_key: key("fp-a") }
  });
  return { order, productId: product.id };
}

async function requestRiderJob(orderId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/deliveries",
    headers: { authorization: `Bearer ${sellerToken}` },
    payload: { order_id: orderId, mode: "RIDER" }
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; status: string; fee: { amount_minor: string } };
}

async function riderStatus(jobId: string, token: string, status: string) {
  return app.inject({
    method: "POST",
    url: `/jobs/${jobId}/status`,
    headers: { authorization: `Bearer ${token}` },
    payload: { event_id: randomUUID(), status, gps: { lat: 12.37, lng: -1.52 }, at: new Date().toISOString() }
  });
}

beforeAll(async () => {
  process.env.TEST_PARTNER_B_SECRET = "partner-b-secret-for-tests";
  app = await buildApp({
    messaging: new OutboxMessagingProvider((await import("../src/lib/prisma.js")).getPrisma(), inner)
  });
  const shop = await app.deps.prisma.shop.findUniqueOrThrow({
    where: { slug: "kabore-electronique" },
    include: { seller: true }
  });
  bfShopId = shop.id;
  bfSellerId = shop.sellerId;
  sellerPhone = shop.seller.phone;
  sellerToken = app.jwt.sign({ sub: bfSellerId, roles: ["seller"], tier: 1, device: "t" }, { expiresIn: "20m" });
});

afterAll(async () => {
  delete process.env.TEST_PARTNER_B_SECRET;
  await app.close();
});

d("fix 1 — partner webhook secret isolation", () => {
  it("partner A's secret cannot validate partner B's webhook (fraud event); B's own secret works", async () => {
    const partnerB = await app.deps.prisma.partner.create({
      data: { name: `Partner B ${runId}`, adapter: "MOCK", webhookSecretRef: "TEST_PARTNER_B_SECRET" }
    });

    const { order } = await makeCodOrder(bfPhone(101));
    const jobRes = await app.inject({
      method: "POST",
      url: "/deliveries",
      headers: { authorization: `Bearer ${sellerToken}` },
      payload: { order_id: order.id, mode: "PARTNER" }
    });
    expect(jobRes.statusCode).toBe(201);
    const jobId = (jobRes.json() as { id: string }).id;
    // Route the job to partner B (requestDelivery picks the first partner row).
    await app.deps.prisma.deliveryJob.update({ where: { id: jobId }, data: { partnerId: partnerB.id } });

    // Signed with partner A's (shared dev default) secret → rejected + fraud event.
    const forged = app.deps.mockPartner.buildWebhook({ job_id: jobId, kind: "picked_up" });
    const rejected = await app.inject({
      method: "POST",
      url: `/webhooks/partner/${partnerB.id}`,
      headers: { "content-type": "application/json", "x-signature": forged.signature },
      payload: forged.rawBody
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().outcome).toBe("rejected");
    const fraud = await app.deps.prisma.fraudEvent.findFirst({
      where: { kind: "webhook_signature_invalid", detail: { path: ["partner_id"], equals: partnerB.id } }
    });
    expect(fraud).toBeTruthy();

    // Signed with partner B's own (env-resolved) secret → applied.
    const bSigner = new MockPartnerAdapter("MOCK", "partner-b-secret-for-tests");
    const good = bSigner.buildWebhook({ job_id: jobId, kind: "picked_up" });
    const applied = await app.inject({
      method: "POST",
      url: `/webhooks/partner/${partnerB.id}`,
      headers: { "content-type": "application/json", "x-signature": good.signature },
      payload: good.rawBody
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().outcome).toBe("applied");
    const job = await app.deps.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("picked_up");

    // hygiene: close the partner job so it doesn't linger
    await app.deps.prisma.deliveryJob.update({ where: { id: jobId }, data: { status: "cancelled" } });
    await app.deps.orders.transition(order.id, "cancelled").catch(() => undefined);
  });
});

d("fix 2 — COD remittance idempotency (append-only ledger)", () => {
  it("same idempotency key → one ledger entry, same result returned", async () => {
    const rider = await makeRider(1);
    await app.deps.prisma.riderCashLedger.create({
      data: { riderId: rider.id, orderId: null, amountMinor: 9000n, currency: "XOF", kind: "cod_collected" }
    });
    // direct ledger write → sync the rider COD cache (invariant #3)
    await app.deps.prisma.rider.update({ where: { userId: rider.id }, data: { codOutstandingMinor: 9000n } });

    const idem = key("fp-remit");
    const payload = {
      amount: { amount_minor: "9000", currency: "XOF" },
      rail: "AGENT_DEPOSIT",
      idempotency_key: idem
    };
    const first = await app.inject({
      method: "POST",
      url: "/riders/remittances",
      headers: { authorization: `Bearer ${rider.token}` },
      payload
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().remitted).toBe("9000");
    expect(first.json().outstanding).toBe("0");

    const replay = await app.inject({
      method: "POST",
      url: "/riders/remittances",
      headers: { authorization: `Bearer ${rider.token}` },
      payload
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().remitted).toBe("9000");
    expect(replay.json().outstanding).toBe("0");

    // exactly ONE remittance entry — the replay posted nothing
    const remits = await app.deps.prisma.riderCashLedger.findMany({
      where: { riderId: rider.id, kind: { startsWith: "remitted" } }
    });
    expect(remits).toHaveLength(1);
    expect(remits[0]!.idempotencyKey).toBe(idem);
    expect(await app.deps.delivery.codOutstanding(rider.id)).toBe(0n);
  });
});

d("fix 3 + fix 7 — incident re-dispatch and rider earnings", () => {
  let rider2: { id: string; token: string };
  let jobFee = 0n;

  it("incident releases the job to broadcasting, notifies the seller; a second rider delivers", async () => {
    const rider1 = await makeRider(2);
    rider2 = await makeRider(3);
    const phone = bfPhone(102);
    const { order } = await makeCodOrder(phone);
    const job = await requestRiderJob(order.id);
    jobFee = BigInt(job.fee.amount_minor);

    const acc1 = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/accept`,
      headers: { authorization: `Bearer ${rider1.token}` }
    });
    expect(acc1.statusCode).toBe(200);
    await riderStatus(job.id, rider1.token, "picked_up");
    await riderStatus(job.id, rider1.token, "en_route");

    const sellerSmsBefore = inner.sent.filter((m) => m.phone === sellerPhone).length;
    const incident = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/incident`,
      headers: { authorization: `Bearer ${rider1.token}` },
      payload: { reason: "panne de moto en route" }
    });
    expect(incident.statusCode).toBe(200);
    expect(incident.json().status).toBe("broadcasting");
    expect(incident.json().rider_id).toBeNull();

    // order mirrors delivery_issue; seller got the re-dispatch SMS (outbox-persisted)
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("delivery_issue");
    expect(inner.sent.filter((m) => m.phone === sellerPhone).length).toBe(sellerSmsBefore + 1);
    expect(inner.lastTo(sellerPhone)!.body).toContain("nouvelle recherche de livreur");
    const outboxRow = await app.deps.prisma.smsOutbox.findFirst({
      where: { phone: sellerPhone, body: { contains: "nouvelle recherche" } }
    });
    expect(outboxRow).toBeTruthy();

    // a second rider accepts and completes — the order recovers to delivered
    const acc2 = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/accept`,
      headers: { authorization: `Bearer ${rider2.token}` }
    });
    expect(acc2.statusCode).toBe(200);
    await riderStatus(job.id, rider2.token, "picked_up");
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("in_delivery");
    await riderStatus(job.id, rider2.token, "en_route");
    await riderStatus(job.id, rider2.token, "arrived");

    const otp = inner.lastTo(phone)!.body.match(/code de réception (\d{4})/)![1]!;
    const proof = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/proof`,
      headers: { authorization: `Bearer ${rider2.token}` },
      payload: { kind: "otp", code: otp }
    });
    expect(proof.statusCode).toBe(200);
    expect(proof.json().status).toBe("delivered");
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("delivered");
  });

  it("GET /rider/cash exposes earned_total (Σ fees of delivered jobs, minor units)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rider/cash",
      headers: { authorization: `Bearer ${rider2.token}` }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.earned_total).toEqual({ amount_minor: jobFee.toString(), currency: "XOF" });
    // existing shape intact (rider PWA reads outstanding + entries)
    expect(body.outstanding.currency).toBe("XOF");
    expect(Array.isArray(body.entries)).toBe(true);

    // hygiene: remit rider2's COD so nothing outstanding lingers (cache synced)
    const outstanding = await app.deps.delivery.codOutstanding(rider2.id);
    if (outstanding > 0n) {
      await app.deps.prisma.riderCashLedger.create({
        data: { riderId: rider2.id, amountMinor: -outstanding, currency: "XOF", kind: "remitted_agent" }
      });
      await app.deps.prisma.rider.update({ where: { userId: rider2.id }, data: { codOutstandingMinor: 0n } });
    }
  });
});

d("fix 4 — deterministic rebroadcast event ids", () => {
  it("sweep replays never duplicate a round or double-fire the escalation SMS", async () => {
    const prisma = app.deps.prisma;
    // leftover broadcasting jobs from prior runs would pollute seller SMS counts
    await prisma.deliveryJob.updateMany({ where: { status: "broadcasting" }, data: { status: "cancelled" } });

    const { order } = await makeCodOrder(bfPhone(103));
    const job = await requestRiderJob(order.id); // broadcasting, nobody accepts

    const age = () =>
      prisma.deliveryJob.update({
        where: { id: job.id },
        data: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) }
      });

    // round 1
    await age();
    await app.deps.delivery.rebroadcastStale();
    let events = await prisma.jobEvent.findMany({ where: { jobId: job.id, status: "rebroadcast" } });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventId).toBe("rebroadcast-1");

    // immediate re-run: the staleness bump committed atomically with the event → no-op
    await app.deps.delivery.rebroadcastStale();
    events = await prisma.jobEvent.findMany({ where: { jobId: job.id, status: "rebroadcast" } });
    expect(events).toHaveLength(1);

    // concurrent-instance replay: round 2's event id already exists → P2002 skip,
    // no second event, NO escalation SMS, job still de-staled
    await prisma.jobEvent.create({
      data: { jobId: job.id, eventId: "rebroadcast-2", status: "rebroadcast_shadow", at: new Date() }
    });
    await age();
    const sellerSmsBefore = inner.sent.filter((m) => m.phone === sellerPhone).length;
    await app.deps.delivery.rebroadcastStale();
    events = await prisma.jobEvent.findMany({ where: { jobId: job.id, status: "rebroadcast" } });
    expect(events).toHaveLength(1);
    expect(inner.sent.filter((m) => m.phone === sellerPhone).length).toBe(sellerSmsBefore);
    const fresh = await prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(Date.now() - fresh.updatedAt.getTime()).toBeLessThan(60_000);

    await prisma.deliveryJob.update({ where: { id: job.id }, data: { status: "cancelled" } });
  });
});

d("fix 5 — order-confirmation SMS with tracking link", () => {
  it("order creation queues an SMS containing the tracking token (sms_outbox)", async () => {
    const phone = bfPhone(104);
    const { order } = await makeCodOrder(phone);
    const rows = await app.deps.prisma.smsOutbox.findMany({ where: { phone } });
    const confirm = rows.find((r) => r.body.includes(order.tracking_token));
    expect(confirm).toBeTruthy();
    expect(confirm!.body).toContain("/#/track/");
    expect(confirm!.body).toContain("commande reçue");
    // the gateway got it too
    expect(inner.sent.some((m) => m.phone === phone && m.body.includes(order.tracking_token))).toBe(true);
  });
});

d("fix 6 — buyer cancel via tracking token", () => {
  it("cancels a payment_pending order, restores stock exactly once, then 409s", async () => {
    const phone = bfPhone(105);
    const product = await app.deps.prisma.product.create({
      data: { shopId: bfShopId, title: key("fp-c"), priceMinor: 5000n, currency: "XOF", stock: 3, status: "active" }
    });
    const orderRes = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        shop_id: bfShopId,
        items: [{ product_id: product.id, qty: 2 }],
        delivery_point: { pin: BF_PIN },
        guest_phone: phone,
        idempotency_key: key("fp-co")
      }
    });
    const order = orderRes.json() as { id: string; tracking_token: string };
    expect((await app.deps.prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(1);

    const cancel = await app.inject({ method: "POST", url: `/track/${order.tracking_token}/cancel` });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe("cancelled");
    expect((await app.deps.prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(3);

    // replay → 409, stock untouched (restore-once guard)
    const again = await app.inject({ method: "POST", url: `/track/${order.tracking_token}/cancel` });
    expect(again.statusCode).toBe(409);
    expect((await app.deps.prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(3);
  });

  it("refuses to cancel a paid order (refunds are admin/seller flows)", async () => {
    const { order, productId } = await makeCodOrder(bfPhone(106)); // COD attempt → paid
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("paid");
    const res = await app.inject({ method: "POST", url: `/track/${order.tracking_token}/cancel` });
    expect(res.statusCode).toBe(409);
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("paid");
    expect((await app.deps.prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock).toBe(4);
    // unknown token → 404
    expect((await app.inject({ method: "POST", url: "/track/nope/cancel" })).statusCode).toBe(404);
  });
});

d("fix 8 — production secrets assertion", () => {
  const NAMES = [
    "JWT_SECRET",
    "MOCK_AGG_A_SECRET",
    "MOCK_AGG_B_SECRET",
    "MOCK_PISPI_SECRET",
    "PARTNER_DIALOG_WEBHOOK_SECRET"
  ];

  it("buildDeps/buildApp throw in production when secrets are unset or dev defaults", async () => {
    const saved: Record<string, string | undefined> = {};
    for (const n of NAMES) {
      saved[n] = process.env[n];
      delete process.env[n];
    }
    const prevNode = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => buildDeps({ prisma: app.deps.prisma })).toThrow(/JWT_SECRET/);
      expect(() => buildDeps({ prisma: app.deps.prisma })).toThrow(/PARTNER_DIALOG_WEBHOOK_SECRET/);
      await expect(buildApp()).rejects.toThrow(/MOCK_AGG_A_SECRET/);

      // still-default value is as bad as unset
      process.env.JWT_SECRET = "dev-secret-change-me";
      expect(() => buildDeps({ prisma: app.deps.prisma })).toThrow(/JWT_SECRET/);

      // all real → no throw
      const ok: NodeJS.ProcessEnv = { NODE_ENV: "production" };
      for (const n of NAMES) ok[n] = `real-${n.toLowerCase()}`;
      expect(() => assertProductionSecrets(ok)).not.toThrow();
    } finally {
      if (prevNode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNode;
      for (const n of NAMES) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
    }
  });

  it("non-production keeps the dev defaults working", () => {
    expect(() => assertProductionSecrets({ NODE_ENV: "test" })).not.toThrow();
    expect(() => assertProductionSecrets({})).not.toThrow();
  });
});

d("fix 9 — per-IP rate limiting", () => {
  it("fixed window resets with the injected clock", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(2, 60_000, () => now);
    expect(limiter.allow("ip")).toBe(true);
    expect(limiter.allow("ip")).toBe(true);
    expect(limiter.allow("ip")).toBe(false);
    now = 60_001; // next window
    expect(limiter.allow("ip")).toBe(true);
  });

  it("OTP + webhook endpoints answer 429 past the per-IP window", async () => {
    const tight = await buildApp({
      messaging: inner,
      rateLimits: {
        otp: new FixedWindowRateLimiter(2, 60_000),
        webhooks: new FixedWindowRateLimiter(2, 60_000)
      }
    });
    try {
      // per-IP OTP limit (distinct phones — the per-phone throttle is separate)
      for (let i = 0; i < 2; i++) {
        const r = await tight.inject({
          method: "POST",
          url: "/auth/otp",
          payload: { phone: snPhone(300 + i), country: "SN", device_hash: `rl-${runId}-${i}` }
        });
        expect(r.statusCode).toBe(200);
      }
      const blocked = await tight.inject({
        method: "POST",
        url: "/auth/otp",
        payload: { phone: snPhone(310), country: "SN", device_hash: `rl-${runId}-x` }
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().code).toBe("rate_limited");
      expect(blocked.json().message).toContain("Trop de requêtes");

      // webhooks share their own window
      for (let i = 0; i < 2; i++) {
        const r = await tight.inject({
          method: "POST",
          url: "/webhooks/agg_a",
          headers: { "content-type": "application/json", "x-signature": "bad" },
          payload: "{}"
        });
        expect(r.statusCode).toBe(401); // bad signature, but not rate-limited yet
      }
      const rlWebhook = await tight.inject({
        method: "POST",
        url: "/webhooks/agg_a",
        headers: { "content-type": "application/json", "x-signature": "bad" },
        payload: "{}"
      });
      expect(rlWebhook.statusCode).toBe(429);
    } finally {
      await tight.close();
    }
  });
});

d("fix 10 — worker heartbeat + deep /health", () => {
  it("reports db ok and the worker stale flag flips after a heartbeat", async () => {
    const prisma = app.deps.prisma;
    await prisma.workerHeartbeat.deleteMany({});

    let res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    let body = res.json();
    expect(body.db).toBe("ok");
    expect(body.worker.stale).toBe(true);
    expect(body.worker.last_beat_at).toBeNull();

    // an old beat is still stale (3× the sweep interval)
    await prisma.workerHeartbeat.create({
      data: { id: "fast", beatAt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    });
    res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json().worker.stale).toBe(true);

    // a fresh beat (as the worker's sweep tick would write) flips it
    await prisma.workerHeartbeat.upsert({
      where: { id: "fast" },
      update: { beatAt: new Date() },
      create: { id: "fast", beatAt: new Date() }
    });
    res = await app.inject({ method: "GET", url: "/health" });
    body = res.json();
    expect(body.worker.stale).toBe(false);
    expect(typeof body.worker.last_beat_at).toBe("string");
  });
});

d("fix 11 — privacy scrub extension + GPS retention", () => {
  it("anonymization tombstones shop name/whatsapp, guest_phone and SMS bodies", async () => {
    const prisma = app.deps.prisma;
    const phone = snPhone(400);
    const device = `priv-${runId}`;

    await app.inject({ method: "POST", url: "/auth/otp", payload: { phone, country: "SN", device_hash: device } });
    const code = inner.lastTo(phone)!.body.match(/code est (\d{6})/)![1]!;
    const verify = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { phone, code, device_hash: device }
    });
    expect(verify.statusCode).toBe(200);
    const access = verify.json().access_token as string;
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });

    // own shop with PII
    const dakar = await prisma.city.findFirstOrThrow({ where: { country: "SN" } });
    const shopRes = await app.inject({
      method: "POST",
      url: "/shops",
      headers: { authorization: `Bearer ${access}` },
      payload: { name: `Boutique Priv ${runId}`, country: "SN", city_id: dakar.id, whatsapp_phone: phone }
    });
    expect(shopRes.statusCode).toBe(201);
    const shopId = (shopRes.json() as { id: string }).id;

    // a terminal guest order placed with the same phone (on a seed shop) —
    // "cancelled" so no succeeded payment attempt is required (invariant #7)
    const guestOrder = await prisma.order.create({
      data: {
        shopId: bfShopId,
        guestPhone: phone,
        status: "cancelled",
        stockRestored: true,
        subtotalMinor: 1000n,
        deliveryFeeMinor: 0n,
        totalMinor: 1000n,
        currency: "XOF",
        deliveryPointSnapshot: { lat: 14.7, lng: -17.4, landmark: "chez moi" },
        idempotencyKey: key("fp-priv"),
        trackingToken: key("fp-ptk")
      }
    });

    const del = await app.inject({ method: "DELETE", url: "/me", headers: { authorization: `Bearer ${access}` } });
    expect(del.statusCode).toBe(200);

    const tombstone = `deleted:${user.id}`;
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    expect(shop.name).toBe("[boutique supprimée]");
    expect(shop.whatsappPhone).toBeNull();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: guestOrder.id } });
    expect(order.guestPhone).toBe(tombstone);

    expect(await prisma.smsOutbox.count({ where: { phone } })).toBe(0);
    const smsRows = await prisma.smsOutbox.findMany({ where: { phone: tombstone } });
    expect(smsRows.length).toBeGreaterThanOrEqual(1); // at least the OTP SMS
    expect(smsRows.every((r) => r.body === "[supprimé]")).toBe(true);
  });

  it("retention sweep NULLs job_events.gps older than the window, keeps recent ones", async () => {
    const prisma = app.deps.prisma;
    // any job will do as the FK anchor
    const job = await prisma.deliveryJob.findFirstOrThrow();
    const oldId = key("fp-gps-old");
    const newId = key("fp-gps-new");
    await prisma.$executeRaw`
      INSERT INTO job_events (id, job_id, event_id, status, gps, at)
      VALUES (gen_random_uuid(), ${job.id}::uuid, ${oldId}, 'en_route',
              ST_SetSRID(ST_MakePoint(-1.52, 12.37), 4326), now() - interval '200 days')`;
    await prisma.$executeRaw`
      INSERT INTO job_events (id, job_id, event_id, status, gps, at)
      VALUES (gen_random_uuid(), ${job.id}::uuid, ${newId}, 'en_route',
              ST_SetSRID(ST_MakePoint(-1.52, 12.37), 4326), now())`;

    await app.deps.geo.runRetentionTruncation();
    const rows = await prisma.$queryRaw<Array<{ event_id: string; has_gps: boolean }>>`
      SELECT event_id, gps IS NOT NULL AS has_gps FROM job_events WHERE event_id IN (${oldId}, ${newId})`;
    expect(rows.find((r) => r.event_id === oldId)!.has_gps).toBe(false);
    expect(rows.find((r) => r.event_id === newId)!.has_gps).toBe(true);

    // idempotent — a second sweep changes nothing
    await app.deps.geo.runRetentionTruncation();
    const again = await prisma.$queryRaw<Array<{ has_gps: boolean }>>`
      SELECT gps IS NOT NULL AS has_gps FROM job_events WHERE event_id = ${newId}`;
    expect(again[0]!.has_gps).toBe(true);
  });
});

d("fix 13 — seller self-service GET /me/shop", () => {
  it("returns the caller's shop with ALL products (drafts included); 404 without one", async () => {
    // give the seed BF shop a draft product — /me/shop must include it
    const draft = await app.deps.prisma.product.create({
      data: { shopId: bfShopId, title: key("fp-draft"), priceMinor: 100n, currency: "XOF", stock: 0, status: "draft" }
    });
    const res = await app.inject({
      method: "GET",
      url: "/me/shop",
      headers: { authorization: `Bearer ${sellerToken}` }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.slug).toBe("kabore-electronique");
    expect(Array.isArray(body.enabled_methods)).toBe(true);
    const mine = (body.products as Array<{ id: string; status: string; stock: number }>).find((p) => p.id === draft.id);
    expect(mine).toBeTruthy();
    expect(mine!.status).toBe("draft");

    // seller-role user without a shop → 404
    const lonely = await app.deps.prisma.user.create({
      data: { phone: snPhone(500), country: "SN", roles: ["seller"] }
    });
    const lonelyToken = app.jwt.sign({ sub: lonely.id, roles: ["seller"], tier: 0, device: "t" }, { expiresIn: "5m" });
    const notFound = await app.inject({
      method: "GET",
      url: "/me/shop",
      headers: { authorization: `Bearer ${lonelyToken}` }
    });
    expect(notFound.statusCode).toBe(404);

    // unauthenticated → 401
    expect((await app.inject({ method: "GET", url: "/me/shop" })).statusCode).toBe(401);
  });
});
