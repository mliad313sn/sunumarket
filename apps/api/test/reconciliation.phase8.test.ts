import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const url = process.env.DATABASE_URL;
const d = describe.skipIf(!url);

let app: Awaited<ReturnType<typeof buildApp>>;
let snShopId: string;
const SN_PIN = { lat: 14.68, lng: -17.44, landmark: "À côté de la boulangerie Jaune" };

let seq = 0;
const key = (p: string) => `${p}-${Date.now()}-${seq++}`;

async function paidOrderVia(scenarioDownPrimary: boolean) {
  const product = await app.deps.prisma.product.create({
    data: { shopId: snShopId, title: key("recon-p"), priceMinor: 15000n, currency: "XOF", stock: 5, status: "active" }
  });
  const orderRes = await app.inject({
    method: "POST",
    url: "/orders",
    payload: {
      shop_id: snShopId,
      items: [{ product_id: product.id, qty: 1 }],
      delivery_point: { pin: SN_PIN },
      guest_phone: "+221771239000",
      idempotency_key: key("recon-o")
    }
  });
  const order = orderRes.json();
  if (scenarioDownPrimary) app.deps.mockAggA.down = true;
  const att = (
    await app.inject({
      method: "POST",
      url: `/orders/${order.id}/attempts`,
      payload: { method: "WAVE", idempotency_key: key("recon-a") }
    })
  ).json();
  app.deps.mockAggA.down = false;
  const provider = att.provider_code === "AGG_A" ? app.deps.mockAggA : app.deps.mockAggB;
  const wh = provider.buildWebhook({ providerRef: att.provider_ref, kind: "payment_succeeded" });
  await app.inject({
    method: "POST",
    url: `/webhooks/${att.provider_code.toLowerCase()}`,
    headers: { "content-type": "application/json", "x-signature": wh.signature },
    payload: wh.rawBody
  });
  return { order, att };
}

beforeAll(async () => {
  app = await buildApp();
  snShopId = (await app.deps.prisma.shop.findUniqueOrThrow({ where: { slug: "chez-awa-mode" } })).id;
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  app.deps.router.resetBreakers();
  app.deps.mockAggA.down = false;
  app.deps.mockAggB.down = false;
});

