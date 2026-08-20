import type { PrismaClient } from "@prisma/client";
import { matchSettlement, type InternalPayment, type SettlementLineIn } from "@sunumarket/shared";

/**
 * Settlement reconciliation — FR-19b. Ingest provider settlement reports (CSV),
 * run the shared matcher, persist write-once matches and flags with aging,
 * produce the month-end close report.
 *
 * CSV format (fixtures for both mock aggregators + PI-SPI):
 *   provider_ref,amount_minor,fee_minor,currency
 */
export class ReconciliationService {
  constructor(private readonly prisma: PrismaClient) {}

  async ingestCsv(providerCode: string, settlementDate: string, sourceFile: string, csv: string) {
    const provider = await this.prisma.paymentProvider.findUniqueOrThrow({ where: { code: providerCode } });
    const batch = await this.prisma.settlementBatch.create({
      data: { providerId: provider.id, settlementDate: new Date(settlementDate), sourceFile }
    });
    const lines = csv
      .trim()
      .split("\n")
      .filter((l) => l && !l.startsWith("provider_ref"));
    for (const l of lines) {
      const [ref, amount, fee, currency] = l.split(",").map((s) => s.trim());
      await this.prisma.settlementLine.create({
        data: {
          batchId: batch.id,
          providerRef: ref!,
          amountMinor: BigInt(amount!),
          feeMinor: BigInt(fee ?? "0"),
          currency: currency ?? "XOF"
        }
      });
    }
    return batch;
  }

  /** Run the matcher for a batch; write-once match columns; open flags with aging clock. */
  async runMatch(batchId: string): Promise<{ matched: number; flags: number }> {
    const batch = await this.prisma.settlementBatch.findUniqueOrThrow({
      where: { id: batchId },
      include: { lines: true, provider: true }
    });

    const lineIn: SettlementLineIn[] = batch.lines
      .filter((l) => l.matchKind === "unmatched")
      .map((l) => ({
        lineId: l.id,
        providerRef: l.providerRef,
        amountMinor: l.amountMinor,
        currency: l.currency,
        settlementDate: batch.settlementDate.toISOString().slice(0, 10)
      }));

    // Internal view: succeeded attempts served by this provider that have a ledger txn.
    const attempts = await this.prisma.paymentAttempt.findMany({
      where: {
        providerId: batch.providerId,
        status: { in: ["succeeded", "succeeded_late"] },
        transaction: { isNot: null }
      },
      include: { transaction: true, order: true }
    });
    const payments: InternalPayment[] = attempts.map((a) => ({
      transactionId: a.transaction!.id,
      providerRef: a.providerRef ?? "",
      amountMinor: a.order.totalMinor,
      currency: a.order.currency,
      paidDate: a.updatedAt.toISOString().slice(0, 10)
    }));

    const { matches, flags } = matchSettlement(lineIn, payments);

    for (const m of matches) {
      await this.prisma.settlementLine.update({
        where: { id: m.lineId },
        data: { matchKind: m.kind, matchedTransactionId: m.transactionId }
      });
    }
    for (const f of flags) {
      if (f.kind === "unmatched_line" || f.kind === "amount_mismatch") {
        await this.prisma.reconciliationFlag.create({
          data: { settlementLineId: f.lineId, kind: f.kind }
        });
      } else {
        // missing_order: locate the order for context via the ledger transaction
        const attempt = attempts.find((a) => a.transaction!.id === f.transactionId);
        await this.prisma.reconciliationFlag.create({
          data: { orderId: attempt?.orderId ?? null, kind: f.kind }
        });
      }
    }
    await this.prisma.settlementBatch.update({ where: { id: batchId }, data: { status: "matched" } });
    return { matched: matches.length, flags: flags.length };
  }

  /** Admin queue with aging buckets (24 h / 72 h / 7 d) — KPI: cleared < 72 h. */
  async flagQueue() {
    const flags = await this.prisma.reconciliationFlag.findMany({
      where: { status: "open" },
      orderBy: { openedAt: "asc" },
      include: { settlementLine: true }
    });
    const now = Date.now();
    return flags.map((f) => {
      const ageH = (now - f.openedAt.getTime()) / 3_600_000;
      return {
        id: f.id,
        kind: f.kind,
        order_id: f.orderId,
        settlement_line: f.settlementLine
          ? { provider_ref: f.settlementLine.providerRef, amount_minor: f.settlementLine.amountMinor.toString() }
          : null,
        opened_at: f.openedAt.toISOString(),
        aging_bucket: ageH < 24 ? "<24h" : ageH < 72 ? "24-72h" : ageH < 168 ? "72h-7d" : ">7d"
      };
    });
  }

  async resolveFlag(id: string): Promise<void> {
    await this.prisma.reconciliationFlag.update({
      where: { id },
      data: { status: "resolved", resolvedAt: new Date() }
    });
  }

  /** Month-end close: totals per provider, matched %, open flags (FR-19b). */
  async closeReport(month: string) {
    const start = new Date(`${month}-01`);
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);
    const batches = await this.prisma.settlementBatch.findMany({
      where: { settlementDate: { gte: start, lt: end } },
      include: { lines: true, provider: true }
    });
    const perProvider = new Map<string, { gross: bigint; fees: bigint; lines: number; matched: number }>();
    for (const b of batches) {
      const key = b.provider.code;
      const acc = perProvider.get(key) ?? { gross: 0n, fees: 0n, lines: 0, matched: 0 };
      for (const l of b.lines) {
        acc.gross += l.amountMinor;
        acc.fees += l.feeMinor;
        acc.lines += 1;
        if (l.matchKind !== "unmatched") acc.matched += 1;
      }
      perProvider.set(key, acc);
    }
    const openFlags = await this.prisma.reconciliationFlag.count({ where: { status: "open" } });
    return {
      month,
      providers: [...perProvider.entries()].map(([code, v]) => ({
        provider: code,
        gross_minor: v.gross.toString(),
        fees_minor: v.fees.toString(),
        lines: v.lines,
        matched: v.matched,
        matched_pct: v.lines ? Math.round((v.matched / v.lines) * 100) : 100
      })),
      open_flags: openFlags
    };
  }
}
