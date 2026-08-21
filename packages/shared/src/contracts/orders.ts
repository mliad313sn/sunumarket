import { z } from "zod";
import { moneySchema } from "../money/money.js";
import { gpsPointSchema, idempotencyKeySchema, phoneSchema, uuidSchema } from "./common.js";

/** FR-36 — canonical order lifecycle (state machine implemented in Phase 6). */
export const orderStatusSchema = z.enum([
  "created",
  "payment_pending",
  "payment_review",
  "paid",
  "preparing",
  "in_delivery",
  "delivery_issue",
  "delivered",
  "completed",
  "cancelled",
  "expired",
  "refunded"
]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

export const createOrderSchema = z.object({
  shop_id: uuidSchema,
  items: z
    .array(z.object({ product_id: uuidSchema, qty: z.number().int().min(1).max(99) }))
    .min(1),
  delivery_point: z.union([
    z.object({ saved_point_id: uuidSchema }),
    z.object({ pin: gpsPointSchema, save_as: z.string().optional() })
  ]),
  /** Guest checkout (FR-36): phone instead of account. */
  guest_phone: phoneSchema.optional(),
  idempotency_key: idempotencyKeySchema
});

export const orderSchema = z.object({
  id: uuidSchema,
  shop_id: uuidSchema,
  status: orderStatusSchema,
  items: z.array(
    z.object({
      product_id: uuidSchema,
      title: z.string(),
      qty: z.number().int(),
      unit_price: moneySchema
    })
  ),
  subtotal: moneySchema,
  delivery_fee: moneySchema,
  total: moneySchema,
  delivery_point: gpsPointSchema,
  tracking_token: z.string(),
  payment_expires_at: z.string().datetime().nullable(),
  created_at: z.string().datetime()
});
export type Order = z.infer<typeof orderSchema>;

export const trackingViewSchema = z.object({
  order_id: uuidSchema,
  status: orderStatusSchema,
  delivery_status: z.string().nullable(),
  eta_hint: z.string().nullable(),
  history: z.array(z.object({ status: z.string(), at: z.string().datetime() }))
});
