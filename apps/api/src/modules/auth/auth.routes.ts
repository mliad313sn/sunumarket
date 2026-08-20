import type { FastifyInstance } from "fastify";
import { refreshSchema, requestOtpSchema, verifyOtpSchema } from "@sunumarket/shared";
import type { AppDeps } from "../../deps.js";
import { AuthError } from "./auth.service.js";
import { KycError } from "../kyc/kyc.service.js";
import { requireRoles } from "./rbac.js";

const AUTH_ERROR_STATUS: Record<string, number> = {
  otp_throttled: 429,
  otp_invalid: 400,
  otp_expired: 400,
  otp_locked: 423,
  invalid_phone: 400,
  invalid_refresh: 401
};

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { auth, kyc } = deps;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) {
      return reply.code(AUTH_ERROR_STATUS[err.code] ?? 400).send({ code: err.code, message: err.message });
    }
    if (err instanceof KycError) {
      return reply.code(err.code === "limit_exceeded" ? 403 : 400).send({
        code: err.code,
        message: err.message,
        details: err.upgradePath ? { upgrade_path: err.upgradePath } : undefined
      });
    }
    if (typeof (err as { validation?: unknown }).validation !== "undefined" || err.name === "ZodError") {
      return reply.code(400).send({ code: "validation", message: err.message });
    }
    app.log.error(err);
    return reply.code(500).send({ code: "internal", message: "erreur interne" });
  });

  app.post("/auth/otp", async (req, reply) => {
    const body = requestOtpSchema.parse(req.body);
    await auth.requestOtp(body.phone, body.country, body.device_hash);
    return reply.send({ sent: true });
  });

  app.post("/auth/verify", async (req, reply) => {
    const body = verifyOtpSchema.parse(req.body);
    const result = await auth.verifyOtp(body.phone, body.code, body.device_hash);
    const access = await reply.jwtSign(result.accessPayload, { expiresIn: "15m" });
    return reply.send({
      access_token: access,
      refresh_token: result.refreshToken,
      reverify_required: result.reverifyRequired
    });
  });

  app.post("/auth/refresh", async (req, reply) => {
    const body = refreshSchema.parse(req.body);
    const result = await auth.rotateRefresh(body.refresh_token);
    const access = await reply.jwtSign(result.accessPayload, { expiresIn: "15m" });
    return reply.send({ access_token: access, refresh_token: result.refreshToken, reverify_required: false });
  });

  app.get("/me", { preHandler: requireRoles() }, async (req) => {
    const user = await deps.prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    return {
      id: user.id,
      phone: user.phone,
      name: user.name,
      roles: user.roles,
      country: user.country,
      locale: user.locale,
      kyc_tier: user.kycTier
    };
  });

  // Privacy (FR-25 adjunct): export + delete.
  app.get("/me/export", { preHandler: requireRoles() }, async (req) => {
    const user = await deps.prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    const orders = await deps.prisma.order.findMany({ where: { buyerId: user.id } });
    const points = await deps.prisma.$queryRaw`
      SELECT label, landmark, ST_X(point) as lng, ST_Y(point) as lat, created_at
      FROM delivery_points WHERE owner_id = ${user.id}::uuid`;
    return { user, orders, delivery_points: points };
  });

  app.post("/kyc/upgrade", { preHandler: requireRoles() }, async (req) => {
    const body = req.body as { target_tier: 1 | 2; id_document_key: string; address?: string; vehicle?: string };
    const docs: Record<string, string> = { id_document: body.id_document_key };
    if (body.address) docs.address = body.address;
    if (body.vehicle) docs.vehicle = body.vehicle;
    return kyc.requestUpgrade(req.user.sub, body.target_tier, docs);
  });

  app.post("/auth/payout-pin", { preHandler: requireRoles("seller", "rider") }, async (req, reply) => {
    const { pin } = req.body as { pin: string };
    if (!/^\d{4,6}$/.test(pin)) return reply.code(400).send({ code: "invalid_pin", message: "PIN 4-6 chiffres" });
    await auth.setPayoutPin(req.user.sub, pin);
    return { ok: true };
  });

  // Admin: KYC review + anomaly queue (fuller console in Phase 10).
  app.get("/admin/kyc/queue", { preHandler: requireRoles("admin") }, async () => kyc.reviewQueue());
  app.post("/admin/kyc/:id/decide", { preHandler: requireRoles("admin") }, async (req) => {
    const { id } = req.params as { id: string };
    const { approve } = req.body as { approve: boolean };
    await kyc.decide(id, approve);
    return { ok: true };
  });
  app.get("/admin/fraud/queue", { preHandler: requireRoles("admin") }, async () => deps.fraud.queue());
  app.post("/admin/fraud/:id/review", { preHandler: requireRoles("admin") }, async (req) => {
    const { id } = req.params as { id: string };
    const { status } = req.body as { status: "cleared" | "actioned" };
    return deps.fraud.review(id, status);
  });
}
