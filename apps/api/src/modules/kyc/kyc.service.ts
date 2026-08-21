import type { PrismaClient } from "@prisma/client";
import type { PackRegistry } from "@sunumarket/config";

export class KycError extends Error {
  constructor(
    public readonly code: "limit_exceeded" | "invalid_tier" | "pending_review",
    message: string,
    /** DC-13: blocked actions always carry the upgrade path, never a dead end. */
    public readonly upgradePath?: { targetTier: number; how: string }
  ) {
    super(message);
    this.name = "KycError";
  }
}

export class KycService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly packs: PackRegistry
  ) {}

  async requestUpgrade(
    userId: string,
    targetTier: 1 | 2,
    documents: Record<string, string>
  ): Promise<{ id: string; status: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (targetTier <= user.kycTier) throw new KycError("invalid_tier", "palier déjà atteint");
    const pending = await this.prisma.kycRecord.findFirst({
      where: { userId, status: "pending" }
    });
    if (pending) throw new KycError("pending_review", "demande déjà en cours d'examen");
    const rec = await this.prisma.kycRecord.create({
      data: { userId, tier: targetTier, documents: documents as object }
    });
    return { id: rec.id, status: rec.status };
  }

  /** Admin review queue (Phase 10 UI reads this). */
  async reviewQueue() {
    return this.prisma.kycRecord.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      include: { user: { select: { phone: true, country: true, kycTier: true } } }
    });
  }

  async decide(recordId: string, approve: boolean, actorId: string | null = null): Promise<void> {
    const rec = await this.prisma.kycRecord.findUniqueOrThrow({ where: { id: recordId } });
    await this.prisma.kycRecord.update({
      where: { id: recordId },
      data: { status: approve ? "approved" : "rejected", reviewedAt: new Date() }
    });
    if (approve) {
      await this.prisma.user.update({ where: { id: rec.userId }, data: { kycTier: rec.tier } });
    }
    await this.prisma.auditLog.create({
      data: {
        actorId,
        action: "kyc:decision",
        detail: { record_id: recordId, user_id: rec.userId, tier: rec.tier, outcome: approve ? "approved" : "rejected" }
      }
    });
  }

  /**
   * Tier limit enforcement at the transaction edge (DC-13).
   * Throws with an explicit upgrade path when the amount exceeds the pack limit.
   */
  async assertPayoutWithinLimit(userId: string, amountMinor: bigint, now = new Date()): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const tier = Math.min(Math.max(user.kycTier, 0), 2) as 0 | 1 | 2;
    const limit = this.packs.kycLimit(user.country, tier).payoutDailyMinor;

    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const today = await this.prisma.payout.aggregate({
      where: { sellerId: userId, createdAt: { gte: startOfDay }, status: { notIn: ["failed"] } },
      _sum: { amountMinor: true }
    });
    const used = today._sum.amountMinor ?? 0n;

    if (used + amountMinor > limit) {
      throw new KycError(
        "limit_exceeded",
        `plafond de retrait quotidien atteint (palier ${tier})`,
        tier < 2
          ? { targetTier: tier + 1, how: "ajoutez une pièce d'identité dans Profil → Vérification" }
          : undefined
      );
    }
  }

  async assertCodWithinLimit(riderId: string, additionalMinor: bigint): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: riderId } });
    const tier = Math.min(Math.max(user.kycTier, 0), 2) as 0 | 1 | 2;
    const cap = this.packs.kycLimit(user.country, tier).codOutstandingMinor;
    const ledger = await this.prisma.riderCashLedger.aggregate({
      where: { riderId },
      _sum: { amountMinor: true }
    });
    const outstanding = ledger._sum.amountMinor ?? 0n;
    if (outstanding + additionalMinor > cap) {
      throw new KycError(
        "limit_exceeded",
        `plafond d'encaissement COD atteint (palier ${tier})`,
        tier < 2 ? { targetTier: tier + 1, how: "complétez la vérification livreur (pièce + véhicule)" } : undefined
      );
    }
  }
}
