import type { PrismaClient, Prisma } from "@prisma/client";
import { assertTransition, holdsStock, type OrderStatus } from "@sunumarket/shared";
import { generateToken } from "../../lib/crypto.js";
import type { MessagingProvider } from "../../lib/messaging.js";
import type { GeoApiService } from "../geo/geo.service.js";

const PAYMENT_HOLD_MS = 30 * 60 * 1000; // FR-17: 30-min reservation

export class OrderError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "out_of_stock"
      | "mixed_shops"
      | "not_deliverable"
      | "invalid_state"
      | "forbidden",
    message: string
  ) {
    super(message);
    this.name = "OrderError";
  }
}

export interface CreateOrderInput {
  shop_id: string;
  items: Array<{ product_id: string; qty: number }>;
  delivery_point:
    | { saved_point_id: string }
    | { pin: { lat: number; lng: number; landmark: string; accuracy_m?: number | undefined }; save_as?: string | undefined };
  guest_phone?: string | undefined;
  idempotency_key: string;
}

export class OrdersService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly geo: GeoApiService,
    private readonly messaging: MessagingProvider
  ) {}

  /**
   * FR-36 + Phase 6 verify: race-protected stock (conditional decrement),
   * idempotent (unique key returns the original order), guest checkout,
   * 30-min payment hold with restore-exactly-once on expiry.
   */
  async createOrder(buyerId: string | null, input: CreateOrderInput) {
    const existing = await this.prisma.order.findUnique({
      where: { idempotencyKey: input.idempotency_key },
      include: { items: true }
    });
    if (existing) return { order: existing, duplicate: true };

    // Resolve the delivery pin (saved point or fresh capture).
    let pin: { lat: number; lng: number; landmark: string };
    if ("saved_point_id" in input.delivery_point) {
      const p = await this.geo.getPoint(input.delivery_point.saved_point_id);
      if (!p) throw new OrderError("not_found", "point de livraison introuvable");
      pin = { lat: p.lat, lng: p.lng, landmark: p.landmark };
    } else {
      pin = input.delivery_point.pin;
      if (buyerId || input.delivery_point.save_as) {
        await this.geo.createDeliveryPoint(buyerId, {
          pin,
          ...(input.delivery_point.save_as ? { label: input.delivery_point.save_as } : {})
        });
      }
    }

    const quote = await this.geo.quoteFee(input.shop_id, pin);
    if (!quote.deliverable || !quote.fee) {
      throw new OrderError("not_deliverable", "zone non desservie — contactez le vendeur");
    }

    const products = await this.prisma.product.findMany({
      where: { id: { in: input.items.map((i) => i.product_id) } }
    });
    if (products.length !== input.items.length) throw new OrderError("not_found", "produit introuvable");
    if (products.some((p) => p.shopId !== input.shop_id)) {
      throw new OrderError("mixed_shops", "un seul vendeur par commande (V1)");
    }

    try {
      const order = await this.prisma.$transaction(async (tx) => {
        // Conditional decrement — the race guard: only one concurrent order wins the last unit.
        for (const item of input.items) {
          const updated = await tx.$executeRaw`
            UPDATE products SET stock = stock - ${item.qty}
            WHERE id = ${item.product_id}::uuid AND stock >= ${item.qty}`;
          if (updated !== 1) throw new OrderError("out_of_stock", "stock insuffisant");
        }

        let subtotal = 0n;
        const itemRows = input.items.map((i) => {
          const p = products.find((x) => x.id === i.product_id)!;
          subtotal += p.priceMinor * BigInt(i.qty);
          return {
            productId: p.id,
            titleSnapshot: p.title,
            qty: i.qty,
            unitPriceMinor: p.priceMinor,
            currency: p.currency
          };
        });
        const fee = quote.fee!.amountMinor;

        return tx.order.create({
          data: {
            shopId: input.shop_id,
            buyerId,
            guestPhone: input.guest_phone ?? null,
            status: "payment_pending",
            subtotalMinor: subtotal,
            deliveryFeeMinor: fee,
            totalMinor: subtotal + fee,
            currency: "XOF",
            deliveryPointSnapshot: pin as object,
            idempotencyKey: input.idempotency_key,
            trackingToken: generateToken(16),
            paymentExpiresAt: new Date(Date.now() + PAYMENT_HOLD_MS)
          },
          include: { items: true }
        }).then(async (o) => {
          await tx.orderItem.createMany({ data: itemRows.map((r) => ({ ...r, orderId: o.id })) });
          return tx.order.findUniqueOrThrow({ where: { id: o.id }, include: { items: true } });
        });
      });
      // DC-15 / pass-2 fix 5: the buyer (esp. COD/guest) must not lose the
      // tracking link when the browser closes — SMS it with the confirmation.
      await this.sendConfirmationSms(buyerId, input.guest_phone ?? null, order.trackingToken);
      return { order, duplicate: false };
    } catch (e) {
      // Idempotency race: two same-key requests in flight — return the winner's order.
      if ((e as { code?: string }).code === "P2002") {
        const winner = await this.prisma.order.findUnique({
          where: { idempotencyKey: input.idempotency_key },
          include: { items: true }
        });
        if (winner) return { order: winner, duplicate: true };
      }
      throw e;
    }
  }

  /** Order-confirmation SMS with the tokenized tracking link (FR-38 companion). */
  private async sendConfirmationSms(buyerId: string | null, guestPhone: string | null, trackingToken: string): Promise<void> {
    let phone = guestPhone;
    if (!phone && buyerId) {
      const buyer = await this.prisma.user.findUnique({ where: { id: buyerId } });
      phone = buyer?.phone ?? null;
    }
    if (!phone || phone.startsWith("deleted:")) return;
    const base = process.env.PUBLIC_WEB_URL ?? "https://sunumarket.example";
    await this.messaging.sendSms({
      phone,
      senderId: "SUNUMKT",
      body: `SunuMarket: commande reçue ✓ Suivez votre livraison ici: ${base}/#/track/${trackingToken}`
    });
  }

  /** Guarded transition through the shared state machine. */
  async transition(orderId: string, to: OrderStatus, tx?: Prisma.TransactionClient) {
    const db = tx ?? this.prisma;
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    const next = assertTransition(order.status as OrderStatus, to);
    const updated = await db.order.update({ where: { id: orderId }, data: { status: next } });
    if (!holdsStock(next) && !order.stockRestored) {
      await this.restoreStockOnce(orderId, db);
    }
    return updated;
  }

  /** FR-17: expiry restores stock exactly once (guarded by stock_restored flag). */
  private async restoreStockOnce(orderId: string, db: Prisma.TransactionClient | PrismaClient) {
    const claimed = await db.$executeRaw`
      UPDATE orders SET stock_restored = true
      WHERE id = ${orderId}::uuid AND stock_restored = false`;
    if (claimed !== 1) return; // someone else already restored
    const items = await db.orderItem.findMany({ where: { orderId } });
    for (const item of items) {
      await db.$executeRaw`
        UPDATE products SET stock = stock + ${item.qty} WHERE id = ${item.productId}::uuid`;
    }
  }

  /** Worker sweep: delivered orders auto-complete after the review window (FR-36). */
  async autoCompleteDelivered(now = new Date(), windowDays = 3): Promise<number> {
    const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
    const due = await this.prisma.order.findMany({
      where: { status: "delivered", updatedAt: { lt: cutoff } },
      select: { id: true }
    });
    for (const o of due) await this.transition(o.id, "completed");
    return due.length;
  }

  /** Expiry sweep (worker): payment_pending past the hold → expired + restock. */
  async expireOverdueOrders(now = new Date()): Promise<number> {
    const overdue = await this.prisma.order.findMany({
      where: { status: "payment_pending", paymentExpiresAt: { lt: now } },
      select: { id: true }
    });
    for (const o of overdue) {
      await this.transition(o.id, "expired");
    }
    return overdue.length;
  }

  async getForBuyer(orderId: string, buyerId: string | null, guestPhone?: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw new OrderError("not_found", "commande introuvable");
    const owns = (buyerId && order.buyerId === buyerId) || (guestPhone && order.guestPhone === guestPhone);
    if (!owns) throw new OrderError("forbidden", "accès refusé");
    return order;
  }

  /** Tokenized tracking (no auth) — FR-38. */
  async trackByToken(token: string) {
    const order = await this.prisma.order.findUnique({
      where: { trackingToken: token },
      include: { job: { include: { events: { orderBy: { at: "asc" } } } } }
    });
    if (!order) throw new OrderError("not_found", "lien de suivi invalide");
    return {
      // Pass-3 (B3): the order id lets the tracking page open disputes/ratings
      // (guest-authenticated by phone) — the token remains the read capability.
      order_id: order.id,
      status: order.status,
      delivery_status: order.job?.status ?? null,
      eta_hint: null,
      history: (order.job?.events ?? []).map((e) => ({ status: e.status, at: e.at.toISOString() }))
    };
  }

  /**
   * Pass-2 fix 6: buyer cancel via the tracking token (the token IS the
   * capability, same trust level as GET /track/:token). Only while the order
   * is still payment_pending — a paid order refunds through admin/seller flows.
   * Stock restores exactly once via the stock_restored guard in transition().
   */
  async cancelByToken(token: string) {
    const order = await this.prisma.order.findUnique({ where: { trackingToken: token } });
    if (!order) throw new OrderError("not_found", "lien de suivi invalide");
    if (order.status !== "payment_pending") {
      throw new OrderError("invalid_state", "annulation impossible — la commande n'est plus en attente de paiement");
    }
    // Close any open payment attempt; money that still lands hits the late-webhook
    // auto-refund path (ADR-0007), never a cancelled order.
    await this.prisma.paymentAttempt.updateMany({
      where: { orderId: order.id, status: { in: ["initiated", "ussd_pending"] } },
      data: { status: "cancelled", failureReason: "buyer_cancelled" }
    });
    await this.transition(order.id, "cancelled");
    return this.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
  }

  async rotateTrackingToken(orderId: string, sellerId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { shop: true } });
    if (order.shop.sellerId !== sellerId) throw new OrderError("forbidden", "pas votre commande");
    return this.prisma.order.update({
      where: { id: orderId },
      data: { trackingToken: generateToken(16) }
    });
  }

  /** Seller inbox — FR-37. */
  async sellerInbox(sellerId: string, shopId: string) {
    const shop = await this.prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    if (shop.sellerId !== sellerId) throw new OrderError("forbidden", "pas votre boutique");
    return this.prisma.order.findMany({
      where: { shopId },
      orderBy: { createdAt: "desc" },
      include: { items: true },
      take: 100
    });
  }
}
