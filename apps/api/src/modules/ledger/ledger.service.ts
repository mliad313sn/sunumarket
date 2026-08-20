import type { Prisma, PrismaClient } from "@prisma/client";
import type { PackRegistry } from "@sunumarket/config";
import { percentBps, money } from "@sunumarket/shared";

/**
 * Double-entry ledger — FR-19 / DC-11. Multi-currency-ready: every entry carries
 * bigint minor units + ISO code; Σ(entries) per transaction must be 0 per currency
 * (enforced here AND provable via DB aggregate; entries are append-only at the DB).
 *
 * Convention: positive amount = credit to the account, negative = debit.
 * The buyer_funds account is the external source: a sale debits it by gross.
 */
export interface EntrySpec {
  ownerType: "platform" | "seller" | "rider" | "provider" | "buyer_funds" | "tax_authority";
  ownerId?: string | null;
  amountMinor: bigint;
  currency: string;
  leg: "gross" | "provider_fee" | "tax" | "net" | "platform_fee" | "cod_cash" | "payout" | "refund";
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export class LedgerService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly packs: PackRegistry
  ) {}

  private async account(
    tx: Prisma.TransactionClient,
    ownerType: string,
    ownerId: string | null,
    currency: string
  ) {
    const found = await tx.ledgerAccount.findFirst({ where: { ownerType, ownerId, currency } });
    if (found) return found;
    try {
      return await tx.ledgerAccount.create({ data: { ownerType, ownerId, currency } });
    } catch (e) {
      // Concurrent create for the same account — the loser reuses the winner's row.
      if ((e as { code?: string }).code === "P2002") {
        const winner = await tx.ledgerAccount.findFirst({ where: { ownerType, ownerId, currency } });
        if (winner) return winner;
      }
      throw e;
    }
  }

  /** Core posting primitive: balanced or rejected. */
  async post(
    kind: string,
    entries: EntrySpec[],
    opts: { attemptId?: string; sourceRef?: string } = {}
  ): Promise<{ transactionId: string }> {
    if (entries.length < 2) throw new LedgerError("a transaction needs at least 2 entries");
    const sums = new Map<string, bigint>();
    for (const e of entries) {
      if (e.amountMinor === 0n) throw new LedgerError("zero-amount entry");
      sums.set(e.currency, (sums.get(e.currency) ?? 0n) + e.amountMinor);
    }
    for (const [ccy, sum] of sums) {
      if (sum !== 0n) throw new LedgerError(`unbalanced transaction: ${ccy} Σ=${sum}`);
    }

    return this.prisma.$transaction(async (tx) => {
      const txn = await tx.ledgerTransaction.create({
        data: {
          kind,
          attemptId: opts.attemptId ?? null,
          sourceRef: opts.sourceRef ?? null
        }
      });
      for (const e of entries) {
        const account = await this.account(tx, e.ownerType, e.ownerId ?? null, e.currency);
        await tx.ledgerEntry.create({
          data: {
            transactionId: txn.id,
            accountId: account.id,
            amountMinor: e.amountMinor,
            currency: e.currency,
            leg: e.leg
          }
        });
      }
      return { transactionId: txn.id };
    });
  }

  /**
   * Sale split per pack fee config (DC-11): gross → provider fee + platform fee
   * (+ buyer-borne tax) + seller net. Manual transfers pass fees=0 (money went
   * seller-direct).
   */
  async recordSale(input: {
    orderId: string;
    attemptId: string;
    sellerId: string;
    country: string;
    grossMinor: bigint;
    currency: string;
    direct?: boolean;
  }): Promise<{ transactionId: string; netMinor: bigint }> {
    const gross = money(input.grossMinor, input.currency as never);
    const pass = input.direct ? [] : this.packs.get(input.country).fees_taxes.pass_through;
    let providerFee = 0n;
    let platformFee = 0n;
    let tax = 0n;
    for (const f of pass) {
      const part = f.bps ? percentBps(gross, BigInt(f.bps)).amountMinor : BigInt(f.flat_minor ?? "0");
      if (f.kind === "provider_fee") providerFee += part;
      else if (f.kind === "platform_fee") platformFee += part;
      else if (f.kind === "mm_transaction_tax") tax += part;
    }
    const net = input.grossMinor - providerFee - platformFee - tax;
    if (net <= 0n) throw new LedgerError("net would be non-positive");

    const entries: EntrySpec[] = [
      { ownerType: "buyer_funds", amountMinor: -input.grossMinor, currency: input.currency, leg: "gross" },
      { ownerType: "seller", ownerId: input.sellerId, amountMinor: net, currency: input.currency, leg: "net" }
    ];
    if (providerFee > 0n) entries.push({ ownerType: "provider", amountMinor: providerFee, currency: input.currency, leg: "provider_fee" });
    if (platformFee > 0n) entries.push({ ownerType: "platform", amountMinor: platformFee, currency: input.currency, leg: "platform_fee" });
    if (tax > 0n) entries.push({ ownerType: "tax_authority", amountMinor: tax, currency: input.currency, leg: "tax" });

    const { transactionId } = await this.post("sale", entries, { attemptId: input.attemptId, sourceRef: input.orderId });
    return { transactionId, netMinor: net };
  }

  /** Full refund reverses the sale split (FR-18); PI-SPI reverse transfer upstream. */
  async recordRefund(saleTransactionId: string, reason: string): Promise<{ transactionId: string }> {
    const sale = await this.prisma.ledgerTransaction.findUniqueOrThrow({
      where: { id: saleTransactionId },
      include: { entries: { include: { account: true } } }
    });
    const entries: EntrySpec[] = sale.entries.map((e) => ({
      ownerType: e.account.ownerType as EntrySpec["ownerType"],
      ownerId: e.account.ownerId,
      amountMinor: -e.amountMinor,
      currency: e.currency,
      leg: "refund"
    }));
    return this.post("refund", entries, { sourceRef: `refund:${reason}:${saleTransactionId}` });
  }

  async recordPayout(input: {
    sellerId: string;
    amountMinor: bigint;
    currency: string;
    rail: string;
    payoutId: string;
  }): Promise<{ transactionId: string }> {
    return this.post(
      "payout",
      [
        { ownerType: "seller", ownerId: input.sellerId, amountMinor: -input.amountMinor, currency: input.currency, leg: "payout" },
        { ownerType: "buyer_funds", amountMinor: input.amountMinor, currency: input.currency, leg: "payout" }
      ],
      { sourceRef: `payout:${input.rail}:${input.payoutId}` }
    );
  }

  /** Available balance = Σ of the owner's account entries. */
  async balance(ownerType: string, ownerId: string, currency: string): Promise<bigint> {
    const account = await this.prisma.ledgerAccount.findFirst({ where: { ownerType, ownerId, currency } });
    if (!account) return 0n;
    const agg = await this.prisma.ledgerEntry.aggregate({
      where: { accountId: account.id },
      _sum: { amountMinor: true }
    });
    return agg._sum.amountMinor ?? 0n;
  }

  /** Global invariant: Σ of ALL entries — must always be exactly 0. */
  async globalSum(): Promise<bigint> {
    const agg = await this.prisma.ledgerEntry.aggregate({ _sum: { amountMinor: true } });
    return agg._sum.amountMinor ?? 0n;
  }

  /** Per-transaction invariant probe (for tests): transactions whose entries don't sum to 0. */
  async unbalancedTransactions(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ transaction_id: string }>>`
      SELECT transaction_id FROM ledger_entries
      GROUP BY transaction_id, currency HAVING SUM(amount_minor) <> 0`;
    return rows.map((r) => r.transaction_id);
  }
}
