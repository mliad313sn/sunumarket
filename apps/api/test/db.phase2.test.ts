import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

// Phase 2 gate tests — require a migrated+seeded Postgres (local sandbox or CI services).
// Skipped when DATABASE_URL is absent so pure-unit runs stay infra-free (ADR-0004).
const url = process.env.DATABASE_URL;
const d = describe.skipIf(!url);

const prisma = new PrismaClient();

beforeAll(async () => {
  if (url) await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

d("phase 2 — immutability triggers", () => {
  it("ledger_entries rejects UPDATE and DELETE", async () => {
    const account = await prisma.ledgerAccount.upsert({
      where: { ownerType_ownerId_currency: { ownerType: "platform", ownerId: null as unknown as string, currency: "XOF" } },
      update: {},
      create: { ownerType: "platform", currency: "XOF" }
    }).catch(async () => {
      // composite unique with nullable ownerId can miss on upsert — fall back to find/create
      const found = await prisma.ledgerAccount.findFirst({ where: { ownerType: "platform", ownerId: null, currency: "XOF" } });
      return found ?? prisma.ledgerAccount.create({ data: { ownerType: "platform", currency: "XOF" } });
    });
    const txn = await prisma.ledgerTransaction.create({ data: { kind: "adjustment" } });
    const entry1 = await prisma.ledgerEntry.create({
      data: { transactionId: txn.id, accountId: account.id, amountMinor: 500n, currency: "XOF", leg: "gross" }
    });
    const entry2 = await prisma.ledgerEntry.create({
      data: { transactionId: txn.id, accountId: account.id, amountMinor: -500n, currency: "XOF", leg: "net" }
    });

    await expect(
      prisma.ledgerEntry.update({ where: { id: entry1.id }, data: { amountMinor: 999n } })
    ).rejects.toThrow(/append-only/);
    await expect(prisma.ledgerEntry.delete({ where: { id: entry2.id } })).rejects.toThrow(/append-only/);
  });

  it("ledger_entries rejects zero amounts (check constraint)", async () => {
    const account = await prisma.ledgerAccount.findFirstOrThrow({ where: { ownerType: "platform" } });
    const txn = await prisma.ledgerTransaction.create({ data: { kind: "adjustment" } });
    await expect(
      prisma.ledgerEntry.create({
        data: { transactionId: txn.id, accountId: account.id, amountMinor: 0n, currency: "XOF", leg: "gross" }
      })
    ).rejects.toThrow();
  });

  it("rider_cash_ledger rejects mutation", async () => {
    const rider = await prisma.rider.findFirstOrThrow();
    const row = await prisma.riderCashLedger.create({
      data: { riderId: rider.userId, amountMinor: 45000n, currency: "XOF", kind: "cod_collected" }
    });
    // keep the COD cache invariant honest (this test writes the ledger directly)
    const sum = await prisma.riderCashLedger.aggregate({ where: { riderId: rider.userId }, _sum: { amountMinor: true } });
    await prisma.rider.update({
      where: { userId: rider.userId },
      data: { codOutstandingMinor: sum._sum.amountMinor ?? 0n }
    });
    await expect(
      prisma.riderCashLedger.update({ where: { id: row.id }, data: { amountMinor: 1n } })
    ).rejects.toThrow(/append-only/);
    await expect(prisma.riderCashLedger.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
  });

  it("settlement_lines: match columns write-once, financial columns immutable", async () => {
    const provider = await prisma.paymentProvider.findFirstOrThrow({ where: { code: "AGG_A" } });
    const batch = await prisma.settlementBatch.create({
      data: {
        providerId: provider.id,
        settlementDate: new Date("2026-08-20"),
        sourceFile: `test-${Date.now()}.csv`
      }
    });
    const line = await prisma.settlementLine.create({
      data: { batchId: batch.id, providerRef: "REF-1", amountMinor: 15000n, currency: "XOF" }
    });
    const txn = await prisma.ledgerTransaction.create({ data: { kind: "sale" } });

    // first match: allowed
    await prisma.settlementLine.update({
      where: { id: line.id },
      data: { matchKind: "exact", matchedTransactionId: txn.id }
    });
    // re-match: rejected
    await expect(
      prisma.settlementLine.update({ where: { id: line.id }, data: { matchKind: "fuzzy" } })
    ).rejects.toThrow(/write-once/);
    // amount tamper: rejected
    await expect(
      prisma.settlementLine.update({ where: { id: line.id }, data: { amountMinor: 1n } })
    ).rejects.toThrow(/immutable/);
    await expect(prisma.settlementLine.delete({ where: { id: line.id } })).rejects.toThrow(/append-only/);
  });

  it("fraud_events: only review_status may change", async () => {
    const ev = await prisma.fraudEvent.create({
      data: { kind: "velocity_failed_payments", detail: { n: 10 } }
    });
    await prisma.fraudEvent.update({ where: { id: ev.id }, data: { reviewStatus: "cleared" } });
    await expect(
      prisma.fraudEvent.update({ where: { id: ev.id }, data: { kind: "other" } })
    ).rejects.toThrow(/immutable/);
    await expect(prisma.fraudEvent.delete({ where: { id: ev.id } })).rejects.toThrow(/append-only/);
  });
});

d("phase 2 — PostGIS point-in-polygon (fee engine substrate)", () => {
  it("Yao's Abidjan pin falls in exactly the Plateau-Cocody zone", async () => {
    const rows = await prisma.$queryRaw<Array<{ name: string; fee_minor: bigint }>>`
      SELECT z.name, z.fee_minor FROM zones z
      WHERE ST_Contains(z.polygon, ST_SetSRID(ST_MakePoint(-4.0, 5.33), 4326))`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Plateau-Cocody");
    expect(rows[0]!.fee_minor).toBe(1000n);
  });

  it("an out-of-zone point matches nothing", async () => {
    const rows = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM zones
      WHERE ST_Contains(polygon, ST_SetSRID(ST_MakePoint(2.35, 48.85), 4326))`;
    expect(rows).toHaveLength(0);
  });

  it("seeded delivery points round-trip lat/lng", async () => {
    const rows = await prisma.$queryRaw<Array<{ landmark: string; lng: number; lat: number }>>`
      SELECT landmark, ST_X(point) as lng, ST_Y(point) as lat FROM delivery_points`;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const yao = rows.find((r) => r.landmark.includes("pharmacie"));
    expect(yao?.lng).toBeCloseTo(-4.0, 5);
    expect(yao?.lat).toBeCloseTo(5.33, 5);
  });
});

d("phase 2 — money through the DB (DC-5)", () => {
  it("bigint minor units survive write/read without precision loss", async () => {
    const shop = await prisma.shop.findFirstOrThrow();
    const big = 9007199254740993n; // > Number.MAX_SAFE_INTEGER
    const p = await prisma.product.create({
      data: { shopId: shop.id, title: "money-precision-test", priceMinor: big, currency: "XOF", stock: 1 }
    });
    const back = await prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(back.priceMinor).toBe(big);
    await prisma.product.delete({ where: { id: p.id } });
  });

  it("country pack records were seeded for all 7 countries, 3 active", async () => {
    expect(await prisma.countryPackRecord.count()).toBe(7);
    expect(await prisma.countryPackRecord.count({ where: { active: true } })).toBe(3);
  });
});
