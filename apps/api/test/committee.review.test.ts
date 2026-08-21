import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MockMessagingProvider, OutboxMessagingProvider } from "../src/lib/messaging.js";

/**
 * Committee review remediation suite (Goal §4 stakeholder re-convening).
 * One test per finding:
 *  A — COD sale credits the seller's ledger at delivery (CFO/Awa)
 *  B — notifications persist to sms_outbox; delivered SMS sent (Tantie Rokia/DC-15)
 *  C — partner job list is isolated to the caller's partner (Security/DiaLog)
 *  D — worker sweeps exist and run (Ops): auto-complete delivered orders
 *  E — dispatch re-broadcast escalates to the seller from round 2 (Moussa)
 *  F — per-method payment success metrics for the KPI dashboard (Goal §10)
 */
const url = process.env.DATABASE_URL;
const d = describe.skipIf(!url);

let app: Awaited<ReturnType<typeof buildApp>>;
const inner = new MockMessagingProvider();
let bfShopId: string;
let bfSellerId: string;
let sellerToken: string;
let moussaId: string;
let riderToken: string;
let adminToken: string;

const BF_PIN = { lat: 12.36, lng: -1.51, landmark: "Derrière le marché de Koulouba" };
let seq = 0;
const key = (p: string) => `${p}-${Date.now()}-${seq++}`;

