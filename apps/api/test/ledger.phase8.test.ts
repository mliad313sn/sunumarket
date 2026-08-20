import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { LedgerError } from "../src/modules/ledger/ledger.service.js";

const url = process.env.DATABASE_URL;
const d = describe.skipIf(!url);

let app: Awaited<ReturnType<typeof buildApp>>;
let awaId: string;

beforeAll(async () => {
  app = await buildApp();
  awaId = (await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+221771234501" } })).id;
});
afterAll(async () => {
  await app.close();
});

d("phase 8 — double-entry ledger (FR-19)", () => {
  it("rejects unbalanced and zero-entry transactions", async () => {
    await expect(
      app.deps.ledger.post("adjustment", [
        { ownerType: "platform", amountMinor: 100n, currency: "XOF", leg: "gross" },
        { ownerType: "seller", ownerId: awaId, amountMinor: -99n, currency: "XOF", leg: "net" }
      ])
    ).rejects.toThrow(LedgerError);
    await expect(
      app.deps.ledger.post("adjustment", [
        { ownerType: "platform", amountMinor: 0n, currency: "XOF", leg: "gross" },
        { ownerType: "seller", ownerId: awaId, amountMinor: 0n, currency: "XOF", leg: "net" }
      ])
    ).rejects.toThrow();
  });

  it("sale split per SN pack: 1.5% provider + 2% platform + 0.5% tax, seller nets the rest", async () => {
    const { transactionId, netMinor } = await app.deps.ledger.recordSale({
      orderId: "00000000-0000-4000-8000-00000000led1",
      attemptId: (
        await app.deps.prisma.paymentAttempt.create({
          data: {
            orderId: (await anyPaidOrder()).id,
            method: "WAVE",
            status: "succeeded",
            idempotencyKey: `led-${Date.now()}-1`,
            providerRef: `LED-${Date.now()}-1`
          }
        })
      ).id,
      sellerId: awaId,
      country: "SN",
      grossMinor: 100000n,
      currency: "XOF"
    });
    // 1500 + 2000 + 500 = 4000 fees → net 96000
    expect(netMinor).toBe(96000n);
    const entries = await app.deps.prisma.ledgerEntry.findMany({ where: { transactionId } });
    const sum = entries.reduce((s, e) => s + e.amountMinor, 0n);
    expect(sum).toBe(0n);
    expect(entries.map((e) => e.leg).sort()).toEqual(["gross", "net", "platform_fee", "provider_fee", "tax"]);
  });

  it("refund reverses the sale exactly", async () => {
    const attempt = await app.deps.prisma.paymentAttempt.create({
      data: {
        orderId: (await anyPaidOrder()).id,
        method: "WAVE",
        status: "succeeded",
        idempotencyKey: `led-${Date.now()}-2`,
        providerRef: `LED-${Date.now()}-2`
      }
    });
    const before = await app.deps.ledger.balance("seller", awaId, "XOF");
    const { transactionId } = await app.deps.ledger.recordSale({
      orderId: attempt.orderId,
      attemptId: attempt.id,
      sellerId: awaId,
      country: "SN",
      grossMinor: 50000n,
      currency: "XOF"
    });
    await app.deps.ledger.recordRefund(transactionId, "test");
    expect(await app.deps.ledger.balance("seller", awaId, "XOF")).toBe(before);
  });

  it("INVARIANT: after 300 randomized orders (mixed methods, some refunds), Σall=0 and every txn balanced", async () => {
    const order = await anyPaidOrder();
    for (let i = 0; i < 300; i++) {
      const gross = BigInt(1000 + Math.floor(Math.random() * 500000));
      const attempt = await app.deps.prisma.paymentAttempt.create({
        data: {
          orderId: order.id,
          method: ["WAVE", "ORANGE_MONEY", "MTN_MOMO", "PI_SPI"][i % 4]!,
          status: "succeeded",
          idempotencyKey: `fuzz-${Date.now()}-${i}`,
          providerRef: `FUZZ-${Date.now()}-${i}`
        }
      });
      const country = (["SN", "CI", "BF"] as const)[i % 3]!;
      const { transactionId } = await app.deps.ledger.recordSale({
        orderId: order.id,
        attemptId: attempt.id,
        sellerId: awaId,
        country,
        grossMinor: gross,
        currency: "XOF"
      });
      if (i % 5 === 0) await app.deps.ledger.recordRefund(transactionId, "fuzz");
    }
    expect(await app.deps.ledger.globalSum()).toBe(0n);
    expect(await app.deps.ledger.unbalancedTransactions()).toEqual([]);
  }, 120000);
});

async function anyPaidOrder() {
  const existing = await app.deps.prisma.order.findFirst({ where: { status: "paid" } });
  if (existing) return existing;
  const shop = await app.deps.prisma.shop.findFirstOrThrow();
  return app.deps.prisma.order.create({
    data: {
      shopId: shop.id,
      status: "paid",
      subtotalMinor: 10000n,
      deliveryFeeMinor: 1000n,
      totalMinor: 11000n,
      currency: "XOF",
      deliveryPointSnapshot: {},
      idempotencyKey: `ledger-anchor-${Date.now()}`,
      trackingToken: `ledger-anchor-${Date.now()}`
    }
  });
}
