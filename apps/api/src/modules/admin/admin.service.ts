import type { PrismaClient } from "@prisma/client";
import type { PackRegistry } from "@sunumarket/config";

/** Admin console backend — FR-42..44b. Every mutating action lands in audit_log. */
export class AdminService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly packs: PackRegistry
  ) {}

  private async audit(actorId: string, action: string, detail: Record<string, unknown>) {
    await this.prisma.auditLog.create({ data: { actorId, action, detail: detail as object } });
  }

  async dashboard() {
    const [users, shops, orders, paid, disputes, fraudOpen, reconOpen] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.shop.count(),
      this.prisma.order.count(),
      this.prisma.order.count({ where: { status: { in: ["paid", "preparing", "in_delivery", "delivered", "completed"] } } }),
      this.prisma.dispute.count({ where: { status: "open" } }),
      this.prisma.fraudEvent.count({ where: { reviewStatus: "open" } }),
      this.prisma.reconciliationFlag.count({ where: { status: "open" } })
    ]);
    return { users, shops, orders, paid_orders: paid, open_disputes: disputes, open_fraud: fraudOpen, open_reconciliation: reconOpen };
  }

  /** FR-43: global phone search across users, orders (guest), shops. */
  async phoneSearch(phone: string) {
    const [users, guestOrders] = await Promise.all([
      this.prisma.user.findMany({
        where: { phone: { contains: phone } },
        select: { id: true, phone: true, name: true, roles: true, kycTier: true, country: true },
        take: 20
      }),
      this.prisma.order.findMany({
        where: { guestPhone: { contains: phone } },
        select: { id: true, guestPhone: true, status: true, totalMinor: true, currency: true, createdAt: true },
        take: 20
      })
    ]);
    return {
      users,
      guest_orders: guestOrders.map((o) => ({
        ...o,
        totalMinor: o.totalMinor.toString()
      }))
    };
  }

  /** Order timeline: statuses, attempts, job events (map preview = GPS snapshots). */
  async orderTimeline(orderId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: true,
        attempts: { include: { provider: true }, orderBy: { createdAt: "asc" } },
        job: { include: { events: { orderBy: { at: "asc" } } } },
        dispute: true
      }
    });
    const gps = await this.prisma.$queryRaw<Array<{ status: string; lng: number | null; lat: number | null; at: Date }>>`
      SELECT status, ST_X(gps) as lng, ST_Y(gps) as lat, at FROM job_events
      WHERE job_id = (SELECT id FROM delivery_jobs WHERE order_id = ${orderId}::uuid)
      ORDER BY at ASC`;
    return {
      order: {
        id: order.id,
        status: order.status,
        total: { amount_minor: order.totalMinor.toString(), currency: order.currency },
        delivery_point: order.deliveryPointSnapshot,
        created_at: order.createdAt.toISOString()
      },
      attempts: order.attempts.map((a) => ({
        method: a.method,
        status: a.status,
        provider: a.provider?.code ?? null,
        failure_reason: a.failureReason,
        at: a.createdAt.toISOString()
      })),
      delivery: order.job
        ? { mode: order.job.mode, status: order.job.status, cod: order.job.cod, gps_trace: gps }
        : null,
      dispute: order.dispute
    };
  }

  /** FR-44b config panels — all runtime, no deploy. */
  async configView() {
    return {
      countries: this.packs.list(true).map((p) => ({
        country: p.country,
        status: p.status,
        version: p.version,
        methods: this.packs.enabledMethods(p.country).map((m) => m.type),
        routes: p.provider_routes,
        kyc_tiers: p.kyc_tiers,
        fees: p.fees_taxes.pass_through
      }))
    };
  }

  async toggleMethod(adminId: string, country: string, method: string, enabled: boolean) {
    this.packs.setMethodOverride(country, method, enabled);
    await this.audit(adminId, "config:method_toggle", { country, method, enabled });
  }

  async flipRoute(adminId: string, country: string, method: string, primary: string, fallback: string | null) {
    this.packs.setRouteOverride(country, method, primary, fallback);
    await this.audit(adminId, "config:route_flip", { country, method, primary, fallback });
  }

  async reloadPacks(adminId: string) {
    this.packs.reload();
    await this.audit(adminId, "config:packs_reload", {});
  }

  async auditTrail(limit = 50) {
    return this.prisma.auditLog.findMany({ orderBy: { at: "desc" }, take: limit });
  }
}
