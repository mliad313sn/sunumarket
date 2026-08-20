import Fastify from "fastify";
import cors from "@fastify/cors";

export async function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  await app.register(cors, { origin: true });

  app.get("/health", async () => ({
    status: "ok",
    service: "sunumarket-api",
    time: new Date().toISOString()
  }));

  return app;
}
