import type { FastifyInstance } from "fastify";
import { createOrderSchema } from "@sunumarket/shared";
import type { AppDeps } from "../../deps.js";
import { requireRoles } from "../auth/rbac.js";
import { OrderError } from "./orders.service.js";

const ORDER_ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  out_of_stock: 409,
  mixed_shops: 400,
  not_deliverable: 422,
  invalid_state: 409,
  forbidden: 403
};

export function registerOrderRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { orders } = deps;

  // Guest or authenticated: token optional.
  app.post("/orders", async (req, reply) => {
    const body = createOrderSchema.parse(req.body);
    let buyerId: string | null = null;
    try {
      await req.jwtVerify();
      buyerId = req.user.sub;
    } catch {
      if (!body.guest_phone) {
        return reply.code(400).send({ code: "guest_phone_required", message: "téléphone requis pour commander sans compte" });
      }
    }
    try {
      const { order, duplicate } = await orders.createOrder(buyerId, body);
      return reply.code(duplicate ? 200 : 201).send(serializeOrder(order));
    } catch (e) {
      if (e instanceof OrderError) {
        return reply.code(ORDER_ERROR_STATUS[e.code] ?? 400).send({ code: e.code, message: e.message });
      }
      throw e;
    }
  });

  app.get("/orders/:id", { preHandler: requireRoles() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const order = await orders.getForBuyer(id, req.user.sub);
      return serializeOrder(order);
    } catch (e) {
      if (e instanceof OrderError) {
        return reply.code(ORDER_ERROR_STATUS[e.code] ?? 400).send({ code: e.code, message: e.message });
      }
      throw e;
    }
  });

  app.get("/track/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    try {
      return await orders.trackByToken(token);
    } catch (e) {
      if (e instanceof OrderError) return reply.code(404).send({ code: e.code, message: e.message });
      throw e;
    }
  });

  // Buyer cancel — no auth, the tracking token IS the capability (same trust
  // level as GET /track/:token). Only from payment_pending; 409 otherwise.
  app.post("/track/:token/cancel", async (req, reply) => {
    const { token } = req.params as { token: string };
    try {
      const order = await orders.cancelByToken(token);
      return serializeOrder(order);
    } catch (e) {
      if (e instanceof OrderError) {
        return reply.code(ORDER_ERROR_STATUS[e.code] ?? 400).send({ code: e.code, message: e.message });
      }
      throw e;
    }
  });

  app.post("/orders/:id/rotate-tracking", { preHandler: requireRoles("seller") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const o = await orders.rotateTrackingToken(id, req.user.sub);
      return { tracking_token: o.trackingToken };
    } catch (e) {
      if (e instanceof OrderError) {
        return reply.code(ORDER_ERROR_STATUS[e.code] ?? 400).send({ code: e.code, message: e.message });
      }
      throw e;
    }
  });

  app.get("/shops/:id/orders", { preHandler: requireRoles("seller") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const list = await orders.sellerInbox(req.user.sub, id);
      return list.map(serializeOrder);
    } catch (e) {
      if (e instanceof OrderError) {
        return reply.code(ORDER_ERROR_STATUS[e.code] ?? 400).send({ code: e.code, message: e.message });
      }
      throw e;
    }
  });
}

function serializeOrder(o: {
  id: string;
  shopId: string;
  status: string;
  subtotalMinor: bigint;
  deliveryFeeMinor: bigint;
  totalMinor: bigint;
  currency: string;
  deliveryPointSnapshot: unknown;
  trackingToken: string;
  paymentExpiresAt: Date | null;
  createdAt: Date;
  items?: Array<{ productId: string; titleSnapshot: string; qty: number; unitPriceMinor: bigint; currency: string }>;
}) {
  return {
    id: o.id,
    shop_id: o.shopId,
    status: o.status,
    items: (o.items ?? []).map((i) => ({
      product_id: i.productId,
      title: i.titleSnapshot,
      qty: i.qty,
      unit_price: { amount_minor: i.unitPriceMinor.toString(), currency: i.currency }
    })),
    subtotal: { amount_minor: o.subtotalMinor.toString(), currency: o.currency },
    delivery_fee: { amount_minor: o.deliveryFeeMinor.toString(), currency: o.currency },
    total: { amount_minor: o.totalMinor.toString(), currency: o.currency },
    delivery_point: o.deliveryPointSnapshot,
    tracking_token: o.trackingToken,
    payment_expires_at: o.paymentExpiresAt?.toISOString() ?? null,
    created_at: o.createdAt.toISOString()
  };
}
