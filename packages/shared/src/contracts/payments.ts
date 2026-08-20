import { z } from "zod";
import { moneySchema } from "../money/money.js";
import { countryCodeSchema, idempotencyKeySchema, uuidSchema } from "./common.js";

/**
 * FR-13 — V1 method types. Schema-ready (not launched): MPESA,
 * BANK_TRANSFER_INSTANT, AIRTEL_MONEY (DC-5): they parse, packs never enable them in V1.
 */
export const paymentMethodSchema = z.enum([
  "WAVE",
  "ORANGE_MONEY",
  "MTN_MOMO",
  "MOOV_MONEY",
  "MIXX_BY_YAS",
  "PI_SPI",
  "CARD",
  "COD",
  "MANUAL_TRANSFER",
  "MPESA",
  "BANK_TRANSFER_INSTANT",
  "AIRTEL_MONEY"
]);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const attemptStatusSchema = z.enum([
  "initiated",
  "ussd_pending",
  "succeeded",
  "succeeded_late",
  "failed",
  "expired",
  "cancelled"
]);
export type AttemptStatus = z.infer<typeof attemptStatusSchema>;

export const createAttemptSchema = z.object({
  method: paymentMethodSchema,
  idempotency_key: idempotencyKeySchema
});

export const attemptSchema = z.object({
  id: uuidSchema,
  order_id: uuidSchema,
  method: paymentMethodSchema,
  status: attemptStatusSchema,
  provider_code: z.string(),
  provider_ref: z.string().nullable(),
  amount: moneySchema,
  /** DC-14: populated for USSD-confirmed methods. */
  ussd: z
    .object({
      dial_code: z.string(),
      expires_in_s: z.number().int(),
      can_resend: z.boolean()
    })
    .nullable(),
  /** Redirect / QR payload when the provider flow needs one (Wave QR, PI-SPI alias). */
  next_action: z
    .object({
      kind: z.enum(["redirect", "qr", "ussd_confirm", "manual_reference", "none"]),
      url: z.string().url().optional(),
      qr_payload: z.string().optional(),
      manual_reference: z.string().optional()
    })
    .optional(),
  failure_reason: z.string().nullable(),
  created_at: z.string().datetime()
});
export type Attempt = z.infer<typeof attemptSchema>;

/** GET /checkout/methods — pack ∩ seller subset, dominant first (FR-13). */
export const checkoutMethodsResponseSchema = z.object({
  country: countryCodeSchema,
  methods: z.array(
    z.object({
      method: paymentMethodSchema,
      label: z.string(),
      ussd_confirm: z.boolean(),
      remembered_default: z.boolean(),
      fee_display: z.string().optional()
    })
  )
});

/** Provider-agnostic webhook envelope after adapter verification. */
export const webhookResultSchema = z.object({
  provider_code: z.string(),
  event_id: z.string(),
  provider_ref: z.string(),
  kind: z.enum(["payment_succeeded", "payment_failed", "refund_succeeded", "refund_failed"]),
  amount: moneySchema.optional(),
  occurred_at: z.string().datetime()
});
export type WebhookResult = z.infer<typeof webhookResultSchema>;

export const refundRequestSchema = z.object({
  reason: z.string().min(3),
  idempotency_key: idempotencyKeySchema
});
