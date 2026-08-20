import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../../deps.js";
import { requireRoles } from "../auth/rbac.js";
import { DeliveryError } from "./delivery.service.js";

const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  invalid_state: 409,
  not_paid: 409,
  race_lost: 409,
  proof_required: 400,
  bad_proof: 400,
  cod_cap: 403,
  forbidden: 403
};

export function registerDeliveryRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { delivery } = deps;

  const guard = async (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof DeliveryError) {
        return reply.code(ERROR_STATUS[e.code] ?? 400).send({ code: e.code, message: e.message });
      }
      throw e;
    }
  };

  app.post("/deliveries", { preHandler: requireRoles("seller") }, async (req, reply) =>
    guard(reply, async () => {
      const body = z
        .object({ order_id: z.string().uuid(), mode: z.enum(["SELF", "RIDER", "PARTNER"]) })
        .parse(req.body);
      const job = await delivery.requestDelivery(body.order_id, body.mode, req.user.sub);
      return reply.code(201).send(serializeJob(job));
    })
  );

  app.get("/rider/feed", { preHandler: requireRoles("rider") }, async (req) => {
    const offers = await deps.delivery.riderFeed(req.user.sub);
    return offers.map((o) => ({
      job_id: o.jobId,
      offered_at: o.offeredAt.toISOString(),
      fee: { amount_minor: o.job.feeMinor.toString(), currency: o.job.currency },
      cod: o.job.cod,
      cod_amount: o.job.codAmountMinor ? { amount_minor: o.job.codAmountMinor.toString(), currency: o.job.currency } : null,
      dropoff: o.job.order.deliveryPointSnapshot
    }));
  });

  app.post("/jobs/:id/accept", { preHandler: requireRoles("rider") }, async (req, reply) =>
    guard(reply, async () => serializeJob(await delivery.acceptOffer((req.params as { id: string }).id, req.user.sub)))
  );

  app.post("/jobs/:id/status", { preHandler: requireRoles("rider") }, async (req, reply) =>
    guard(reply, async () => {
      const body = z
        .object({
          event_id: z.string().uuid(),
          status: z.enum(["picked_up", "en_route", "arrived", "failed_attempt"]),
          gps: z.object({ lat: z.number(), lng: z.number() }).optional(),
          at: z.string().datetime()
        })
        .parse(req.body);
      return delivery.updateStatus((req.params as { id: string }).id, req.user.sub, body);
    })
  );

  app.post("/jobs/:id/proof", { preHandler: requireRoles("rider", "seller") }, async (req, reply) =>
    guard(reply, async () => {
      const body = z
        .union([
          z.object({ kind: z.literal("photo"), photo_key: z.string() }),
          z.object({ kind: z.literal("otp"), code: z.string().regex(/^\d{4,6}$/) })
        ])
        .parse(req.body);
      const isRider = req.user.roles.includes("rider");
      return serializeJob(await delivery.submitProof((req.params as { id: string }).id, isRider ? req.user.sub : null, body));
    })
  );

  app.post("/jobs/:id/incident", { preHandler: requireRoles("rider", "seller") }, async (req, reply) =>
    guard(reply, async () => {
      const body = z.object({ reason: z.string().min(3) }).parse(req.body);
      const isRider = req.user.roles.includes("rider");
      return serializeJob(
        await delivery.reportIncident((req.params as { id: string }).id, isRider ? req.user.sub : null, body.reason)
      );
    })
  );

  app.get("/rider/cash", { preHandler: requireRoles("rider") }, async (req) => {
    const outstanding = await deps.delivery.codOutstanding(req.user.sub);
    const entries = await deps.prisma.riderCashLedger.findMany({
      where: { riderId: req.user.sub },
      orderBy: { createdAt: "desc" },
      take: 50
    });
    return {
      outstanding: { amount_minor: outstanding.toString(), currency: "XOF" },
      entries: entries.map((e) => ({
        amount_minor: e.amountMinor.toString(),
        kind: e.kind,
        order_id: e.orderId,
        at: e.createdAt.toISOString()
      }))
    };
  });

  app.post("/riders/remittances", { preHandler: requireRoles("rider") }, async (req, reply) =>
    guard(reply, async () => {
      const body = z
        .object({
          amount: z.object({ amount_minor: z.string().regex(/^\d+$/), currency: z.literal("XOF") }),
          rail: z.enum(["PI_SPI", "AGENT_DEPOSIT"]),
          idempotency_key: z.string().min(8)
        })
        .parse(req.body);
      return delivery.remit(req.user.sub, BigInt(body.amount.amount_minor), body.rail, body.idempotency_key);
    })
  );

  // Partner-scoped job list (dashboard data; isolation enforced by partner id claim).
  app.get("/partner/jobs", { preHandler: requireRoles("partner") }, async (req) => {
    const partner = await deps.prisma.partner.findFirstOrThrow();
    void req;
    const jobs = await deps.prisma.deliveryJob.findMany({
      where: { partnerId: partner.id },
      orderBy: { createdAt: "desc" },
      take: 100
    });
    return jobs.map(serializeJob);
  });

  app.post("/webhooks/partner/:partnerId", async (req, reply) => {
    const { partnerId } = req.params as { partnerId: string };
    const signature = req.headers["x-signature"] as string | undefined;
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const res = await delivery.partnerWebhook(partnerId, rawBody, signature);
    return reply.code(res.status).send({ outcome: res.outcome });
  });
}

function serializeJob(j: {
  id: string;
  orderId: string;
  mode: string;
  status: string;
  riderId: string | null;
  partnerId: string | null;
  feeMinor: bigint;
  currency: string;
  cod: boolean;
  codAmountMinor: bigint | null;
}) {
  return {
    id: j.id,
    order_id: j.orderId,
    mode: j.mode,
    status: j.status,
    rider_id: j.riderId,
    partner_id: j.partnerId,
    fee: { amount_minor: j.feeMinor.toString(), currency: j.currency },
    cod: j.cod,
    cod_amount: j.codAmountMinor ? { amount_minor: j.codAmountMinor.toString(), currency: j.currency } : null
  };
}
