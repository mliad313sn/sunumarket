import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { PackRegistry } from "@sunumarket/config";
import { canTransition, type OrderStatus, type WebhookResult } from "@sunumarket/shared";
import type { MessagingProvider } from "../../lib/messaging.js";
import type { FraudService } from "../fraud/fraud.service.js";
import type { VelocityRules } from "../fraud/velocity.js";
import type { OrdersService } from "../orders/orders.service.js";
import type { ProviderRouter } from "./router.js";
import type { InitRequest } from "./provider.js";
import type { LedgerService } from "../ledger/ledger.service.js";

const USSD_COUNTDOWN_S = 120;

export class PaymentError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "invalid_state"
      | "method_unavailable"
      | "velocity_blocked"
      | "provider_outage"
      | "declined"
      | "forged_reference"
      | "refund_failed"
      | "forbidden",
    message: string
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

export interface AttemptView {
  id: string;
  order_id: string;
  method: string;
  status: string;
  provider_code: string | null;
  provider_ref: string | null;
  amount: { amount_minor: string; currency: string };
  ussd: { dial_code: string; expires_in_s: number; can_resend: boolean } | null;
  next_action: unknown;
  failure_reason: string | null;
}

export class PaymentsService {
  /** Pending auto-refunds queued by late webhooks (ADR-0007); Phase 8 ledger consumes. */
  readonly refundQueue: Array<{ attemptId: string; providerRef: string; amountMinor: bigint; reason: string }> = [];

  constructor(
    private readonly prisma: PrismaClient,
    private readonly packs: PackRegistry,
    private readonly router: ProviderRouter,
    private readonly orders: OrdersService,
    private readonly velocity: VelocityRules,
    private readonly fraud: FraudService,
    private readonly messaging: MessagingProvider,
    private readonly ledger: LedgerService
  ) {}

