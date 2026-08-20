import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import { buildDeps, type AppDeps } from "./deps.js";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import { registerCatalogRoutes } from "./modules/catalog/catalog.routes.js";
import { registerGeoRoutes } from "./modules/geo/geo.routes.js";
import { registerOrderRoutes } from "./modules/orders/orders.routes.js";

export async function buildApp(depOverrides: Partial<AppDeps> = {}) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" && !process.env.VITEST });
  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? "dev-secret-change-me" });

  const deps = buildDeps(depOverrides);
  app.decorate("deps", deps);

  app.get("/health", async () => ({
    status: "ok",
    service: "sunumarket-api",
    time: new Date().toISOString()
  }));

  registerAuthRoutes(app, deps);
  registerCatalogRoutes(app, deps);
  registerGeoRoutes(app, deps);
  registerOrderRoutes(app, deps);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDeps;
  }
}
