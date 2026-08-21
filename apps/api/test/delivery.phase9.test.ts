import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MockMessagingProvider } from "../src/lib/messaging.js";

const url = process.env.DATABASE_URL;
const d = describe.skipIf(!url);

let app: Awaited<ReturnType<typeof buildApp>>;
const messaging = new MockMessagingProvider();
let bfShopId: string;
let sellerToken: string;
let moussaId: string;
let riderToken: string;

const BF_PIN = { lat: 12.36, lng: -1.51, landmark: "Derrière le marché de Koulouba" };
let seq = 0;
const key = (p: string) => `${p}-${Date.now()}-${seq++}`;

async function codPaidOrder(phone = "+22670129000") {
  const product = await app.deps.prisma.product.create({
    data: { shopId: bfShopId, title: key("del-p"), priceMinor: 20000n, currency: "XOF", stock: 5, status: "active" }
  });
  const order = (
    await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        shop_id: bfShopId,
        items: [{ product_id: product.id, qty: 1 }],
        delivery_point: { pin: BF_PIN },
        guest_phone: phone,
        idempotency_key: key("del-o")
      }
    })
  ).json();
  await app.inject({
    method: "POST",
    url: `/orders/${order.id}/attempts`,
    payload: { method: "COD", idempotency_key: key("del-a") }
  });
  return order as { id: string; total: { amount_minor: string } };
}

async function requestRiderDelivery(orderId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/deliveries",
    headers: { authorization: `Bearer ${sellerToken}` },
    payload: { order_id: orderId, mode: "RIDER" }
  });
  if (res.statusCode !== 201) throw new Error(`delivery failed: ${res.body}`);
  return res.json() as { id: string };
}

async function riderStatus(jobId: string, status: string, eventId = randomUUID()) {
  return app.inject({
    method: "POST",
    url: `/jobs/${jobId}/status`,
    headers: { authorization: `Bearer ${riderToken}` },
    payload: { event_id: eventId, status, gps: { lat: 12.37, lng: -1.52 }, at: new Date().toISOString() }
  });
}

function proofCodeFor(phone: string): string {
  const sms = messaging.lastTo(phone);
  const m = sms?.body.match(/code de réception (\d{4})/);
  if (!m) throw new Error("no proof SMS");
  return m[1]!;
}

beforeAll(async () => {
  app = await buildApp({ messaging });
  const shop = await app.deps.prisma.shop.findUniqueOrThrow({ where: { slug: "kabore-electronique" } });
  bfShopId = shop.id;
  const seller = await app.deps.prisma.user.findUniqueOrThrow({ where: { id: shop.sellerId } });
  sellerToken = app.jwt.sign({ sub: seller.id, roles: seller.roles, tier: 1, device: "t" }, { expiresIn: "20m" });
  const moussa = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+22670123503" } });
  moussaId = moussa.id;
  riderToken = app.jwt.sign({ sub: moussaId, roles: moussa.roles, tier: 2, device: "t" }, { expiresIn: "20m" });
  // The ledger is append-only (cannot be wiped): zero Moussa's outstanding via a
  // legitimate agent-deposit remittance so the BF COD cap doesn't trip across runs.
  const outstanding = await app.deps.delivery.codOutstanding(moussaId);
  if (outstanding > 0n) {
    await app.deps.prisma.riderCashLedger.create({
      data: { riderId: moussaId, amountMinor: -outstanding, currency: "XOF", kind: "remitted_agent" }
    });
  }
});
afterAll(async () => {
  await app.close();
});