  /** Record the sale split in the double-entry ledger once an online payment lands (FR-19). */
  private async recordSaleFor(attemptId: string, direct = false): Promise<void> {
    const attempt = await this.prisma.paymentAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      include: { order: { include: { shop: true } } }
    });
    await this.ledger.recordSale({
      orderId: attempt.orderId,
      attemptId,
      sellerId: attempt.order.shop.sellerId,
      country: attempt.order.shop.country,
      grossMinor: attempt.order.totalMinor,
      currency: attempt.order.currency,
      direct
    });
  }

  /** FR-13: pack ∩ seller subset, dominant first; remembered non-locking default (DC-4); guided mode (DC-2). */
  async checkoutMethods(orderId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { shop: true }
    });
    const country = order.shop.country;
    const packMethods = this.packs.enabledMethods(country);
    const sellerSet = new Set(order.shop.enabledMethods);
    const buyerKey = order.buyerId ?? order.guestPhone;

    let remembered: string | null = null;
    let guided = true;
    if (buyerKey) {
      const last = await this.prisma.paymentAttempt.findFirst({
        where: {
          status: "succeeded",
          order: order.buyerId ? { buyerId: order.buyerId } : { guestPhone: order.guestPhone }
        },
        orderBy: { updatedAt: "desc" }
      });
      remembered = last?.method ?? null;
      guided = !last;
    }

    const fees = this.packs.get(country).fees_taxes.pass_through.filter((f) => f.bearer === "buyer");
    const feeDisplay = fees.map((f) => f.display_fr).join(" · ") || undefined;

    return {
      country,
      first_payment_guided: guided,
      methods: packMethods
        .filter((m) => sellerSet.has(m.type))
        .map((m) => ({
          method: m.type,
          label: m.label,
          ussd_confirm: m.ussd_confirm,
          ussd_dial_code: m.ussd_dial_code ?? null,
          remembered_default: m.type === remembered,
          fee_display: feeDisplay
        }))
    };
  }

  /**
   * FR-14/17 — create a payment attempt: routed with failover, idempotent,
   * retry-with-other-method cancels prior open attempts.
   */
  async createAttempt(
    orderId: string,
    method: string,
    idempotencyKey: string,
    opts: { mockScenario?: string | undefined } = {}
  ): Promise<AttemptView> {
    const dup = await this.prisma.paymentAttempt.findUnique({ where: { idempotencyKey } });
    if (dup) return this.view(dup.id);

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { shop: true }
    });
    if (order.status !== "payment_pending") {
      throw new PaymentError("invalid_state", "commande non payable (expirée ou déjà payée)");
    }
    if (order.paymentExpiresAt && order.paymentExpiresAt < new Date()) {
      throw new PaymentError("invalid_state", "réservation expirée — repassez la commande");
    }

    const buyerKey = order.buyerId ?? order.guestPhone ?? orderId;
    if (this.velocity.isPaymentBlocked(buyerKey)) {
      throw new PaymentError("velocity_blocked", "trop d'échecs récents — réessayez dans quelques minutes");
    }

    const country = order.shop.country;
    const available = this.packs
      .enabledMethods(country)
      .filter((m) => order.shop.enabledMethods.includes(m.type));
    const methodCfg = available.find((m) => m.type === method);
    if (!methodCfg) throw new PaymentError("method_unavailable", `méthode ${method} indisponible`);

    // DC-4: switching method is first-class — close previous open attempts.
    await this.prisma.paymentAttempt.updateMany({
      where: { orderId, status: { in: ["initiated", "ussd_pending"] } },
      data: { status: "cancelled", failureReason: "replaced_by_new_attempt" }
    });

    // COD: no online rail — the order is confirmed for fulfilment; cash settles
    // through the rider cash ledger in Phase 9 (FR-16).
    if (method === "COD") {
      const attempt = await this.prisma.paymentAttempt.create({
        data: { orderId, method, status: "succeeded", idempotencyKey, providerRef: `COD-${randomUUID()}` }
      });
      await this.orders.transition(orderId, "paid");
      return this.view(attempt.id);
    }

    // MANUAL_TRANSFER (DC-8.2): pack/admin-gated, unique reference, advisory proof.
    if (method === "MANUAL_TRANSFER") {
      const reference = `SM-${randomUUID().slice(0, 8).toUpperCase()}`;
      const attempt = await this.prisma.paymentAttempt.create({
        data: {
          orderId,
          method,
          status: "initiated",
          idempotencyKey,
          providerRef: `MANUAL-${reference}`
        }
      });
      return this.view(attempt.id, { kind: "manual_reference", manual_reference: reference });
    }

    const candidates = this.router.candidates(country, method);
    let lastOutage: string | null = null;

    for (const provider of candidates) {
      const initReq: InitRequest = {
        attemptId: idempotencyKey,
        orderId,
        method,
        amountMinor: order.totalMinor,
        currency: order.currency,
        buyerPhone: order.guestPhone,
        mockScenario: opts.mockScenario
      };
      const result = await provider.init(initReq);

      if (!result.ok && result.kind === "provider_error") {
        this.router.recordFailure(provider.code, method);
        lastOutage = result.reason;
        continue; // failover to next candidate (golden path 9)
      }

      const providerRow = await this.prisma.paymentProvider.findUniqueOrThrow({ where: { code: provider.code } });

      if (!result.ok) {
        // declined — buyer-side failure, no failover (DC-3 UX, velocity signal)
        const flag = this.velocity.recordFailedPayment(buyerKey);
        if (flag) await this.fraud.record(flag.kind, { detail: { subject: buyerKey, count: flag.count } });
        const attempt = await this.prisma.paymentAttempt.create({
          data: {
            orderId,
            method,
            providerId: providerRow.id,
            status: "failed",
            idempotencyKey,
            failureReason: result.reason
          }
        });
        return this.view(attempt.id);
      }

      this.router.recordSuccess(provider.code, method);
      const attempt = await this.prisma.paymentAttempt.create({
        data: {
          orderId,
          method,
          providerId: providerRow.id,
          status: result.status,
          idempotencyKey,
          providerRef: result.providerRef
        }
      });
      return this.view(attempt.id, result.next, methodCfg.ussd_dial_code ?? null);
    }

    // All candidates down — order & stock stay reserved (NFR-2); friendly DC-3 retry.
    const flag = this.velocity.recordFailedPayment(buyerKey);
    if (flag) await this.fraud.record(flag.kind, { detail: { subject: buyerKey, count: flag.count } });
    await this.prisma.paymentAttempt.create({
      data: {
        orderId,
        method,
        status: "failed",
        idempotencyKey,
        failureReason: `provider_outage: ${lastOutage ?? "all providers down"}`
      }
    });
    throw new PaymentError(
      "provider_outage",
      "paiement momentanément indisponible — la commande reste réservée 30 min, réessayez ou changez de méthode"
    );
  }

  /** Webhook entry — DC-8.1: the ONLY path to paid (with PI-SPI confirm). */
  async handleWebhook(
    providerCode: string,
    rawBody: string,
    signature: string | undefined
  ): Promise<{ status: number; outcome: string }> {
    const provider = this.router.provider(providerCode);
    const providerRow = await this.prisma.paymentProvider.findUniqueOrThrow({ where: { code: providerCode } });

    const result = provider.verifyWebhook(rawBody, signature);
    if (!result) {
      await this.fraud.record("webhook_signature_invalid", { detail: { provider: providerCode } });
      return { status: 401, outcome: "rejected" };
    }

    // Idempotent by (provider, event_id) — replays are no-ops (ADR-0012).
    try {
      await this.prisma.webhookEvent.create({
        data: {
          providerId: providerRow.id,
          eventId: result.event_id,
          payload: JSON.parse(rawBody) as object,
          signatureValid: true,
          outcome: "applied"
        }
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return { status: 200, outcome: "duplicate" };
      throw e;
    }

    // Freshness window (replay hardening): a signed-but-stale event we have never
    // seen is rejected and flagged — exact replays above still answer 200/duplicate.
    const maxAgeMs = Number(process.env.WEBHOOK_MAX_AGE_MIN ?? "10") * 60_000;
    const maxFutureMs = Number(process.env.WEBHOOK_MAX_FUTURE_MIN ?? "2") * 60_000;
    const occurredAt = Date.parse(result.occurred_at);
    const now = Date.now();
    if (!Number.isFinite(occurredAt) || now - occurredAt > maxAgeMs || occurredAt - now > maxFutureMs) {
      await this.fraud.record("webhook_stale", {
        detail: { provider: providerCode, event_id: result.event_id, occurred_at: result.occurred_at }
      });
      await this.prisma.webhookEvent.updateMany({
        where: { providerId: providerRow.id, eventId: result.event_id },
        data: { outcome: "stale" }
      });
      return { status: 400, outcome: "stale" };
    }

    const outcome = await this.applyWebhook(result);
    await this.prisma.webhookEvent.updateMany({
      where: { providerId: providerRow.id, eventId: result.event_id },
      data: { outcome }
    });
    return { status: 200, outcome };
  }

  private async applyWebhook(result: WebhookResult): Promise<string> {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { providerRef: result.provider_ref },
      include: { order: true }
    });
    if (!attempt) return "rejected";

    if (result.kind === "payment_failed") {
      if (["initiated", "ussd_pending"].includes(attempt.status)) {
        await this.prisma.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: "failed", failureReason: "provider_reported_failure" }
        });
      }
      return "applied";
    }

    if (result.kind !== "payment_succeeded") return "applied";

    const order = attempt.order;

    // Normal path: open attempt + payable order → paid.
    if (["initiated", "ussd_pending"].includes(attempt.status) && order.status === "payment_pending") {
      await this.prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { status: "succeeded" } });
      await this.orders.transition(order.id, "paid");
      await this.recordSaleFor(attempt.id);
      await this.notify(order.guestPhone, "SunuMarket: paiement reçu — commande PAYÉE ✓");
      return "applied";
    }

    // ADR-0007 exception: attempt was cancelled (method switch) but the order is
    // still payment_pending → the money arrived, apply it and cancel newer attempts.
    if (attempt.status === "cancelled" && order.status === "payment_pending") {
      await this.prisma.paymentAttempt.updateMany({
        where: { orderId: order.id, status: { in: ["initiated", "ussd_pending"] } },
        data: { status: "cancelled", failureReason: "another_attempt_confirmed" }
      });
      await this.prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { status: "succeeded" } });
      await this.orders.transition(order.id, "paid");
      await this.recordSaleFor(attempt.id);
      return "applied";
    }

    // ADR-0007: late/duplicate money → record reality, auto-refund, never resurrect.
    await this.prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { status: "succeeded_late" } });
    if (attempt.providerId && attempt.providerRef) {
      this.refundQueue.push({
        attemptId: attempt.id,
        providerRef: attempt.providerRef,
        amountMinor: order.totalMinor,
        reason: order.status === "expired" ? "late_webhook_after_expiry" : "duplicate_payment"
      });
      const providerRow = await this.prisma.paymentProvider.findUnique({ where: { id: attempt.providerId } });
      if (providerRow) {
        const p = this.router.provider(providerRow.code);
        await p.refund(attempt.providerRef, order.totalMinor, order.currency);
      }
    }
    await this.notify(
      order.guestPhone,
      "SunuMarket: votre paiement est arrivé trop tard — remboursement automatique en cours."
    );
    return "late";
  }

  /** DC-14: USSD state view + resend (countdown restarts). */
  async ussdResend(attemptId: string): Promise<AttemptView> {
    const attempt = await this.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    if (attempt.status !== "ussd_pending") throw new PaymentError("invalid_state", "pas de confirmation USSD en attente");
    await this.prisma.paymentAttempt.update({ where: { id: attemptId }, data: { updatedAt: new Date() } });
    return this.view(attemptId);
  }

  /** USSD timeout sweep: pending confirmations past the countdown fail with friendly retry. */
  async sweepUssdTimeouts(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - USSD_COUNTDOWN_S * 1000);
    const stale = await this.prisma.paymentAttempt.findMany({
      where: { status: "ussd_pending", updatedAt: { lt: cutoff } }
    });
    for (const a of stale) {
      await this.prisma.paymentAttempt.update({
        where: { id: a.id },
        data: { status: "failed", failureReason: "ussd_timeout" }
      });
    }
    return stale.length;
  }

  /** Buyer submits the manual-transfer reference (advisory proof, DC-8.2). */
  async manualProof(attemptId: string, reference: string): Promise<void> {
    const attempt = await this.prisma.paymentAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      include: { order: true }
    });
    if (attempt.method !== "MANUAL_TRANSFER" || attempt.status !== "initiated") {
      throw new PaymentError("invalid_state", "pas de transfert manuel en attente");
    }
    if (attempt.providerRef !== `MANUAL-${reference}`) {
      await this.fraud.record("forged_manual_reference", {
        detail: { attemptId, submitted: reference }
      });
      throw new PaymentError("forged_reference", "référence invalide");
    }
    await this.orders.transition(attempt.orderId, "payment_review");
  }

  /** Seller confirms actual wallet balance received (DC-8.2 mandatory step). */
  async sellerConfirmManual(attemptId: string, sellerId: string, balanceChecked: boolean): Promise<void> {
    if (!balanceChecked) {
      throw new PaymentError("invalid_state", "confirmez d'abord votre solde — ne vous fiez jamais à un SMS/capture");
    }
    const attempt = await this.prisma.paymentAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      include: { order: { include: { shop: true } } }
    });
    if (attempt.order.shop.sellerId !== sellerId) throw new PaymentError("forbidden", "pas votre commande");
    if (attempt.order.status !== "payment_review") throw new PaymentError("invalid_state", "commande non en revue");
    await this.prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { status: "succeeded" } });
    await this.orders.transition(attempt.orderId, "paid");
    // Manual transfer: money went seller-direct — record gross with no fee split.
    await this.recordSaleFor(attempt.id, true);
  }

  /**
   * FR-18: refund a paid order per its method (PI-SPI reverse / aggregator refund).
   * Ordering matters (money-correctness): provider refund → ledger reversal →
   * order transition LAST. A provider/ledger failure leaves the order un-refunded
   * so the call can be retried. Idempotent: an already-refunded order is a no-op.
   */
  async refundOrder(orderId: string, reason: string): Promise<{ alreadyRefunded: boolean }> {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status === "refunded") return { alreadyRefunded: true };

    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: { orderId, status: { in: ["succeeded", "succeeded_late"] } },
      include: { provider: true, transaction: true, order: true }
    });
    if (!attempt) throw new PaymentError("invalid_state", "aucun paiement à rembourser");
    if (!canTransition(order.status as OrderStatus, "refunded")) {
      throw new PaymentError("invalid_state", `commande non remboursable depuis l'état ${order.status}`);
    }

    if (attempt.provider && attempt.providerRef) {
      const p = this.router.provider(attempt.provider.code);
      let result;
      try {
        result = await p.refund(attempt.providerRef, attempt.order.totalMinor, attempt.order.currency);
      } catch (e) {
        throw new PaymentError("refund_failed", `remboursement fournisseur échoué: ${(e as Error).message}`);
      }
      if (!result.ok) {
        throw new PaymentError("refund_failed", `remboursement fournisseur refusé: ${result.reason ?? "inconnu"}`);
      }
    }
    if (attempt.transaction) {
      // Guard against a double reversal when a previous call posted the ledger
      // refund but failed before the order transition (retry path).
      const existing = await this.prisma.ledgerTransaction.findFirst({
        where: { kind: "refund", sourceRef: { endsWith: `:${attempt.transaction.id}` } }
      });
      if (!existing) await this.ledger.recordRefund(attempt.transaction.id, reason);
    }
    await this.orders.transition(orderId, "refunded");
    await this.notify(attempt.order.guestPhone, "SunuMarket: votre remboursement est en cours.");
    return { alreadyRefunded: false };
  }

  private async notify(phone: string | null, body: string): Promise<void> {
    if (!phone) return;
    await this.messaging.sendSms({ phone, body, senderId: "SUNUMKT" });
  }

  async view(attemptId: string, next?: unknown, ussdDialCode?: string | null): Promise<AttemptView> {
    const a = await this.prisma.paymentAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      include: { order: true, provider: true }
    });
    let dialCode = ussdDialCode ?? null;
    if (a.status === "ussd_pending" && !dialCode) {
      const shop = await this.prisma.shop.findUnique({ where: { id: a.order.shopId } });
      if (shop) {
        dialCode = this.packs.get(shop.country).methods.find((m) => m.type === a.method)?.ussd_dial_code ?? null;
      }
    }
    return {
      id: a.id,
      order_id: a.orderId,
      method: a.method,
      status: a.status,
      provider_code: a.provider?.code ?? null,
      provider_ref: a.providerRef,
      amount: { amount_minor: a.order.totalMinor.toString(), currency: a.order.currency },
      ussd:
        a.status === "ussd_pending"
          ? { dial_code: dialCode ?? "", expires_in_s: USSD_COUNTDOWN_S, can_resend: true }
          : null,
      next_action: next ?? null,
      failure_reason: a.failureReason
    };
  }
}
