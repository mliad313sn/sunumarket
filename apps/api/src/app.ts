import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import { assertProductionSecrets } from "./lib/secrets.js";
import { buildDeps, type AppDeps } from "./deps.js";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import { registerCatalogRoutes } from "./modules/catalog/catalog.routes.js";
import { registerGeoRoutes } from "./modules/geo/geo.routes.js";
import { registerOrderRoutes } from "./modules/orders/orders.routes.js";
import { registerPaymentRoutes } from "./modules/payments/payments.routes.js";
import { registerPayoutRoutes } from "./modules/payouts/payouts.routes.js";
import { registerDeliveryRoutes } from "./modules/delivery/delivery.routes.js";
import { registerTrustRoutes } from "./modules/trust/trust.routes.js";

export async function buildApp(depOverrides: Partial<AppDeps> = {}) {
  // NFR-3: refuse to boot production on dev-default secrets (pass-2 fix 8).
  assertProductionSecrets();
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" && !process.env.VITEST });
  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? "dev-secret-change-me" });

  const deps = buildDeps(depOverrides);
  app.decorate("deps", deps);

  // Per-IP rate limiting on abuse-prone unauthenticated ingress (pass-2 fix 9).
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "POST") return;
    const path = req.url.split("?")[0] ?? req.url;
    const limiter = path.startsWith("/webhooks/")
      ? deps.rateLimits.webhooks
      : path === "/auth/otp"
        ? deps.rateLimits.otp
        : null;
    if (limiter && !limiter.allow(req.ip)) {
      return reply
        .code(429)
        .send({ code: "rate_limited", message: "Trop de requêtes — réessayez dans une minute." });
    }
  });

  // Deep health (pass-2 fix 10): DB reachability + worker liveness. Stays fast —
  // one SELECT 1 and one PK-indexed read; 503 when the database is down.
  app.get("/health", async (_req, reply) => {
    try {
      await deps.prisma.$queryRaw`SELECT 1`;
    } catch {
      return reply.code(503).send({ status: "unavailable", service: "sunumarket-api", db: "down" });
    }
    const fastMs = Number(process.env.SUNU_WORKER_FAST_MS ?? 60_000);
    const beat = await deps.prisma.workerHeartbeat.findFirst({ orderBy: { beatAt: "desc" } });
    const stale = !beat || Date.now() - beat.beatAt.getTime() > 3 * fastMs;
    return {
      status: "ok",
      service: "sunumarket-api",
      time: new Date().toISOString(),
      db: "ok",
      worker: { last_beat_at: beat?.beatAt.toISOString() ?? null, stale }
    };
  });

  registerAuthRoutes(app, deps);
  registerCatalogRoutes(app, deps);
  registerGeoRoutes(app, deps);
  registerOrderRoutes(app, deps);
  registerPaymentRoutes(app, deps);
  registerPayoutRoutes(app, deps);
  registerDeliveryRoutes(app, deps);
  registerTrustRoutes(app, deps);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDeps;
  }
}