d("phase 9 — dispatch broadcast & first-accept race", () => {
  it("RIDER request broadcasts offers; 20 parallel accepts → exactly one winner", async () => {
    // spin up 19 extra riders
    const riderIds: string[] = [moussaId];
    for (let i = 0; i < 19; i++) {
      const phone = `+226${randomUUID().replace(/\D/g, "").padEnd(8, "7").slice(0, 8)}`;
      const u = await app.deps.prisma.user.upsert({
        where: { phone },
        update: { roles: ["rider"], kycTier: 2 },
        create: { phone, country: "BF", roles: ["rider"], kycTier: 2 }
      });
      await app.deps.prisma.rider.upsert({
        where: { userId: u.id },
        update: { active: true },
        create: { userId: u.id, vehicle: "moto", active: true }
      });
      riderIds.push(u.id);
    }
    const order = await codPaidOrder();
    const job = await requestRiderDelivery(order.id);

    const offers = await app.deps.prisma.dispatchOffer.count({ where: { jobId: job.id } });
    expect(offers).toBeGreaterThanOrEqual(20);

    const results = await Promise.all(
      riderIds.map((rid) => {
        const token = app.jwt.sign({ sub: rid, roles: ["rider"], tier: 2, device: "t" }, { expiresIn: "5m" });
        return app.inject({ method: "POST", url: `/jobs/${job.id}/accept`, headers: { authorization: `Bearer ${token}` } });
      })
    );
    const winners = results.filter((r) => r.statusCode === 200);
    expect(winners).toHaveLength(1);
    // every loser is refused (409 race_lost; 403 possible if a rider is at their COD cap)
    expect(results.filter((r) => r.statusCode !== 200)).toHaveLength(19);

    const jobAfter = await app.deps.prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(jobAfter.status).toBe("accepted");
    expect(jobAfter.riderId).toBeTruthy();
    // losers' offers expired
    const expired = await app.deps.prisma.dispatchOffer.count({ where: { jobId: job.id, response: "expired" } });
    expect(expired).toBeGreaterThanOrEqual(19);
    // cleanup extra riders (keep moussa): deactivate so later broadcasts stay focused
    await app.deps.prisma.rider.updateMany({ where: { userId: { notIn: [moussaId] } }, data: { active: false } });
  });

  it("timeout re-broadcast sweep re-offers stale broadcasting jobs", async () => {
    const order = await codPaidOrder("+22670129001");
    const job = await requestRiderDelivery(order.id);
    await app.deps.prisma.deliveryJob.update({
      where: { id: job.id },
      data: { updatedAt: new Date(Date.now() - 5 * 60 * 1000) }
    });
    const n = await app.deps.delivery.rebroadcastStale();
    expect(n).toBeGreaterThanOrEqual(1);
    // cancel to keep state clean
    await app.deps.prisma.deliveryJob.update({ where: { id: job.id }, data: { status: "cancelled" } });
  });
});

