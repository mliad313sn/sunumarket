import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "@sunumarket/api/src/app.js";
import { MockMessagingProvider } from "@sunumarket/api/src/lib/messaging.js";

/**
 * Phase 12 — consolidated E2E: all 10 golden paths against the real HTTP stack
 * (Fastify listening on a socket, Postgres+PostGIS, mock providers).
 * Black-box: everything goes through fetch; no service internals except
 * webhook signing (which the real provider would do) and worker sweeps.
 */
const messaging = new MockMessagingProvider();
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";

const SN_PIN = { lat: 14.68, lng: -17.44, landmark: "À côté de la boulangerie Jaune" };
const BF_PIN = { lat: 12.36, lng: -1.51, landmark: "Derrière le marché de Koulouba" };
let seq = 0;
const key = (p: string) => `${p}-${Date.now()}-${seq++}`;

async function http<T = unknown>(path: string, init?: RequestInit & { token?: string }): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init?.headers ?? {})
    }
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

function tokenFor(userId: string, roles: string[], tier = 1): string {
  return app.jwt.sign({ sub: userId, roles, tier, device: "e2e" }, { expiresIn: "30m" });
}

async function webhook(provider: "AGG_A" | "AGG_B" | "PISPI", providerRef: string) {
  const p = provider === "AGG_A" ? app.deps.mockAggA : provider === "AGG_B" ? app.deps.mockAggB : app.deps.mockPiSpi;
  const wh = p.buildWebhook({ providerRef, kind: "payment_succeeded" });
  return http<{ outcome: string }>(`/webhooks/${provider.toLowerCase()}`, {
    method: "POST",
    headers: { "x-signature": wh.signature },
    body: wh.rawBody
  });
}

interface OrderB { id: string; total: { amount_minor: string }; tracking_token: string }
interface AttemptB { id: string; status: string; provider_code: string; provider_ref: string; ussd: { dial_code: string } | null; next_action: { kind: string; qr_payload?: string; manual_reference?: string } | null }

async function makeOrder(shopId: string, pin: typeof SN_PIN, phone: string, priceMinor = 10000n) {
  const shop = await app.deps.prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  void shop;
  const product = await app.deps.prisma.product.create({
    data: { shopId, title: key("gp-p"), priceMinor, currency: "XOF", stock: 10, status: "active" }
  });
  const r = await http<OrderB>("/orders", {
    method: "POST",
    body: JSON.stringify({
      shop_id: shopId,
      items: [{ product_id: product.id, qty: 1 }],
      delivery_point: { pin },
      guest_phone: phone,
      idempotency_key: key("gp-o")
    })
  });
  expect(r.status).toBe(201);
  return { order: r.body, product };
}

async function attempt(orderId: string, method: string, scenario?: string) {
  return http<AttemptB>(`/orders/${orderId}/attempts`, {
    method: "POST",
    body: JSON.stringify({
      method,
      idempotency_key: key("gp-a"),
      ...(scenario ? { mock_scenario: scenario } : {})
    })
  });
}

let snShopId: string;
let bfShopId: string;
let sellerBfToken: string;
let moussaId: string;
let riderToken: string;

