import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../../deps.js";
import { requireRoles } from "../auth/rbac.js";
import { PaymentError } from "./payments.service.js";

const PAYMENT_ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  invalid_state: 409,
  method_unavailable: 400,
  velocity_blocked: 429,
  provider_outage: 503,
  declined: 402,
  forged_reference: 400,
  forbidden: 403
};

const createAttemptBody = z.object({
  method: z.string(),
  idempotency_key: z.string().min(8).max(128),
  mock_scenario: z.string().optional()
});

export function registerPaymentRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { payments } = deps;

  const handle = async (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PaymentError) {
        return reply.code(PAYMENT_ERROR_STATUS[e.code] ?? 400).send({ code: e.code, message: e.message });
      }
      throw e;
    }
  };

  app.get("/checkout/:orderId/methods", async (req, reply) =>
    handle(reply, () => payments.checkoutMethods((req.params as { orderId: string }).orderId))
  );

  app.post("/orders/:id/attempts", async (req, reply) =>
    handle(reply, async () => {
      const { id } = req.params as { id: string };
      const body = createAttemptBody.parse(req.body);
      // Mock scenarios only steer mock providers; never allowed in production builds.
      const scenario = process.env.NODE_ENV === "production" ? undefined : body.mock_scenario;
      const view = await payments.createAttempt(id, body.method, body.idempotency_key, {
        mockScenario: scenario
      });
      return reply.code(201).send(view);
    })
  );

  app.get("/attempts/:id", async (req, reply) =>
    handle(reply, () => payments.view((req.params as { id: string }).id))
  );

  app.post("/attempts/:id/ussd-resend", async (req, reply) =>
    handle(reply, () => payments.ussdResend((req.params as { id: string }).id))
  );

  app.post("/attempts/:id/manual-proof", async (req, reply) =>
    handle(reply, async () => {
      const body = z.object({ reference: z.string() }).parse(req.body);
      await payments.manualProof((req.params as { id: string }).id, body.reference);
      return { status: "payment_review" };
    })
  );

  app.post(
    "/attempts/:id/seller-confirm",
    { preHandler: requireRoles("seller") },
    async (req, reply) =>
      handle(reply, async () => {
        const body = z.object({ balance_checked: z.boolean() }).parse(req.body);
        await payments.sellerConfirmManual((req.params as { id: string }).id, req.user.sub, body.balance_checked);
        return { status: "paid" };
      })
  );

  // Raw-body webhook endpoint with per-provider signature isolation (NFR-3).
  app.post(
    "/webhooks/:provider",
    { config: { rawBody: true } },
    async (req, reply) => {
      const { provider } = req.params as { provider: string };
      const signature = req.headers["x-signature"] as string | undefined;
      const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      try {
        const { status, outcome } = await payments.handleWebhook(provider.toUpperCase(), rawBody, signature);
        return reply.code(status).send({ outcome });
      } catch (e) {
        if ((e as { name?: string }).name === "NotFoundError" || /unknown payment provider/.test(String(e))) {
          return reply.code(404).send({ code: "unknown_provider" });
        }
        throw e;
      }
    }
  );
}