d("phase 9 — rider COD full cycle (golden path 5)", () => {
  it("accept → picked_up → en_route → arrived → OTP proof → delivered; COD posts to cash ledger; order delivered", async () => {
    const phone = "+22670129002";
    const outstandingBefore = await app.deps.delivery.codOutstanding(moussaId);
    const order = await codPaidOrder(phone);
    const job = await requestRiderDelivery(order.id);

    const accept = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/accept`,
      headers: { authorization: `Bearer ${riderToken}` }
    });
    expect(accept.statusCode).toBe(200);

    expect((await riderStatus(job.id, "picked_up")).statusCode).toBe(200);
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("in_delivery");
    expect((await riderStatus(job.id, "en_route")).statusCode).toBe(200);
    expect((await riderStatus(job.id, "arrived")).statusCode).toBe(200);

    // premature delivered without proof is refused
    const noProof = await riderStatus(job.id, "delivered");
    expect(noProof.statusCode).toBe(400);

    // wrong OTP refused
    const bad = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/proof`,
      headers: { authorization: `Bearer ${riderToken}` },
      payload: { kind: "otp", code: "0000" }
    });
    expect([400, 200]).toContain(bad.statusCode); // 1-in-10000 the random code IS 0000

    const good = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/proof`,
      headers: { authorization: `Bearer ${riderToken}` },
      payload: { kind: "otp", code: proofCodeFor(phone) }
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().status).toBe("delivered");
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("delivered");

    const outstandingAfter = await app.deps.delivery.codOutstanding(moussaId);
    expect(outstandingAfter - outstandingBefore).toBe(20750n); // total incl. delivery fee 750 (BF zone 1)
  });

  it("offline sync is idempotent: replaying the same events changes nothing (golden path 8 rider leg)", async () => {
    const phone = "+22670129003";
    const order = await codPaidOrder(phone);
    const job = await requestRiderDelivery(order.id);
    await app.inject({ method: "POST", url: `/jobs/${job.id}/accept`, headers: { authorization: `Bearer ${riderToken}` } });

    const ev1 = randomUUID();
    const ev2 = randomUUID();
    await riderStatus(job.id, "picked_up", ev1);
    await riderStatus(job.id, "en_route", ev2);
    // offline queue re-sync: same events again, plus out-of-order duplicate
    const r1 = await riderStatus(job.id, "picked_up", ev1);
    expect(r1.json().duplicate).toBe(true);
    const r2 = await riderStatus(job.id, "en_route", ev2);
    expect(r2.json().duplicate).toBe(true);

    const jobAfter = await app.deps.prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(jobAfter.status).toBe("en_route");
    const events = await app.deps.prisma.jobEvent.count({ where: { jobId: job.id } });
    expect(events).toBe(2); // no duplicates stored

    await app.deps.prisma.deliveryJob.update({ where: { id: job.id }, data: { status: "cancelled" } });
  });

  it("COD remittance via PI-SPI reduces outstanding; over-remit refused; invariant Σ=collected−remitted (FR-34b)", async () => {
    const outstanding = await app.deps.delivery.codOutstanding(moussaId);
    expect(outstanding).toBeGreaterThan(0n);

    const over = await app.inject({
      method: "POST",
      url: "/riders/remittances",
      headers: { authorization: `Bearer ${riderToken}` },
      payload: {
        amount: { amount_minor: (outstanding + 1n).toString(), currency: "XOF" },
        rail: "PI_SPI",
        idempotency_key: key("rem")
      }
    });
    expect(over.statusCode).toBe(409);

    const remit = await app.inject({
      method: "POST",
      url: "/riders/remittances",
      headers: { authorization: `Bearer ${riderToken}` },
      payload: {
        amount: { amount_minor: outstanding.toString(), currency: "XOF" },
        rail: "PI_SPI",
        idempotency_key: key("rem")
      }
    });
    expect(remit.statusCode).toBe(200);
    expect(app.deps.mockPiSpi.transfers.some((t) => t.alias === `rider:${moussaId}` && t.kind === "remittance")).toBe(true);
    expect(await app.deps.delivery.codOutstanding(moussaId)).toBe(0n);

    // invariant from the append-only ledger directly
    const rows = await app.deps.prisma.riderCashLedger.findMany({ where: { riderId: moussaId } });
    const collected = rows.filter((r) => r.kind === "cod_collected").reduce((s, r) => s + r.amountMinor, 0n);
    const remitted = rows.filter((r) => r.kind.startsWith("remitted")).reduce((s, r) => s + -r.amountMinor, 0n);
    expect(collected - remitted).toBe(0n);
  });
});

d("phase 9 — incidents & partner flow (golden paths 6-7)", () => {
  it("failed_attempt marks order delivery_issue; refund closes it (golden path 7)", async () => {
    const phone = "+22670129004";
    const order = await codPaidOrder(phone);
    const job = await requestRiderDelivery(order.id);
    await app.inject({ method: "POST", url: `/jobs/${job.id}/accept`, headers: { authorization: `Bearer ${riderToken}` } });
    await riderStatus(job.id, "picked_up");
    await riderStatus(job.id, "en_route");

    const incident = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/incident`,
      headers: { authorization: `Bearer ${riderToken}` },
      payload: { reason: "client injoignable au point GPS" }
    });
    expect(incident.statusCode).toBe(200);
    // Pass-2 fix 3: the incident no longer orphans the job — it goes straight
    // back to broadcasting with the rider released (re-dispatch).
    expect(incident.json().status).toBe("broadcasting");
    expect(incident.json().rider_id).toBeNull();
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("delivery_issue");

    // order refund path (COD → no provider refund; state machine to refunded)
    await app.deps.orders.transition(order.id, "refunded");
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("refunded");
    // close the re-dispatched job too (seller would cancel after the refund)
    await app.deps.prisma.deliveryJob.update({ where: { id: job.id }, data: { status: "cancelled" } });
  });

  it("PARTNER delivery: adapter accepts, signed webhooks advance the job, replay is deduped, tamper rejected (golden path 6)", async () => {
    const phone = "+22670129005";
    const order = await codPaidOrder(phone);
    const res = await app.inject({
      method: "POST",
      url: "/deliveries",
      headers: { authorization: `Bearer ${sellerToken}` },
      payload: { order_id: order.id, mode: "PARTNER" }
    });
    expect(res.statusCode).toBe(201);
    const job = res.json();
    expect(job.status).toBe("accepted");
    expect(app.deps.mockPartner.requests.some((r) => r.jobId === job.id)).toBe(true);

    const partner = await app.deps.prisma.partner.findFirstOrThrow();

    // tampered webhook rejected
    const wh1 = app.deps.mockPartner.buildWebhook({ job_id: job.id, kind: "picked_up" });
    const tampered = await app.inject({
      method: "POST",
      url: `/webhooks/partner/${partner.id}`,
      headers: { "content-type": "application/json", "x-signature": "00".repeat(32) },
      payload: wh1.rawBody
    });
    expect(tampered.statusCode).toBe(401);

    // valid flow: picked_up → en_route → delivered (partner proof photo closes)
    for (const kind of ["picked_up", "en_route", "delivered"] as const) {
      const wh = app.deps.mockPartner.buildWebhook({ job_id: job.id, kind });
      const r = await app.inject({
        method: "POST",
        url: `/webhooks/partner/${partner.id}`,
        headers: { "content-type": "application/json", "x-signature": wh.signature },
        payload: wh.rawBody
      });
      expect(r.statusCode).toBe(200);
      // replay of the same event is a no-op
      const replay = await app.inject({
        method: "POST",
        url: `/webhooks/partner/${partner.id}`,
        headers: { "content-type": "application/json", "x-signature": wh.signature },
        payload: wh.rawBody
      });
      expect(replay.json().outcome).toBe("duplicate");
    }
    const jobAfter = await app.deps.prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(jobAfter.status).toBe("delivered");
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("delivered");
  });

  it("partner refusal falls back to rider broadcast (PARTNER→RIDER re-route)", async () => {
    const order = await codPaidOrder("+22670129006");
    app.deps.mockPartner.refuseNext = true;
    const res = await app.inject({
      method: "POST",
      url: "/deliveries",
      headers: { authorization: `Bearer ${sellerToken}` },
      payload: { order_id: order.id, mode: "PARTNER" }
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().mode).toBe("RIDER");
    expect(res.json().status).toBe("broadcasting");
    await app.deps.prisma.deliveryJob.update({ where: { id: res.json().id }, data: { status: "cancelled" } });
  });

  it("rider isolation: a rider cannot act on another rider's job", async () => {
    const order = await codPaidOrder("+22670129007");
    const job = await requestRiderDelivery(order.id);
    await app.inject({ method: "POST", url: `/jobs/${job.id}/accept`, headers: { authorization: `Bearer ${riderToken}` } });

    const stranger = await app.deps.prisma.user.create({
      data: { phone: `+22670${randomUUID().replace(/\D/g, "").slice(0, 6)}`, country: "BF", roles: ["rider"], kycTier: 2 }
    });
    const strangerToken = app.jwt.sign({ sub: stranger.id, roles: ["rider"], tier: 2, device: "t" }, { expiresIn: "5m" });
    const res = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/status`,
      headers: { authorization: `Bearer ${strangerToken}` },
      payload: { event_id: randomUUID(), status: "picked_up", at: new Date().toISOString() }
    });
    expect(res.statusCode).toBe(403);
    await app.deps.prisma.deliveryJob.update({ where: { id: job.id }, data: { status: "cancelled" } });
  });
});
