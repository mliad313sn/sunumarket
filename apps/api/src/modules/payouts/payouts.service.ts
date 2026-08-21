import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { AuthService } from "../auth/auth.service.js";
import type { KycService } from "../kyc/kyc.service.js";
import type { LedgerService } from "../ledger/ledger.service.js";
import type { MockPiSpiProvider } from "../payments/mock-provider.js";

export class PayoutError extends Error {
  constructor(
    public readonly code: "insufficient_balance" | "device_blocked" | "pin_required" | "rail_down" | "duplicate",
    message: string
  ) {
    super(message);
    this.name = "PayoutError";
  }
}

/**
 * Payouts — FR-20. PI-SPI first (instant, wallet-agnostic, near-zero cost),
 * aggregator payout as fallback; KYC tier limits; device cool-down gate;
 * optional payout PIN (DC-8.3).
 */
export class PayoutsService {
  /** Scoped dispute freeze (FR-40): injected to avoid a service cycle. */
  private frozenProvider: (sellerId: string) => Promise<bigint> = async () => 0n;

  setFrozenProvider(fn: (sellerId: string) => Promise<bigint>): void {
    this.frozenProvider = fn;
  }

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly kyc: KycService,
    private readonly auth: AuthService,
    private readonly piSpi: MockPiSpiProvider
  ) {}

  async requestPayout(
    sellerId: string,
    amountMinor: bigint,
    opts: { pin?: string | undefined; deviceHash: string; idempotencyKey: string }
  ) {
    const dup = await this.prisma.payout.findUnique({ where: { idempotencyKey: opts.idempotencyKey } });
    if (dup) return this.viewOf(dup);

    const gate = await this.auth.payoutAllowed(sellerId, opts.deviceHash);
    if (!gate.allowed) throw new PayoutError("device_blocked", gate.reason ?? "appareil bloqué");

    if (!(await this.auth.verifyPayoutPin(sellerId, opts.pin))) {
      throw new PayoutError("pin_required", "PIN de retrait incorrect");
    }

    await this.kyc.assertPayoutWithinLimit(sellerId, amountMinor);

    // Per-seller serialization: the advisory xact lock closes the double-spend
    // window between the balance-minus-frozen check and the ledger debit.
    const payout = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sellerId}))`;

      const balance = await this.ledger.balance("seller", sellerId, "XOF");
      const frozen = await this.frozenProvider(sellerId);
      if (balance - frozen < amountMinor) {
        throw new PayoutError(
          "insufficient_balance",
          frozen > 0n ? "solde bloqué par un litige en cours (gel ciblé)" : "solde insuffisant"
        );
      }

      // PI-SPI rail (FR-20). If the rail is down, NOTHING is settled and NOTHING
      // is debited — the caller gets a retriable rail_down error.
      const transfer = await this.piSpi.transfer(`seller:${sellerId}`, amountMinor, "payout");
      if (!transfer.ok) {
        throw new PayoutError("rail_down", "rail de paiement indisponible — réessayez dans quelques minutes");
      }

      const created = await tx.payout.create({
        data: {
          sellerId,
          amountMinor,
          currency: "XOF",
          rail: "PI_SPI",
          status: "settled", // instant in mock; real adapters transition async
          pinVerified: true,
          idempotencyKey: opts.idempotencyKey
        }
      });
      // Ledger debit commits before the advisory lock releases (own connection,
      // awaited inside the locked section) — the next holder sees the new balance.
      await this.ledger.recordPayout({ sellerId, amountMinor, currency: "XOF", rail: "PI_SPI", payoutId: created.id });
      return created;
    });
    return this.viewOf(payout);
  }

  async balanceView(sellerId: string, country: string) {
    const available = await this.ledger.balance("seller", sellerId, "XOF");
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: sellerId } });
    const tier = Math.min(Math.max(user.kycTier, 0), 2) as 0 | 1 | 2;
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const todays = await this.prisma.payout.aggregate({
      where: { sellerId, createdAt: { gte: startOfDay }, status: { notIn: ["failed"] } },
      _sum: { amountMinor: true }
    });
    const used = todays._sum.amountMinor ?? 0n;
    void country;
    return {
      available: { amount_minor: available.toString(), currency: "XOF" },
      pending: { amount_minor: "0", currency: "XOF" },
      payout_used_today: { amount_minor: used.toString(), currency: "XOF" },
      kyc_tier: tier
    };
  }

  private viewOf(p: { id: string; amountMinor: bigint; currency: string; rail: string; status: string; createdAt: Date }) {
    return {
      id: p.id,
      amount: { amount_minor: p.amountMinor.toString(), currency: p.currency },
      rail: p.rail,
      status: p.status,
      created_at: p.createdAt.toISOString()
    };
  }

  static newIdempotencyKey(): string {
    return `payout-${randomUUID()}`;
  }
}
