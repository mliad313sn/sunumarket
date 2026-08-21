import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../../deps.js";
import { requireRoles } from "../auth/rbac.js";
import { PayoutError } from "./payouts.service.js";
import { KycError } from "../kyc/kyc.service.js";
import { PaymentError } from "../payments/payments.service.js";

const PAYOUT_ERROR_STATUS: Record<string, number> = {
  insufficient_balance: 409,
  device_blocked: 403,
  pin_required: 403,
  rail_down: 503,
  duplicate: 200
};

const payoutBody = z.object({
  amount: z.object({ amount_minor: z.string().regex(/^\d+$/), currency: z.literal("XOF") }),
  payout_pin: z.string().regex(/^\d{4,6}$/).optional(),
  idempotency_key: z.string().min(8).max(128)
});

/** DC-8.4: education cards shown exactly once, state persisted. */
const CARDS: Record<string, { audience: "seller" | "rider"; title_fr: string; body_fr: string }> = {
  seller_scam_warning: {
    audience: "seller",
    title_fr: "Protégez-vous des faux paiements",
    body_fr:
      "Ne livrez jamais sur la base d'un SMS ou d'une capture d'écran — attendez le statut PAYÉ dans l'app. Les fraudeurs envoient de faux SMS « paiement reçu »."
  },
  rider_counterfeit_cash: {
    audience: "rider",
    title_fr: "Attention aux faux billets",
    body_fr:
      "Vérifiez les billets au toucher et à la lumière (filigrane, bande). En cas de doute, refusez poliment et proposez le paiement mobile. Remettez vos encaissements via PI-SPI ou chez un agent."
  }
};

export function registerPayoutRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/balance", { preHandler: requireRoles("seller", "rider") }, async (req) => {
    const user = await deps.prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    return deps.payouts.balanceView(req.user.sub, user.country);
  });

  app.post("/payouts", { preHandler: requireRoles("seller") }, async (req, reply) => {
    const body = payoutBody.parse(req.body);
    try {
      const view = await deps.payouts.requestPayout(req.user.sub, BigInt(body.amount.amount_minor), {
        pin: body.payout_pin,
        deviceHash: req.user.device,
        idempotencyKey: body.idempotency_key
      });
      return reply.code(201).send(view);
    } catch (e) {
      if (e instanceof PayoutError) {
        return reply.code(PAYOUT_ERROR_STATUS[e.code] ?? 400).send({ code: e.code, message: e.message });
      }
      if (e instanceof KycError) {
        return reply.code(403).send({
          code: e.code,
          message: e.message,
          details: e.upgradePath ? { upgrade_path: e.upgradePath } : undefined
        });
      }
      throw e;
    }
  });

  app.post("/orders/:id/refund", { preHandler: requireRoles("seller", "admin") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().min(3) }).parse(req.body);
    try {
      const result = await deps.payments.refundOrder(id, body.reason);
      // idempotent: an already-refunded order answers 200 with the same shape
      return { status: "refunded", already_refunded: result.alreadyRefunded };
    } catch (e) {
      if (e instanceof PaymentError) {
        return reply.code(e.code === "refund_failed" ? 502 : 409).send({ code: e.code, message: e.message });
      }
      throw e;
    }
  });

  // Education cards (DC-8.4) — served once per user, seen-state persisted.
  app.get("/education/cards", { preHandler: requireRoles() }, async (req) => {
    const roles = req.user.roles;
    const seen = await deps.prisma.educationCardState.findMany({ where: { userId: req.user.sub } });
    const seenSet = new Set(seen.map((s) => s.card));
    return Object.entries(CARDS)
      .filter(([, c]) => roles.includes(c.audience) || roles.includes("admin"))
      .map(([id, c]) => ({ id, ...c, seen: seenSet.has(id) }));
  });

  app.post("/education/cards/:card/seen", { preHandler: requireRoles() }, async (req, reply) => {
    const { card } = req.params as { card: string };
    if (!CARDS[card]) return reply.code(404).send({ code: "unknown_card" });
    await deps.prisma.educationCardState.upsert({
      where: { userId_card: { userId: req.user.sub, card } },
      update: {},
      create: { userId: req.user.sub, card }
    });
    return { ok: true };
  });

  // Admin: reconciliation ingest + match + queue + resolution + close report (FR-19b, FR-44b slice).
  app.post("/admin/reconciliation/ingest", { preHandler: requireRoles("admin") }, async (req, reply) => {
    const body = z
      .object({
        provider_code: z.string().min(2).max(32),
        settlement_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        source_file: z.string().min(1).max(256),
        csv: z.string().min(1)
      })
      .parse(req.body);
    const batch = await deps.reconciliation.ingestCsv(
      body.provider_code,
      body.settlement_date,
      body.source_file,
      body.csv
    );
    return reply.code(201).send({ id: batch.id, status: batch.status });
  });
  app.post("/admin/reconciliation/run-match", { preHandler: requireRoles("admin") }, async (req) => {
    const body = z.object({ batch_id: z.string().uuid() }).parse(req.body);
    return deps.reconciliation.runMatch(body.batch_id);
  });
  app.get("/admin/reconciliation/flags", { preHandler: requireRoles("admin") }, async () =>
    deps.reconciliation.flagQueue()
  );
  app.post("/admin/reconciliation/flags/:id/resolve", { preHandler: requireRoles("admin") }, async (req) => {
    const body = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
    await deps.reconciliation.resolveFlag((req.params as { id: string }).id, req.user.sub, body.reason);
    return { ok: true };
  });
  app.get("/admin/reconciliation/close/:month", { preHandler: requireRoles("admin") }, async (req) =>
    deps.reconciliation.closeReport((req.params as { month: string }).month)
  );
}