async function codOrderDelivered(phone: string) {
  const product = await app.deps.prisma.product.create({
    data: { shopId: bfShopId, title: key("cr-p"), priceMinor: 20000n, currency: "XOF", stock: 3, status: "active" }
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
        idempotency_key: key("cr-o")
      }
    })
  ).json();
  await app.inject({
    method: "POST",
    url: `/orders/${order.id}/attempts`,
    payload: { method: "COD", idempotency_key: key("cr-a") }
  });
  const job = (
    await app.inject({
      method: "POST",
      url: "/deliveries",
      headers: { authorization: `Bearer ${sellerToken}` },
      payload: { order_id: order.id, mode: "RIDER" }
    })
  ).json();
  await app.inject({ method: "POST", url: `/jobs/${job.id}/accept`, headers: { authorization: `Bearer ${riderToken}` } });
  for (const status of ["picked_up", "en_route", "arrived"]) {
    await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/status`,
      headers: { authorization: `Bearer ${riderToken}` },
      payload: { event_id: randomUUID(), status, at: new Date().toISOString() }
    });
  }
  const otp = inner.lastTo(phone)!.body.match(/code de réception (\d{4})/)![1]!;
  const proof = await app.inject({
    method: "POST",
    url: `/jobs/${job.id}/proof`,
    headers: { authorization: `Bearer ${riderToken}` },
    payload: { kind: "otp", code: otp }
  });
  expect(proof.statusCode).toBe(200);
  return order as { id: string; total: { amount_minor: string } };
}

beforeAll(async () => {
  // outbox wraps the observable inner mock — both finding-B assertions possible
  const { getPrisma } = await import("../src/lib/prisma.js");
  app = await buildApp({ messaging: new OutboxMessagingProvider(getPrisma(), inner) });

  const shop = await app.deps.prisma.shop.findUniqueOrThrow({ where: { slug: "kabore-electronique" } });
  bfShopId = shop.id;
  bfSellerId = shop.sellerId;
  sellerToken = app.jwt.sign({ sub: bfSellerId, roles: ["seller"], tier: 1, device: "t" }, { expiresIn: "20m" });
  const moussa = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+22670123503" } });
  moussaId = moussa.id;
  riderToken = app.jwt.sign({ sub: moussaId, roles: ["rider"], tier: 2, device: "t" }, { expiresIn: "20m" });
  const admin = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+221771234504" } });
  adminToken = app.jwt.sign({ sub: admin.id, roles: admin.roles, tier: 2, device: "t" }, { expiresIn: "20m" });

  await app.deps.prisma.rider.update({ where: { userId: moussaId }, data: { active: true } });
  const outstanding = await app.deps.delivery.codOutstanding(moussaId);
  if (outstanding > 0n) {
    await app.deps.prisma.riderCashLedger.create({
      data: { riderId: moussaId, amountMinor: -outstanding, currency: "XOF", kind: "remitted_agent" }
    });
    await app.deps.prisma.rider.update({ where: { userId: moussaId }, data: { codOutstandingMinor: 0n } });
  }
});
afterAll(async () => {
  await app.close();
});

d("finding A — COD sale credits the seller's ledger at delivery (FR-16/FR-19)", () => {
  it("seller payable = gross − platform fee only (no provider fee / MM tax on cash)", async () => {
    const before = await app.deps.ledger.balance("seller", bfSellerId, "XOF");
    const order = await codOrderDelivered("+22670126001");
    const after = await app.deps.ledger.balance("seller", bfSellerId, "XOF");

    const gross = BigInt(order.total.amount_minor); // 20 000 + 750 delivery = 20 750
    const platformFee = (gross * 200n + 5000n) / 10000n; // 2% BF pack, half-up
    expect(after - before).toBe(gross - platformFee);

    // the ledger txn is anchored to the COD attempt and stays balanced
    const attempt = await app.deps.prisma.paymentAttempt.findFirstOrThrow({
      where: { orderId: order.id, method: "COD" },
      include: { transaction: { include: { entries: true } } }
    });
    expect(attempt.transaction).toBeTruthy();
    const sum = attempt.transaction!.entries.reduce((s, e) => s + e.amountMinor, 0n);
    expect(sum).toBe(0n);
    expect(attempt.transaction!.entries.some((e) => e.leg === "provider_fee")).toBe(false);
    expect(attempt.transaction!.entries.some((e) => e.leg === "platform_fee")).toBe(true);
  });
});

d("finding B — SMS outbox persistence + delivered notification (DC-15)", () => {
  it("proof-code and delivered SMS both land in sms_outbox as sent", async () => {
    const phone = "+22670126002";
    await codOrderDelivered(phone);
    const rows = await app.deps.prisma.smsOutbox.findMany({ where: { phone }, orderBy: { createdAt: "asc" } });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((r) => r.body.includes("code de réception"))).toBe(true);
    expect(rows.some((r) => r.body.includes("livrée"))).toBe(true);
    expect(rows.every((r) => r.status === "sent" && r.sentAt !== null)).toBe(true);
    // the gateway really received them too
    expect(inner.sent.filter((m) => m.phone === phone).length).toBeGreaterThanOrEqual(2);
  });

  it("gateway failure leaves the row queued; worker flush retries it", async () => {
    const prisma = app.deps.prisma;
    let fail = true;
    const flaky = {
      sendSms: async () => {
        if (fail) throw new Error("gateway down");
      }
    };
    const outbox = new OutboxMessagingProvider(prisma, flaky);
    const phone = `+226701${Math.floor(10000 + Math.random() * 89999)}`; // run-unique
    await outbox.sendSms({ phone, body: "test retry", senderId: "SUNUMKT" });
    let row = await prisma.smsOutbox.findFirstOrThrow({ where: { phone } });
    expect(row.status).toBe("queued");

    fail = false;
    const sent = await outbox.flushQueued();
    expect(sent).toBeGreaterThanOrEqual(1);
    row = await prisma.smsOutbox.findFirstOrThrow({ where: { phone } });
    expect(row.status).toBe("sent");
  });
});

d("finding C — partner data isolation", () => {
  it("linked partner user sees only their jobs; unlinked partner-role user gets 403", async () => {
    const ops = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+221771234508" } });
    const opsToken = app.jwt.sign({ sub: ops.id, roles: ["partner"], tier: 1, device: "t" }, { expiresIn: "5m" });
    const res = await app.inject({ method: "GET", url: "/partner/jobs", headers: { authorization: `Bearer ${opsToken}` } });
    expect(res.statusCode).toBe(200);
    // deterministic: THE partner linked to ops (an unfiltered findFirst is
    // heap-order dependent once other suites have created partner rows)
    const partner = await app.deps.prisma.partner.findFirstOrThrow({ where: { contactUserId: ops.id } });
    for (const job of res.json() as Array<{ partner_id: string }>) {
      expect(job.partner_id).toBe(partner.id);
    }

    const stranger = await app.deps.prisma.user.create({
      data: { phone: `+22177126${Math.floor(1000 + Math.random() * 8999)}`, country: "SN", roles: ["partner"] }
    });
    const strangerToken = app.jwt.sign({ sub: stranger.id, roles: ["partner"], tier: 0, device: "t" }, { expiresIn: "5m" });
    const denied = await app.inject({ method: "GET", url: "/partner/jobs", headers: { authorization: `Bearer ${strangerToken}` } });
    expect(denied.statusCode).toBe(403);
  });
});

d("finding D — worker sweeps (ops)", () => {
  it("delivered orders auto-complete after the review window", async () => {
    const order = await codOrderDelivered("+22670126004");
    // age the delivered order past the 3-day window
    await app.deps.prisma.$executeRaw`
      UPDATE orders SET updated_at = now() - interval '4 days' WHERE id = ${order.id}::uuid`;
    const n = await app.deps.orders.autoCompleteDelivered();
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("completed");
    // idempotent — second sweep does nothing to it
    await app.deps.orders.autoCompleteDelivered();
    expect((await app.deps.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("completed");
  });

  it("worker module exposes runnable fast/slow sweeps", async () => {
    const worker = await import("../src/worker.js");
    await expect(worker.fastSweep()).resolves.toBeUndefined();
    await expect(worker.slowSweep()).resolves.toBeUndefined();
  });
});

d("finding E — dispatch escalation (FR-26)", () => {
  it("second stale re-broadcast notifies the seller by SMS", async () => {
    // deactivate all riders so nobody accepts
    await app.deps.prisma.rider.updateMany({ data: { active: false } });
    const product = await app.deps.prisma.product.create({
      data: { shopId: bfShopId, title: key("esc-p"), priceMinor: 5000n, currency: "XOF", stock: 1, status: "active" }
    });
    const order = (
      await app.inject({
        method: "POST",
        url: "/orders",
        payload: {
          shop_id: bfShopId,
          items: [{ product_id: product.id, qty: 1 }],
          delivery_point: { pin: BF_PIN },
          guest_phone: "+22670126005",
          idempotency_key: key("esc-o")
        }
      })
    ).json();
    await app.inject({ method: "POST", url: `/orders/${order.id}/attempts`, payload: { method: "COD", idempotency_key: key("esc-a") } });
    const job = (
      await app.inject({
        method: "POST",
        url: "/deliveries",
        headers: { authorization: `Bearer ${sellerToken}` },
        payload: { order_id: order.id, mode: "RIDER" }
      })
    ).json();

    const sellerPhone = (await app.deps.prisma.user.findUniqueOrThrow({ where: { id: bfSellerId } })).phone;
    const sellerSmsBefore = inner.sent.filter((m) => m.phone === sellerPhone).length;

    for (let round = 1; round <= 2; round++) {
      await app.deps.prisma.deliveryJob.update({
        where: { id: job.id },
        data: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) }
      });
      await app.deps.delivery.rebroadcastStale();
    }
    const sellerSmsAfter = inner.sent.filter((m) => m.phone === sellerPhone).length;
    expect(sellerSmsAfter).toBeGreaterThan(sellerSmsBefore);
    expect(inner.lastTo(sellerPhone)!.body).toContain("aucun livreur");

    // restore rider state
    await app.deps.prisma.deliveryJob.update({ where: { id: job.id }, data: { status: "cancelled" } });
    await app.deps.prisma.rider.update({ where: { userId: moussaId }, data: { active: true } });
  });
});

d("finding F — per-method KPI metrics (Goal §10)", () => {
  it("admin metrics report success rate per method and paid volume per provider", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/metrics/payments",
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const cod = body.per_method.find((m: { method: string }) => m.method === "COD");
    expect(cod.succeeded).toBeGreaterThan(0);
    expect(body.per_method.every((m: { success_rate_pct: number | null }) => m.success_rate_pct === null || (m.success_rate_pct >= 0 && m.success_rate_pct <= 100))).toBe(true);
    // anonymous/non-admin blocked
    const anon = await app.inject({ method: "GET", url: "/admin/metrics/payments" });
    expect(anon.statusCode).toBe(401);
  });
});