d("phase 8 — settlement reconciliation (FR-19b, golden path 9 part 2)", () => {
  it("failover order settles in the FALLBACK provider's report; both files reconcile with zero discrepancy", async () => {
    // wipe recon state for a clean assertion window
    await app.deps.prisma.reconciliationFlag.deleteMany({});

    const normal = await paidOrderVia(false); // AGG_A
    const failover = await paidOrderVia(true); // AGG_B (primary down)
    expect(normal.att.provider_code).toBe("AGG_A");
    expect(failover.att.provider_code).toBe("AGG_B");

    const today = new Date().toISOString().slice(0, 10);
    const aCsv = `provider_ref,amount_minor,fee_minor,currency\n${normal.att.provider_ref},${normal.order.total.amount_minor},240,XOF`;
    const bCsv = `provider_ref,amount_minor,fee_minor,currency\n${failover.att.provider_ref},${failover.order.total.amount_minor},240,XOF`;

    const batchA = await app.deps.reconciliation.ingestCsv("AGG_A", today, key("agg_a-day") + ".csv", aCsv);
    const batchB = await app.deps.reconciliation.ingestCsv("AGG_B", today, key("agg_b-day") + ".csv", bCsv);

    const ra = await app.deps.reconciliation.runMatch(batchA.id);
    const rb = await app.deps.reconciliation.runMatch(batchB.id);
    expect(ra.matched).toBeGreaterThanOrEqual(1);
    expect(rb.matched).toBeGreaterThanOrEqual(1);

    // zero discrepancy for these two orders
    const flags = await app.deps.prisma.reconciliationFlag.findMany({
      where: { settlementLine: { batchId: { in: [batchA.id, batchB.id] } } }
    });
    expect(flags.filter((f) => f.kind !== "missing_order")).toHaveLength(0);

    const lines = await app.deps.prisma.settlementLine.findMany({ where: { batchId: { in: [batchA.id, batchB.id] } } });
    expect(lines.every((l) => l.matchKind === "exact" && l.matchedTransactionId)).toBe(true);
  });

  it("a corrupted line raises amount_mismatch with aging; resolution clears it", async () => {
    const { att, order } = await paidOrderVia(false);
    const provider = att.provider_code;
    const corrupted = `provider_ref,amount_minor,fee_minor,currency\n${att.provider_ref},${BigInt(order.total.amount_minor) - 500n},240,XOF`;
    const today = new Date().toISOString().slice(0, 10);
    const batch = await app.deps.reconciliation.ingestCsv(provider, today, key("corrupt") + ".csv", corrupted);
    const r = await app.deps.reconciliation.runMatch(batch.id);
    expect(r.flags).toBeGreaterThanOrEqual(1);

    const queue = await app.deps.reconciliation.flagQueue();
    const flag = queue.find((f) => f.settlement_line?.provider_ref === att.provider_ref && f.kind === "amount_mismatch");
    expect(flag).toBeTruthy();
    expect(flag!.aging_bucket).toBe("<24h");

    await app.deps.reconciliation.resolveFlag(flag!.id);
    const after = await app.deps.reconciliation.flagQueue();
    expect(after.some((f) => f.id === flag!.id)).toBe(false);
  });

  it("CHAOS: settlement file missing a paid order → missing_order flag, never silent", async () => {
    const { att } = await paidOrderVia(false);
    const today = new Date().toISOString().slice(0, 10);
    const emptyCsv = `provider_ref,amount_minor,fee_minor,currency\n`;
    const batch = await app.deps.reconciliation.ingestCsv(att.provider_code, today, key("empty") + ".csv", emptyCsv);
    await app.deps.reconciliation.runMatch(batch.id);
    const flags = await app.deps.prisma.reconciliationFlag.findMany({
      where: { kind: "missing_order", status: "open" }
    });
    expect(flags.length).toBeGreaterThanOrEqual(1);
  });

  it("month-end close report aggregates per provider with matched %", async () => {
    const month = new Date().toISOString().slice(0, 7);
    const report = await app.deps.reconciliation.closeReport(month);
    expect(report.providers.length).toBeGreaterThanOrEqual(1);
    for (const p of report.providers) {
      expect(p.matched_pct).toBeGreaterThanOrEqual(0);
      expect(BigInt(p.gross_minor)).toBeGreaterThanOrEqual(0n);
    }
  });

  it("PI-SPI settlement file reconciles like aggregators (golden path 10 settlement leg)", async () => {
    const product = await app.deps.prisma.product.create({
      data: { shopId: snShopId, title: key("pispi-p"), priceMinor: 9000n, currency: "XOF", stock: 3, status: "active" }
    });
    const order = (
      await app.inject({
        method: "POST",
        url: "/orders",
        payload: {
          shop_id: snShopId,
          items: [{ product_id: product.id, qty: 1 }],
          delivery_point: { pin: SN_PIN },
          guest_phone: "+221771239001",
          idempotency_key: key("pispi-o")
        }
      })
    ).json();
    const att = (
      await app.inject({
        method: "POST",
        url: `/orders/${order.id}/attempts`,
        payload: { method: "PI_SPI", idempotency_key: key("pispi-a") }
      })
    ).json();
    const wh = app.deps.mockPiSpi.buildWebhook({ providerRef: att.provider_ref, kind: "payment_succeeded" });
    await app.inject({
      method: "POST",
      url: "/webhooks/pispi",
      headers: { "content-type": "application/json", "x-signature": wh.signature },
      payload: wh.rawBody
    });

    const today = new Date().toISOString().slice(0, 10);
    const csv = `provider_ref,amount_minor,fee_minor,currency\n${att.provider_ref},${order.total.amount_minor},0,XOF`;
    const batch = await app.deps.reconciliation.ingestCsv("PISPI", today, key("pispi") + ".csv", csv);
    const r = await app.deps.reconciliation.runMatch(batch.id);
    expect(r.matched).toBe(1);
  });
});
