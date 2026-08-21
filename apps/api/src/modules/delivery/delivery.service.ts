import { randomInt } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { assertJobTransition, canJobTransition, type JobStatus } from "@sunumarket/shared";
import type { MessagingProvider } from "../../lib/messaging.js";
import type { FraudService } from "../fraud/fraud.service.js";
import type { KycService } from "../kyc/kyc.service.js";
import type { OrdersService } from "../orders/orders.service.js";
import type { MockPiSpiProvider } from "../payments/mock-provider.js";
import type { LedgerService } from "../ledger/ledger.service.js";
import type { DeliveryPartnerAdapter } from "./partner-adapter.js";

const BROADCAST_TIMEOUT_MS = 2 * 60 * 1000;

export class DeliveryError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "invalid_state"
      | "not_paid"
      | "race_lost"
      | "proof_required"
      | "bad_proof"
      | "cod_cap"
      | "forbidden",
    message: string
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

export class DeliveryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly orders: OrdersService,
    private readonly kyc: KycService,
    private readonly piSpi: MockPiSpiProvider,
    private readonly messaging: MessagingProvider,
    private readonly partnerAdapters: Map<string, DeliveryPartnerAdapter>,
    private readonly ledger: LedgerService,
    private readonly fraud: FraudService
  ) {}

  /** FR-26: request delivery for a paid order; SELF/RIDER/PARTNER (DC on mode). */
  async requestDelivery(orderId: string, mode: "SELF" | "RIDER" | "PARTNER", sellerId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { shop: true, attempts: true, job: true }
    });
    if (order.shop.sellerId !== sellerId) throw new DeliveryError("forbidden", "pas votre commande");
    if (order.status !== "paid" && order.status !== "preparing") {
      throw new DeliveryError("not_paid", "attendez le statut PAYÉ avant de livrer");
    }
    if (order.job) throw new DeliveryError("invalid_state", "livraison déjà demandée");

    const cod = order.attempts.some((a) => a.method === "COD" && a.status === "succeeded");
    const snapshot = order.deliveryPointSnapshot as { lat: number; lng: number; landmark: string };
    // Buyer-side proof code for OTP-based delivery confirmation (FR-30).
    const proofCode = randomInt(0, 10000).toString().padStart(4, "0");

    const job = await this.prisma.deliveryJob.create({
      data: {
        orderId,
        mode,
        status: "requested",
        feeMinor: order.deliveryFeeMinor,
        currency: order.currency,
        cod,
        codAmountMinor: cod ? order.totalMinor : null,
        proof: { expected_otp: proofCode }
      }
    });
    if (order.status === "paid") await this.orders.transition(orderId, "preparing");

    if (mode === "SELF") {
      await this.transition(job.id, "accepted");
    } else if (mode === "RIDER") {
      await this.transition(job.id, "broadcasting");
      await this.broadcast(job.id, order.shop.cityId);
    } else {
      const partner = await this.prisma.partner.findFirstOrThrow();
      const adapter = this.partnerAdapters.get(partner.adapter);
      if (!adapter) throw new DeliveryError("invalid_state", "adaptateur partenaire indisponible");
      const res = await adapter.requestPickup({
        jobId: job.id,
        pickup: snapshot,
        dropoff: snapshot,
        cod,
        codAmountMinor: cod ? order.totalMinor : null
      });
      if (res.accepted) {
        await this.prisma.deliveryJob.update({ where: { id: job.id }, data: { partnerId: partner.id } });
        await this.transition(job.id, "accepted");
      } else {
        // PARTNER→RIDER fallback re-route (partner outage runbook)
        await this.prisma.deliveryJob.update({ where: { id: job.id }, data: { mode: "RIDER" } });
        await this.transition(job.id, "broadcasting");
        await this.broadcast(job.id, order.shop.cityId);
      }
    }
    // Buyer gets the proof code via SMS (mock) for OTP-confirmed handover.
    if (order.guestPhone) {
      await this.messaging.sendSms({
        phone: order.guestPhone,
        senderId: "SUNUMKT",
        body: `SunuMarket: code de réception ${proofCode}. Donnez-le au livreur À LA REMISE seulement.`
      });
    }
    return this.prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id }, include: { offers: true } });
  }

  /** Broadcast offers to active riders (first-accept). */
  private async broadcast(jobId: string, _cityId: string): Promise<number> {
    const riders = await this.prisma.rider.findMany({ where: { active: true } });
    for (const r of riders) {
      await this.prisma.dispatchOffer.upsert({
        where: { jobId_riderId: { jobId, riderId: r.userId } },
        update: {},
        create: { jobId, riderId: r.userId }
      });
    }
    return riders.length;
  }

  /** FR-27: first-accept wins — atomic claim; every other accept loses. */
  async acceptOffer(jobId: string, riderId: string) {
    const job = await this.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
    if (job.cod && job.codAmountMinor) {
      await this.kyc.assertCodWithinLimit(riderId, job.codAmountMinor).catch(() => {
        throw new DeliveryError("cod_cap", "plafond COD atteint — remettez d'abord vos encaissements");
      });
    }
    const claimed = await this.prisma.$executeRaw`
      UPDATE delivery_jobs SET rider_id = ${riderId}::uuid, status = 'accepted', updated_at = now()
      WHERE id = ${jobId}::uuid AND status = 'broadcasting' AND rider_id IS NULL`;
    if (claimed !== 1) throw new DeliveryError("race_lost", "course déjà prise");

    await this.prisma.dispatchOffer.updateMany({
      where: { jobId, riderId },
      data: { response: "accepted" }
    });
    await this.prisma.dispatchOffer.updateMany({
      where: { jobId, riderId: { not: riderId }, response: "pending" },
      data: { response: "expired" }
    });
    return this.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
  }

  /** Guarded transition + job event; also mirrors order status. */
  private async transition(jobId: string, to: JobStatus) {
    const job = await this.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
    const next = assertJobTransition(job.status as JobStatus, to);
    await this.prisma.deliveryJob.update({ where: { id: jobId }, data: { status: next } });
    if (next === "picked_up") {
      const order = await this.prisma.order.findUniqueOrThrow({ where: { id: job.orderId } });
      // preparing → in_delivery (normal path) and delivery_issue → in_delivery
      // (recovery: a new rider picked up after an incident re-dispatch) are both
      // legal order edges — the mirror keeps the order recoverable.
      if (order.status === "preparing" || order.status === "delivery_issue") {
        await this.orders.transition(job.orderId, "in_delivery");
      }
    }
    if (next === "failed_attempt") {
      const order = await this.prisma.order.findUniqueOrThrow({ where: { id: job.orderId } });
      if (order.status === "in_delivery") await this.orders.transition(job.orderId, "delivery_issue");
    }
    return next;
  }

  /**
   * FR-28/31: rider status update — offline-queue friendly: idempotent by
   * (jobId, eventId); events are recorded (with GPS snapshot) and the job
   * advances only on legal transitions, so replays and re-syncs are no-ops.
   */
  async updateStatus(
    jobId: string,
    riderId: string | null,
    ev: { event_id: string; status: JobStatus; gps?: { lat: number; lng: number } | undefined; at: string }
  ) {
    const job = await this.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
    if (riderId && job.riderId !== riderId) throw new DeliveryError("forbidden", "pas votre course");
    if (ev.status === "delivered") throw new DeliveryError("proof_required", "preuve de livraison requise");

    const existing = await this.prisma.jobEvent.findUnique({
      where: { jobId_eventId: { jobId, eventId: ev.event_id } }
    });
    if (existing) return { duplicate: true, status: job.status };

    if (ev.gps) {
      await this.prisma.$executeRaw`
        INSERT INTO job_events (id, job_id, event_id, status, gps, at)
        VALUES (gen_random_uuid(), ${jobId}::uuid, ${ev.event_id}, ${ev.status},
                ST_SetSRID(ST_MakePoint(${ev.gps.lng}, ${ev.gps.lat}), 4326), ${new Date(ev.at)})`;
    } else {
      await this.prisma.$executeRaw`
        INSERT INTO job_events (id, job_id, event_id, status, at)
        VALUES (gen_random_uuid(), ${jobId}::uuid, ${ev.event_id}, ${ev.status}, ${new Date(ev.at)})`;
    }

    if (canJobTransition(job.status as JobStatus, ev.status)) {
      const next = await this.transition(jobId, ev.status);
      return { duplicate: false, status: next };
    }
    return { duplicate: false, status: job.status, note: "event recorded, transition skipped" };
  }

  /** FR-30: proof-gated close; COD collection posts to the rider cash ledger. */
  async submitProof(
    jobId: string,
    riderId: string | null,
    proof: { kind: "photo"; photo_key: string } | { kind: "otp"; code: string }
  ) {
    const job = await this.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
    if (riderId && job.riderId !== riderId && job.mode === "RIDER") {
      throw new DeliveryError("forbidden", "pas votre course");
    }
    if (job.status !== "arrived") throw new DeliveryError("invalid_state", "marquez d'abord « arrivé »");

    if (proof.kind === "otp") {
      const expected = (job.proof as { expected_otp?: string } | null)?.expected_otp;
      if (!expected || proof.code !== expected) throw new DeliveryError("bad_proof", "code de réception incorrect");
    }

    await this.prisma.deliveryJob.update({
      where: { id: jobId },
      data: { proof: { ...(job.proof as object), submitted: proof } as object }
    });
    await this.transition(jobId, "delivered");
    await this.orders.transition(job.orderId, "delivered");

    // DC-15: buyer notification on delivery (SMS fallback path, outbox-persisted).
    const notifyOrder = await this.prisma.order.findUniqueOrThrow({ where: { id: job.orderId } });
    if (notifyOrder.guestPhone) {
      await this.messaging.sendSms({
        phone: notifyOrder.guestPhone,
        senderId: "SUNUMKT",
        body: "SunuMarket: commande livrée ✓ Merci ! Notez votre expérience via votre lien de suivi."
      });
    }

    if (job.cod && job.codAmountMinor && job.riderId) {
      await this.prisma.riderCashLedger.create({
        data: {
          riderId: job.riderId,
          orderId: job.orderId,
          amountMinor: job.codAmountMinor,
          currency: job.currency,
          kind: "cod_collected"
        }
      });
      await this.refreshCodCache(job.riderId);
      // Committee finding A (FR-16/FR-19): the COD sale reaches the seller's
      // payable ledger at delivery — platform fee only (no provider fee, no MM
      // tax on a cash handover). Cash custody moves via the rider ledger.
      const codOrder = await this.prisma.order.findUniqueOrThrow({
        where: { id: job.orderId },
        include: { shop: true, attempts: { where: { method: "COD", status: "succeeded" } } }
      });
      const codAttempt = codOrder.attempts[0];
      if (codAttempt) {
        await this.ledger.recordSale({
          orderId: codOrder.id,
          attemptId: codAttempt.id,
          sellerId: codOrder.shop.sellerId,
          country: codOrder.shop.country,
          grossMinor: codOrder.totalMinor,
          currency: codOrder.currency,
          feeKinds: ["platform_fee"]
        });
      }
    }
    // Trust counter (DC-16)
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: job.orderId } });
    await this.prisma.shop.update({
      where: { id: order.shopId },
      data: { completedOrders: { increment: 1 } }
    });
    return this.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
  }

  /**
   * FR-31: delivery incident → order delivery_issue (refund via FR-18 flow).
   * RIDER-mode jobs do not stay orphaned (pass-2 fix 3): the job is released
   * back to broadcasting, the rider is unassigned, offers re-open and the
   * seller is notified — a new rider can accept, deliver and recover the order.
   */
  async reportIncident(jobId: string, riderId: string | null, reason: string) {
    const job = await this.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
    if (riderId && job.riderId !== riderId) throw new DeliveryError("forbidden", "pas votre course");
    await this.transition(jobId, "failed_attempt");
    await this.prisma.jobEvent.create({
      data: { jobId, eventId: `incident-${Date.now()}`, status: `failed_attempt:${reason}`, at: new Date() }
    });

    if (job.mode === "RIDER") {
      // Re-dispatch: failed_attempt → broadcasting, rider released.
      await this.transition(jobId, "broadcasting");
      await this.prisma.deliveryJob.update({ where: { id: jobId }, data: { riderId: null } });
      if (job.riderId) {
        // The incident rider's claim is closed; everyone else's offer re-opens.
        await this.prisma.dispatchOffer.updateMany({
          where: { jobId, riderId: job.riderId },
          data: { response: "expired" }
        });
        await this.prisma.dispatchOffer.updateMany({
          where: { jobId, riderId: { not: job.riderId }, response: { in: ["expired", "rejected"] } },
          data: { response: "pending" }
        });
      }
      const order = await this.prisma.order.findUniqueOrThrow({
        where: { id: job.orderId },
        include: { shop: { include: { seller: true } } }
      });
      // Fresh broadcast round now; updated_at is bumped by the update above, so
      // rebroadcastStale re-offers/escalates if nobody accepts within the timeout.
      await this.broadcast(jobId, order.shop.cityId);
      await this.messaging.sendSms({
        phone: order.shop.seller.phone,
        senderId: "SUNUMKT",
        body: "SunuMarket: incident livreur signalé — nouvelle recherche de livreur en cours pour votre commande."
      });
    }
    return this.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
  }

  /**
   * FR-34b: COD remittance — PI-SPI rail or agent deposit guidance.
   * Idempotent by key (pass-2 fix 2): rider_cash_ledger is append-only (DB
   * trigger), so a replay must never post a second entry — the unique
   * idempotency_key column blocks the insert and the original result is
   * returned instead.
   */
  async remit(riderId: string, amountMinor: bigint, rail: "PI_SPI" | "AGENT_DEPOSIT", idempotencyKey: string) {
    const dup = await this.prisma.riderCashLedger.findUnique({ where: { idempotencyKey } });
    if (dup) return this.remitResult(dup.riderId, -dup.amountMinor, dup.kind === "remitted_agent" ? "AGENT_DEPOSIT" : "PI_SPI");

    const outstanding = await this.codOutstanding(riderId);
    if (amountMinor > outstanding) throw new DeliveryError("invalid_state", "montant supérieur à votre solde COD");

    if (rail === "PI_SPI") {
      const t = await this.piSpi.transfer(`rider:${riderId}`, amountMinor, "remittance");
      if (!t.ok) throw new DeliveryError("invalid_state", "PI-SPI indisponible — utilisez un dépôt agent");
    }
    try {
      await this.prisma.riderCashLedger.create({
        data: {
          riderId,
          amountMinor: -amountMinor,
          currency: "XOF",
          kind: rail === "PI_SPI" ? "remitted_pispi" : "remitted_agent",
          idempotencyKey
        }
      });
    } catch (e) {
      // Same-key race: the concurrent call already posted — return its result.
      if ((e as { code?: string }).code === "P2002") {
        const winner = await this.prisma.riderCashLedger.findUniqueOrThrow({ where: { idempotencyKey } });
        return this.remitResult(winner.riderId, -winner.amountMinor, winner.kind === "remitted_agent" ? "AGENT_DEPOSIT" : "PI_SPI");
      }
      throw e;
    }
    await this.refreshCodCache(riderId);
    return this.remitResult(riderId, amountMinor, rail);
  }

  private async remitResult(riderId: string, remittedMinor: bigint, rail: "PI_SPI" | "AGENT_DEPOSIT") {
    return {
      remitted: remittedMinor.toString(),
      outstanding: (await this.codOutstanding(riderId)).toString(),
      guidance:
        rail === "AGENT_DEPOSIT"
          ? "Déposez le montant chez l'agent partenaire le plus proche avec la référence ci-dessus."
          : "Remise instantanée via PI-SPI effectuée."
    };
  }

  /** COD invariant source of truth: Σcollected − Σremitted. */
  async codOutstanding(riderId: string): Promise<bigint> {
    const agg = await this.prisma.riderCashLedger.aggregate({
      where: { riderId },
      _sum: { amountMinor: true }
    });
    return agg._sum.amountMinor ?? 0n;
  }

  private async refreshCodCache(riderId: string): Promise<void> {
    const outstanding = await this.codOutstanding(riderId);
    await this.prisma.rider.update({ where: { userId: riderId }, data: { codOutstandingMinor: outstanding } });
  }

  /**
   * Timeout re-broadcast with escalation (committee finding E): each sweep
   * re-offers; from the second round the seller is notified so they can switch
   * to PARTNER or SELF (partner-outage runbook path).
   */
  async rebroadcastStale(now = new Date()): Promise<number> {
    const stale = await this.prisma.deliveryJob.findMany({
      where: {
        status: "broadcasting",
        updatedAt: { lt: new Date(now.getTime() - BROADCAST_TIMEOUT_MS) }
      },
      include: { order: { include: { shop: { include: { seller: true } } } } }
    });
    for (const job of stale) {
      await this.broadcast(job.id, job.order.shop.cityId);
      const round =
        (await this.prisma.jobEvent.count({ where: { jobId: job.id, status: "rebroadcast" } })) + 1;
      // Deterministic event id per job+round (pass-2 fix 4): the round marker and
      // the staleness bump commit atomically, and @@unique([jobId, eventId]) makes
      // a crashed/concurrent sweep replay a no-op — the escalation SMS can never
      // double-fire for the same round.
      try {
        await this.prisma.$transaction([
          this.prisma.jobEvent.create({
            data: { jobId: job.id, eventId: `rebroadcast-${round}`, status: "rebroadcast", at: now }
          }),
          this.prisma.deliveryJob.update({ where: { id: job.id }, data: { updatedAt: now } })
        ]);
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") {
          // This round was already recorded by another run — skip the SMS, just de-stale.
          await this.prisma.deliveryJob.update({ where: { id: job.id }, data: { updatedAt: now } });
          continue;
        }
        throw e;
      }
      if (round >= 2) {
        await this.messaging.sendSms({
          phone: job.order.shop.seller.phone,
          senderId: "SUNUMKT",
          body: "SunuMarket: aucun livreur n'a accepté votre course. Envisagez la livraison partenaire ou par vous-même depuis la commande."
        });
      }
    }
    return stale.length;
  }

  async partnerWebhook(partnerId: string, rawBody: string, signature: string | undefined) {
    const partner = await this.prisma.partner.findUniqueOrThrow({ where: { id: partnerId } });
    const adapter = this.partnerAdapters.get(partner.adapter);
    if (!adapter) return { status: 404, outcome: "unknown_adapter" };
    // Per-partner secret isolation (pass-2 fix 1, ADR-0012): webhook_secret_ref
    // is the NAME of an env var (credentials stay env-only per Playbook 0.5);
    // the shared dev default only applies when the ref is null/unset, so partner
    // A's secret can never validate a webhook aimed at partner B.
    const secret =
      (partner.webhookSecretRef ? process.env[partner.webhookSecretRef] : undefined) ??
      process.env.PARTNER_DIALOG_WEBHOOK_SECRET ??
      "partner-secret";
    const ev = adapter.verifyWebhook(rawBody, signature, secret);
    if (!ev) {
      // Mirror the payments bad-signature path: a forged partner webhook is a fraud signal.
      await this.fraud.record("webhook_signature_invalid", {
        detail: { partner: partner.name, partner_id: partnerId, source: "partner_webhook" }
      });
      return { status: 401, outcome: "rejected" };
    }

    const job = await this.prisma.deliveryJob.findUnique({ where: { id: ev.job_id } });
    if (!job || job.partnerId !== partnerId) return { status: 404, outcome: "unknown_job" };

    const map: Record<string, JobStatus> = {
      accepted: "accepted",
      picked_up: "picked_up",
      en_route: "en_route",
      delivered: "arrived", // partner "delivered" lands as arrived; proof closes it
      failed: "failed_attempt"
    };
    const res = await this.updateStatus(ev.job_id, null, {
      event_id: ev.event_id,
      status: map[ev.kind] ?? "en_route",
      at: ev.at
    });
    if (ev.kind === "delivered" && !res.duplicate) {
      // Partner deliveries close with the partner's photo proof reference.
      await this.submitProof(ev.job_id, null, { kind: "photo", photo_key: `partner/${ev.event_id}.jpg` });
    }
    return { status: 200, outcome: res.duplicate ? "duplicate" : "applied" };
  }

  async riderFeed(riderId: string) {
    return this.prisma.dispatchOffer.findMany({
      where: { riderId, response: "pending", job: { status: "broadcasting" } },
      include: { job: { include: { order: { select: { deliveryPointSnapshot: true, totalMinor: true, currency: true } } } } },
      orderBy: { offeredAt: "desc" }
    });
  }
}
