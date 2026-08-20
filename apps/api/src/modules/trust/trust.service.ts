import type { PrismaClient } from "@prisma/client";

export class TrustError extends Error {
  constructor(
    public readonly code: "not_found" | "not_delivered" | "already_rated" | "invalid_state" | "forbidden",
    message: string
  ) {
    super(message);
    this.name = "TrustError";
  }
}

export class TrustService {
  constructor(private readonly prisma: PrismaClient) {}

  /** FR-39: ratings unlock post-delivered; one per order per target (seller/rider/partner). */
  async rate(
    orderId: string,
    raterId: string | null,
    guestPhone: string | null,
    target: "seller" | "rider" | "partner",
    stars: number,
    comment?: string
  ) {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { job: true } });
    if (!["delivered", "completed"].includes(order.status)) {
      throw new TrustError("not_delivered", "notez après la livraison");
    }
    const owns = (raterId && order.buyerId === raterId) || (guestPhone && order.guestPhone === guestPhone);
    if (!owns) throw new TrustError("forbidden", "pas votre commande");
    if (target === "rider" && !order.job?.riderId) throw new TrustError("invalid_state", "pas de livreur sur cette commande");
    try {
      return await this.prisma.rating.create({
        data: { orderId, target, stars, comment: comment ?? null }
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw new TrustError("already_rated", "déjà noté");
      throw e;
    }
  }

  async shopRatingSummary(shopId: string) {
    const rows = await this.prisma.rating.findMany({
      where: { target: "seller", order: { shopId } },
      select: { stars: true }
    });
    const count = rows.length;
    const avg = count ? rows.reduce((s, r) => s + r.stars, 0) / count : null;
    return { count, average: avg };
  }

  /** FR-40: dispute with SCOPED payout freeze + auto-attached delivery proof. */
  async openDispute(orderId: string, raterId: string | null, guestPhone: string | null, reason: string) {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { job: true } });
    const owns = (raterId && order.buyerId === raterId) || (guestPhone && order.guestPhone === guestPhone);
    if (!owns) throw new TrustError("forbidden", "pas votre commande");
    if (["created", "payment_pending", "expired", "cancelled"].includes(order.status)) {
      throw new TrustError("invalid_state", "litige possible seulement après paiement");
    }
    return this.prisma.dispute.create({
      data: {
        orderId,
        reason,
        payoutFrozen: true,
        evidence: {
          delivery_proof: (order.job?.proof as object) ?? null,
          job_status: order.job?.status ?? null,
          auto_attached: true
        }
      }
    });
  }

  /** Scoped freeze: the disputed orders' totals are unavailable for payout. */
  async frozenAmountFor(sellerId: string): Promise<bigint> {
    const disputes = await this.prisma.dispute.findMany({
      where: { status: "open", payoutFrozen: true, order: { shop: { sellerId } } },
      include: { order: true }
    });
    return disputes.reduce((s, d) => s + d.order.totalMinor, 0n);
  }

  async resolveDispute(disputeId: string, resolution: "refund" | "reject") {
    const dispute = await this.prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } });
    if (dispute.status !== "open") throw new TrustError("invalid_state", "litige déjà résolu");
    return this.prisma.dispute.update({
      where: { id: disputeId },
      data: {
        status: resolution === "refund" ? "resolved_refund" : "resolved_reject",
        payoutFrozen: false,
        resolvedAt: new Date()
      }
    });
  }

  /** FR-41: reports/takedowns — anyone can report products, shops, riders, partners. */
  async report(kind: "product" | "shop" | "rider" | "partner", targetId: string, reason: string, reporterId: string | null) {
    return this.prisma.auditLog.create({
      data: {
        actorId: reporterId,
        action: `report:${kind}`,
        detail: { target_id: targetId, reason }
      }
    });
  }

  async takedownProduct(productId: string, adminId: string, reason: string) {
    await this.prisma.product.update({ where: { id: productId }, data: { status: "archived" } });
    await this.prisma.auditLog.create({
      data: { actorId: adminId, action: "takedown:product", detail: { product_id: productId, reason } }
    });
  }
}