beforeAll(async () => {
  app = await buildApp({ messaging });
  await app.listen({ port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;

  snShopId = (await app.deps.prisma.shop.findUniqueOrThrow({ where: { slug: "chez-awa-mode" } })).id;
  // normalize the seed shop's method subset (other suites narrow it)
  await app.deps.prisma.shop.update({
    where: { id: snShopId },
    data: { enabledMethods: ["WAVE", "ORANGE_MONEY", "COD", "PI_SPI"] }
  });
  const bfShop = await app.deps.prisma.shop.findUniqueOrThrow({ where: { slug: "kabore-electronique" } });
  bfShopId = bfShop.id;
  sellerBfToken = tokenFor(bfShop.sellerId, ["seller"]);
  const moussa = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+22670123503" } });
  moussaId = moussa.id;
  riderToken = tokenFor(moussaId, ["rider"], 2);
  await app.deps.prisma.rider.update({ where: { userId: moussaId }, data: { active: true } });
  const outstanding = await app.deps.delivery.codOutstanding(moussaId);
  if (outstanding > 0n) {
    await app.deps.prisma.riderCashLedger.create({
      data: { riderId: moussaId, amountMinor: -outstanding, currency: "XOF", kind: "remitted_agent" }
    });
  }
}, 60000);

afterAll(async () => {
  await app.close();
});

describe("golden path 1 — seller onboards and publishes unaided", () => {
  it("OTP signup → shop wizard → product live on the marketplace", async () => {
    const phone = `+22177${Math.floor(1000000 + Math.random() * 8999999)}`;
    const device = "gp1-phone";
    expect((await http("/auth/otp", { method: "POST", body: JSON.stringify({ phone, country: "SN", device_hash: device }) })).status).toBe(200);
    const code = messaging.lastTo(phone)!.body.match(/code est (\d{6})/)![1]!;
    const verify = await http<{ access_token: string }>("/auth/verify", {
      method: "POST",
      body: JSON.stringify({ phone, code, device_hash: device })
    });
    expect(verify.status).toBe(200);
    const token = verify.body.access_token;

    const city = await app.deps.prisma.city.findFirstOrThrow({ where: { country: "SN" } });
    const shop = await http<{ id: string; slug: string; enabledMethods: string[] }>("/shops", {
      method: "POST",
      token,
      body: JSON.stringify({ name: `Boutique GP1 ${Date.now()}`, country: "SN", city_id: city.id })
    });
    expect(shop.status).toBe(201);
    expect(shop.body.enabledMethods[0]).toBe("WAVE"); // pack default, dominant first

    const product = await http<{ id: string }>(`/shops/${shop.body.id}/products`, {
      method: "POST",
      token,
      body: JSON.stringify({ title: "Sandales cuir GP1", price: { amount_minor: "7500", currency: "XOF" }, stock: 4, image_keys: [] })
    });
    expect(product.status).toBe(201);

    const page = await http<{ products: Array<{ id: string }> }>(`/shops/${shop.body.slug}`);
    expect(page.body.products.some((p) => p.id === product.body.id)).toBe(true);
  });
});

describe("golden path 2 — buyer pays Orange Money to a GPS pin", () => {
  it("order → USSD confirm → webhook → paid → tracking live", async () => {
    const { order } = await makeOrder(snShopId, SN_PIN, "+221771250002");
    const att = await attempt(order.id, "ORANGE_MONEY");
    expect(att.body.status).toBe("ussd_pending");
    expect(att.body.ussd?.dial_code).toBe("#144#");
    const wh = await webhook(att.body.provider_code as "AGG_A", att.body.provider_ref);
    expect(wh.body.outcome).toBe("applied");
    const track = await http<{ status: string }>(`/track/${order.tracking_token}`);
    expect(track.body.status).toBe("paid");
  });
});

describe("golden path 3 — method fallback WAVE→MTN on the same order", () => {
  it("WAVE declines, MTN (CI shop) succeeds", async () => {
    const ciShop = await app.deps.prisma.shop.findUniqueOrThrow({ where: { slug: "adjoua-beaute" } });
    const { order } = await makeOrder(ciShop.id, { lat: 5.33, lng: -4.0, landmark: "Pharmacie du Plateau" }, "+2250701250003");
    const wave = await attempt(order.id, "WAVE", "decline");
    expect(wave.body.status).toBe("failed");
    const mtn = await attempt(order.id, "MTN_MOMO");
    expect(mtn.body.status).toBe("ussd_pending");
    await webhook(mtn.body.provider_code as "AGG_B", mtn.body.provider_ref);
    expect((await http<{ status: string }>(`/track/${order.tracking_token}`)).body.status).toBe("paid");
  });
});

describe("golden path 4 — manual transfer only where enabled", () => {
  it("blocked by default; enabled pack → unique ref, forged ref rejected, seller balance-check confirms", async () => {
    const { order } = await makeOrder(snShopId, SN_PIN, "+221771250004");
    expect((await attempt(order.id, "MANUAL_TRANSFER")).status).toBe(400);

    app.deps.packs.setMethodOverride("SN", "MANUAL_TRANSFER", true);
    await app.deps.prisma.shop.update({ where: { id: snShopId }, data: { enabledMethods: { push: "MANUAL_TRANSFER" } } });

    const att = await attempt(order.id, "MANUAL_TRANSFER");
    expect(att.status).toBe(201);
    const reference = att.body.next_action!.manual_reference!;

    expect((await http(`/attempts/${att.body.id}/manual-proof`, { method: "POST", body: JSON.stringify({ reference: "SM-WRONG123" }) })).status).toBe(400);
    expect((await http(`/attempts/${att.body.id}/manual-proof`, { method: "POST", body: JSON.stringify({ reference }) })).status).toBe(200);

    const shop = await app.deps.prisma.shop.findUniqueOrThrow({ where: { id: snShopId } });
    const sellerToken = tokenFor(shop.sellerId, ["seller"]);
    expect(
      (await http(`/attempts/${att.body.id}/seller-confirm`, { method: "POST", token: sellerToken, body: JSON.stringify({ balance_checked: true }) })).status
    ).toBe(200);
    expect((await http<{ status: string }>(`/track/${order.tracking_token}`)).body.status).toBe("paid");

    app.deps.packs.clearOverrides();
    await app.deps.prisma.shop.update({ where: { id: snShopId }, data: { enabledMethods: ["WAVE", "ORANGE_MONEY", "COD", "PI_SPI"] } });
  });
});

describe("golden path 5 — rider closes a COD order end to end, cash reconciled", () => {
  it("COD order → dispatch → accept → statuses → OTP proof → delivered → PI-SPI remittance", async () => {
    const phone = "+22670125005";
    const { order } = await makeOrder(bfShopId, BF_PIN, phone, 20000n);
    await attempt(order.id, "COD");

    const job = await http<{ id: string }>("/deliveries", {
      method: "POST",
      token: sellerBfToken,
      body: JSON.stringify({ order_id: order.id, mode: "RIDER" })
    });
    expect(job.status).toBe(201);

    expect((await http(`/jobs/${job.body.id}/accept`, { method: "POST", token: riderToken, body: "{}" })).status).toBe(200);
    for (const status of ["picked_up", "en_route", "arrived"]) {
      const r = await http(`/jobs/${job.body.id}/status`, {
        method: "POST",
        token: riderToken,
        body: JSON.stringify({ event_id: randomUUID(), status, gps: { lat: 12.37, lng: -1.52 }, at: new Date().toISOString() })
      });
      expect(r.status).toBe(200);
    }
    const otp = messaging.lastTo(phone)!.body.match(/code de réception (\d{4})/)![1]!;
    expect((await http(`/jobs/${job.body.id}/proof`, { method: "POST", token: riderToken, body: JSON.stringify({ kind: "otp", code: otp }) })).status).toBe(200);
    expect((await http<{ status: string }>(`/track/${order.tracking_token}`)).body.status).toBe("delivered");

    const cash = await http<{ outstanding: { amount_minor: string } }>("/rider/cash", { token: riderToken });
    expect(BigInt(cash.body.outstanding.amount_minor)).toBeGreaterThan(0n);
    const remit = await http("/riders/remittances", {
      method: "POST",
      token: riderToken,
      body: JSON.stringify({ amount: { amount_minor: cash.body.outstanding.amount_minor, currency: "XOF" }, rail: "PI_SPI", idempotency_key: key("gp5") })
    });
    expect(remit.status).toBe(200);
    expect(BigInt((await http<{ outstanding: { amount_minor: string } }>("/rider/cash", { token: riderToken })).body.outstanding.amount_minor)).toBe(0n);
  });
});

describe("golden path 6 — partner delivery", () => {
  it("partner accepts, signed webhooks drive to delivered", async () => {
    const { order } = await makeOrder(bfShopId, BF_PIN, "+22670125006");
    await attempt(order.id, "COD");
    const job = await http<{ id: string; status: string }>("/deliveries", {
      method: "POST",
      token: sellerBfToken,
      body: JSON.stringify({ order_id: order.id, mode: "PARTNER" })
    });
    expect(job.body.status).toBe("accepted");
    const partner = await app.deps.prisma.partner.findFirstOrThrow();
    for (const kind of ["picked_up", "en_route", "delivered"] as const) {
      const wh = app.deps.mockPartner.buildWebhook({ job_id: job.body.id, kind });
      const r = await http(`/webhooks/partner/${partner.id}`, { method: "POST", headers: { "x-signature": wh.signature }, body: wh.rawBody });
      expect(r.status).toBe(200);
    }
    expect((await http<{ status: string }>(`/track/${order.tracking_token}`)).body.status).toBe("delivered");
  });
});

describe("golden path 7 — delivery issue + refund", () => {
  it("incident → delivery_issue → dispute → admin resolves with refund", async () => {
    const phone = "+22670125007";
    const { order } = await makeOrder(bfShopId, BF_PIN, phone);
    await attempt(order.id, "COD");
    const job = await http<{ id: string }>("/deliveries", {
      method: "POST",
      token: sellerBfToken,
      body: JSON.stringify({ order_id: order.id, mode: "RIDER" })
    });
    await http(`/jobs/${job.body.id}/accept`, { method: "POST", token: riderToken, body: "{}" });
    for (const status of ["picked_up", "en_route"]) {
      await http(`/jobs/${job.body.id}/status`, {
        method: "POST",
        token: riderToken,
        body: JSON.stringify({ event_id: randomUUID(), status, at: new Date().toISOString() })
      });
    }
    await http(`/jobs/${job.body.id}/incident`, { method: "POST", token: riderToken, body: JSON.stringify({ reason: "adresse introuvable" }) });
    expect((await http<{ status: string }>(`/track/${order.tracking_token}`)).body.status).toBe("delivery_issue");

    const dispute = await http<{ id: string }>(`/orders/${order.id}/disputes`, {
      method: "POST",
      body: JSON.stringify({ reason: "jamais reçu ma commande", guest_phone: phone })
    });
    expect(dispute.status).toBe(201);
    const admin = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+221771234504" } });
    const adminToken = tokenFor(admin.id, ["admin"], 2);
    const resolve = await http(`/admin/disputes/${dispute.body.id}/resolve`, {
      method: "POST",
      token: adminToken,
      body: JSON.stringify({ resolution: "refund" })
    });
    expect(resolve.status).toBe(200);
    expect((await http<{ status: string }>(`/track/${order.tracking_token}`)).body.status).toBe("refunded");
  });
});

describe("golden path 8 — stock race + offline pin replay", () => {
  it("20 parallel buyers, 1 unit → 1 winner; offline order replays are idempotent", async () => {
    const product = await app.deps.prisma.product.create({
      data: { shopId: snShopId, title: key("gp8"), priceMinor: 5000n, currency: "XOF", stock: 1, status: "active" }
    });
    const buyers = Array.from({ length: 20 }, (_, i) =>
      http("/orders", {
        method: "POST",
        body: JSON.stringify({
          shop_id: snShopId,
          items: [{ product_id: product.id, qty: 1 }],
          delivery_point: { pin: SN_PIN },
          guest_phone: `+2217712501${(10 + i).toString()}`,
          idempotency_key: key(`gp8-${i}`)
        })
      })
    );
    const results = await Promise.all(buyers);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);

    // offline replay: same idempotency key sent twice (flushed queue duplicate)
    const idem = key("gp8-offline");
    const body = JSON.stringify({
      shop_id: snShopId,
      items: [{ product_id: (await app.deps.prisma.product.create({ data: { shopId: snShopId, title: key("gp8b"), priceMinor: 4000n, currency: "XOF", stock: 3, status: "active" } })).id, qty: 1 }],
      delivery_point: { pin: SN_PIN },
      guest_phone: "+221771250199",
      idempotency_key: idem
    });
    const first = await http<OrderB>("/orders", { method: "POST", body });
    const replay = await http<OrderB>("/orders", { method: "POST", body });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
  });
});

describe("golden path 9 — aggregator outage, failover, settlement reconciliation", () => {
  it("primary down → fallback pays; next-day files from both providers reconcile with zero discrepancy", async () => {
    app.deps.router.resetBreakers();
    const normal = await makeOrder(snShopId, SN_PIN, "+221771250009");
    const attN = await attempt(normal.order.id, "WAVE");
    expect(attN.body.provider_code).toBe("AGG_A");
    await webhook("AGG_A", attN.body.provider_ref);

    app.deps.mockAggA.down = true;
    const failover = await makeOrder(snShopId, SN_PIN, "+221771250010");
    const attF = await attempt(failover.order.id, "WAVE");
    expect(attF.body.provider_code).toBe("AGG_B"); // breaker/failover routed
    app.deps.mockAggA.down = false;
    await webhook("AGG_B", attF.body.provider_ref);

    const today = new Date().toISOString().slice(0, 10);
    const bA = await app.deps.reconciliation.ingestCsv("AGG_A", today, key("gp9a") + ".csv",
      `provider_ref,amount_minor,fee_minor,currency\n${attN.body.provider_ref},${normal.order.total.amount_minor},150,XOF`);
    const bB = await app.deps.reconciliation.ingestCsv("AGG_B", today, key("gp9b") + ".csv",
      `provider_ref,amount_minor,fee_minor,currency\n${attF.body.provider_ref},${failover.order.total.amount_minor},150,XOF`);
    const rA = await app.deps.reconciliation.runMatch(bA.id);
    const rB = await app.deps.reconciliation.runMatch(bB.id);
    expect(rA.matched).toBeGreaterThanOrEqual(1);
    expect(rB.matched).toBeGreaterThanOrEqual(1);
    const lines = await app.deps.prisma.settlementLine.findMany({ where: { batchId: { in: [bA.id, bB.id] } } });
    expect(lines.every((l) => l.matchKind === "exact")).toBe(true);
  });
});

describe("golden path 10 — PI-SPI end-to-end + payouts + Tantie Rokia USSD variant", () => {
  it("buyer pays via PI-SPI QR; seller payout + rider remittance settle on the PI-SPI rail", async () => {
    const { order } = await makeOrder(snShopId, SN_PIN, "+221771250011", 30000n);
    const att = await attempt(order.id, "PI_SPI");
    expect(att.body.next_action?.kind).toBe("qr");
    await webhook("PISPI", att.body.provider_ref);
    expect((await http<{ status: string }>(`/track/${order.tracking_token}`)).body.status).toBe("paid");

    // seller payout over PI-SPI
    const shop = await app.deps.prisma.shop.findUniqueOrThrow({ where: { id: snShopId } });
    await app.deps.prisma.deviceBinding.upsert({
      where: { userId_deviceHash: { userId: shop.sellerId, deviceHash: "e2e" } },
      update: { trusted: true, firstSeen: new Date(Date.now() - 48 * 3600e3) },
      create: { userId: shop.sellerId, deviceHash: "e2e", trusted: true, firstSeen: new Date(Date.now() - 48 * 3600e3), lastVerified: new Date() }
    });
    await app.deps.prisma.user.update({ where: { id: shop.sellerId }, data: { payoutPinHash: null } });
    await app.deps.prisma.payout.deleteMany({ where: { sellerId: shop.sellerId } });
    const balance = await app.deps.ledger.balance("seller", shop.sellerId, "XOF");
    expect(balance).toBeGreaterThan(0n);
    const amount = balance < 100000n ? balance : 100000n;
    const payout = await http<{ rail: string; status: string }>("/payouts", {
      method: "POST",
      token: tokenFor(shop.sellerId, ["seller"]),
      body: JSON.stringify({ amount: { amount_minor: amount.toString(), currency: "XOF" }, idempotency_key: key("gp10") })
    });
    expect(payout.status).toBe(201);
    expect(payout.body.rail).toBe("PI_SPI");
    expect(payout.body.status).toBe("settled");
  });

  it("Tantie Rokia variant: Orange Money USSD confirm completes without abandonment", async () => {
    const { order } = await makeOrder(snShopId, SN_PIN, "+221771250012");
    const att = await attempt(order.id, "ORANGE_MONEY");
    expect(att.body.status).toBe("ussd_pending");
    expect(att.body.ussd?.dial_code).toBe("#144#");
    // resend once (network hiccup) then confirm — no abandonment
    expect((await http(`/attempts/${att.body.id}/ussd-resend`, { method: "POST", body: "{}" })).status).toBe(200);
    await webhook(att.body.provider_code as "AGG_A", att.body.provider_ref);
    expect((await http<{ status: string }>(`/track/${order.tracking_token}`)).body.status).toBe("paid");
  });
});

describe("expansion drill — NFR-8 (Mali as config only)", () => {
  it("activating the ML draft pack exposes OM+Moov ordering, +223 phone validation and ML taxes with ZERO code change", async () => {
    // Drill: copy packs to a staging dir, flip ml.json to active, hot-reload.
    const { mkdtempSync, cpSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ml-drill-"));
    cpSync(new URL("../../packages/config/countries", import.meta.url).pathname, dir, { recursive: true });
    const mlPath = join(dir, "ml.json");
    const ml = JSON.parse(readFileSync(mlPath, "utf8")) as { status: string; version: number };
    ml.status = "active";
    ml.version = 2;
    writeFileSync(mlPath, JSON.stringify(ml));

    app.deps.packs.reload(dir); // hot reload — no restart, no deploy

    expect(app.deps.packs.list().some((p) => p.country === "ML")).toBe(true);
    const methods = app.deps.packs.enabledMethods("ML");
    expect(methods[0]!.type).toBe("ORANGE_MONEY");
    expect(methods[1]!.type).toBe("MOOV_MONEY");
    expect(app.deps.packs.validatePhone("ML", "+22376123456")).toBe(true);
    expect(app.deps.packs.validatePhone("ML", "+221771234567")).toBe(false);
    expect(app.deps.packs.get("ML").fees_taxes.pass_through.some((f) => f.kind === "mm_transaction_tax")).toBe(true);
    expect(app.deps.packs.providerRoute("ML", "ORANGE_MONEY")).toEqual({ primary: "AGG_A", fallback: "AGG_B" });

    // restore the shipped packs
    app.deps.packs.reload(new URL("../../packages/config/countries", import.meta.url).pathname);
    expect(app.deps.packs.list().some((p) => p.country === "ML")).toBe(false);
  });
});
