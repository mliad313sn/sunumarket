import type { PrismaClient } from "@prisma/client";
import { TERMINAL_STATUSES, truncateCoordinates } from "@sunumarket/shared";

/**
 * Anonymizing account delete (FR-25 adjunct; BACKLOG privacy item).
 *
 * Hard delete is impossible by design: fraud_events / audit_log are append-only
 * (DB immutability triggers) and financial rows must survive for the books. So
 * "delete" = scrub every personal identifier while keeping the anonymous skeleton:
 *  - user row tombstoned (`deleted:<id>` phone — fails every pack phone regex, so
 *    it can never receive an OTP or collide with a real number), name/PIN/roles wiped;
 *  - all sessions dead (device bindings removed, refresh tokens revoked);
 *  - KYC document keys scrubbed (tier decision itself is kept for audit);
 *  - saved delivery points label/landmark-wiped + coordinate-truncated immediately
 *    (same truncation as the FR-25 retention sweep, just not waiting for it);
 *  - terminal orders keep their money columns but lose the GPS/landmark snapshot;
 *  - sms_outbox history re-pointed at the tombstone; pending sends cancelled;
 *  - one append-only audit_log row records that the deletion happened.
 *
 * Refused (409) while money or dispatch still depends on the account:
 * non-terminal orders (as buyer or on own shops), outstanding rider COD or open
 * jobs, or a non-zero ledger balance (withdraw first).
 */
export class PrivacyError extends Error {
  constructor(
    public readonly code: "active_orders" | "cod_outstanding" | "ledger_balance",
    message: string
  ) {
    super(message);
    this.name = "PrivacyError";
  }
}

const JOB_TERMINAL = ["delivered", "cancelled"];

export class PrivacyService {
  constructor(private readonly prisma: PrismaClient) {}

  async anonymizeAccount(userId: string): Promise<{ anonymized: true }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    // Guard 1 — live commerce: no non-terminal order may lose its buyer or seller.
    const activeOrders = await this.prisma.order.count({
      where: {
        status: { notIn: [...TERMINAL_STATUSES] },
        OR: [{ buyerId: userId }, { shop: { sellerId: userId } }]
      }
    });
    if (activeOrders > 0) {
      throw new PrivacyError("active_orders", "commandes en cours — terminez-les ou annulez-les d'abord");
    }

    // Guard 2 — Moussa's pocket: a rider carrying COD cash or an open job stays accountable.
    const rider = await this.prisma.rider.findUnique({ where: { userId } });
    if (rider) {
      const agg = await this.prisma.riderCashLedger.aggregate({
        where: { riderId: userId },
        _sum: { amountMinor: true }
      });
      const outstanding = agg._sum.amountMinor ?? 0n;
      const openJobs = await this.prisma.deliveryJob.count({
        where: { riderId: userId, status: { notIn: JOB_TERMINAL } }
      });
      if (outstanding !== 0n || openJobs > 0) {
        throw new PrivacyError("cod_outstanding", "solde COD à remettre ou course en cours — régularisez d'abord");
      }
    }

    // Guard 3 — the ledger: every account owned by the user must be at zero.
    const accounts = await this.prisma.ledgerAccount.findMany({ where: { ownerId: userId } });
    for (const account of accounts) {
      const agg = await this.prisma.ledgerEntry.aggregate({
        where: { accountId: account.id },
        _sum: { amountMinor: true }
      });
      if ((agg._sum.amountMinor ?? 0n) !== 0n) {
        throw new PrivacyError("ledger_balance", "solde non nul — demandez un retrait d'abord");
      }
    }

    const tombstone = `deleted:${userId}`;

    // Saved pins: wipe label/landmark and truncate coordinates now (FR-25, not waiting
    // for the retention sweep). truncate_after=NULL so the sweep never re-processes.
    const points = await this.prisma.$queryRaw<Array<{ id: string; lng: number; lat: number }>>`
      SELECT id, ST_X(point) AS lng, ST_Y(point) AS lat
      FROM delivery_points WHERE owner_id = ${userId}::uuid`;
    for (const p of points) {
      const t = truncateCoordinates({ lng: p.lng, lat: p.lat });
      await this.prisma.$executeRaw`
        UPDATE delivery_points
        SET label = NULL, landmark = '[supprimé]',
            point = ST_SetSRID(ST_MakePoint(${t.lng}, ${t.lat}), 4326),
            truncate_after = NULL
        WHERE id = ${p.id}::uuid`;
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { phone: tombstone, name: null, payoutPinHash: null, roles: [] }
      }),
      this.prisma.deviceBinding.deleteMany({ where: { userId } }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() }
      }),
      this.prisma.otpCode.deleteMany({ where: { phone: user.phone } }),
      this.prisma.kycRecord.updateMany({ where: { userId }, data: { documents: {} } }),
      // Terminal orders stay for the books; their GPS/landmark snapshot does not.
      this.prisma.order.updateMany({
        where: { buyerId: userId },
        data: { deliveryPointSnapshot: { anonymized: true } }
      }),
      // Cancel pending sends first, then re-point the whole SMS history at the tombstone.
      this.prisma.smsOutbox.updateMany({
        where: { phone: user.phone, status: "queued" },
        data: { status: "failed" }
      }),
      this.prisma.smsOutbox.updateMany({ where: { phone: user.phone }, data: { phone: tombstone } }),
      this.prisma.auditLog.create({
        data: { actorId: userId, action: "privacy_delete", detail: { anonymized: true } }
      })
    ]);

    return { anonymized: true };
  }
}
