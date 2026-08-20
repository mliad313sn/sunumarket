import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../../deps.js";
import { requireRoles } from "../auth/rbac.js";
import { TrustError } from "./trust.service.js";

const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  not_delivered: 409,
  already_rated: 409,
  invalid_state: 409,
  forbidden: 403
};

export function registerTrustRoutes(app: FastifyInstance, deps: AppDeps): void {
  const guard = async (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof TrustError) return reply.code(ERROR_STATUS[e.code] ?? 400).send({ code: e.code, message: e.message });
      throw e;
    }
  };

  const identity = async (req: { jwtVerify: () => Promise<unknown>; user?: { sub: string }; body: unknown }) => {
    try {
      await req.jwtVerify();
      return { userId: req.user?.sub ?? null, guestPhone: null };
    } catch {
      const { guest_phone } = (req.body ?? {}) as { guest_phone?: string };
      return { userId: null, guestPhone: guest_phone ?? null };
    }
  };

  app.post("/orders/:id/ratings", async (req, reply) =>
    guard(reply, async () => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          target: z.enum(["seller", "rider", "partner"]),
          stars: z.number().int().min(1).max(5),
          comment: z.string().max(500).optional(),
          guest_phone: z.string().optional()
        })
        .parse(req.body);
      const who = await identity(req);
      const rating = await deps.trust.rate(id, who.userId, who.guestPhone, body.target, body.stars, body.comment);
      return reply.code(201).send({ id: rating.id });
    })
  );

  app.get("/shops/:id/ratings", async (req) =>
    deps.trust.shopRatingSummary((req.params as { id: string }).id)
  );

  app.post("/orders/:id/disputes", async (req, reply) =>
    guard(reply, async () => {
      const { id } = req.params as { id: string };
      const body = z.object({ reason: z.string().min(5), guest_phone: z.string().optional() }).parse(req.body);
      const who = await identity(req);
      const dispute = await deps.trust.openDispute(id, who.userId, who.guestPhone, body.reason);
      return reply.code(201).send({ id: dispute.id, status: dispute.status, payout_frozen: dispute.payoutFrozen });
    })
  );

  app.post("/reports", async (req, reply) => {
    const body = z
      .object({
        kind: z.enum(["product", "shop", "rider", "partner"]),
        target_id: z.string().uuid(),
        reason: z.string().min(5)
      })
      .parse(req.body);
    let reporterId: string | null = null;
    try {
      await req.jwtVerify();
      reporterId = req.user.sub;
    } catch {
      // anonymous reports allowed
    }
    await deps.trust.report(body.kind, body.target_id, body.reason, reporterId);
    return reply.code(201).send({ received: true });
  });

  // Admin console endpoints
  app.get("/admin/dashboard", { preHandler: requireRoles("admin") }, async () => deps.admin.dashboard());
  app.get("/admin/search/phone", { preHandler: requireRoles("admin") }, async (req) => {
    const { q } = req.query as { q: string };
    return deps.admin.phoneSearch(q);
  });
  app.get("/admin/orders/:id/timeline", { preHandler: requireRoles("admin") }, async (req) =>
    deps.admin.orderTimeline((req.params as { id: string }).id)
  );
  app.get("/admin/config", { preHandler: requireRoles("admin") }, async () => deps.admin.configView());
  app.post("/admin/config/methods", { preHandler: requireRoles("admin") }, async (req) => {
    const body = z
      .object({ country: z.string().length(2), method: z.string(), enabled: z.boolean() })
      .parse(req.body);
    await deps.admin.toggleMethod(req.user.sub, body.country, body.method, body.enabled);
    return { ok: true };
  });
  app.post("/admin/config/routes", { preHandler: requireRoles("admin") }, async (req) => {
    const body = z
      .object({
        country: z.string().length(2),
        method: z.string(),
        primary: z.string(),
        fallback: z.string().nullable()
      })
      .parse(req.body);
    await deps.admin.flipRoute(req.user.sub, body.country, body.method, body.primary, body.fallback);
    return { ok: true };
  });
  app.post("/admin/config/reload-packs", { preHandler: requireRoles("admin") }, async (req) => {
    await deps.admin.reloadPacks(req.user.sub);
    return { ok: true };
  });
  app.get("/admin/audit", { preHandler: requireRoles("admin") }, async () => deps.admin.auditTrail());
  app.get("/admin/disputes", { preHandler: requireRoles("admin") }, async () =>
    deps.prisma.dispute.findMany({ where: { status: "open" }, include: { order: { select: { id: true, totalMinor: true, currency: true, shopId: true } } } })
  );
  app.post("/admin/disputes/:id/resolve", { preHandler: requireRoles("admin") }, async (req, reply) =>
    guard(reply, async () => {
      const body = z.object({ resolution: z.enum(["refund", "reject"]) }).parse(req.body);
      const d = await deps.trust.resolveDispute((req.params as { id: string }).id, body.resolution);
      if (body.resolution === "refund") {
        // FR-18 flow — refund the order (COD orders just transition)
        await deps.payments.refundOrder(d.orderId, "dispute_resolved_refund").catch(async () => {
          await deps.orders.transition(d.orderId, "refunded");
        });
      }
      return { status: d.status };
    })
  );
  app.post("/admin/products/:id/takedown", { preHandler: requireRoles("admin") }, async (req) => {
    const body = z.object({ reason: z.string().min(3) }).parse(req.body);
    await deps.trust.takedownProduct((req.params as { id: string }).id, req.user.sub, body.reason);
    return { ok: true };
  });
}
