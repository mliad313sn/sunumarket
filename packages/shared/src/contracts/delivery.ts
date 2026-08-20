import { z } from "zod";
import { moneySchema } from "../money/money.js";
import { gpsPointSchema, uuidSchema } from "./common.js";

export const deliveryModeSchema = z.enum(["SELF", "RIDER", "PARTNER"]);

/** FR-26 dispatch/job state machine (implemented Phase 9). */
export const jobStatusSchema = z.enum([
  "requested",
  "broadcasting",
  "accepted",
  "picked_up",
  "en_route",
  "arrived",
  "delivered",
  "failed_attempt",
  "cancelled"
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const requestDeliverySchema = z.object({
  order_id: uuidSchema,
  mode: deliveryModeSchema
});

export const deliveryJobSchema = z.object({
  id: uuidSchema,
  order_id: uuidSchema,
  mode: deliveryModeSchema,
  status: jobStatusSchema,
  rider_id: uuidSchema.nullable(),
  partner_id: uuidSchema.nullable(),
  fee: moneySchema,
  cod: z.boolean(),
  cod_amount: moneySchema.nullable(),
  dropoff: gpsPointSchema
});
export type DeliveryJob = z.infer<typeof deliveryJobSchema>;

/** Rider status update — offline-queued, idempotent by event_id (ADR-0012). */
export const jobStatusUpdateSchema = z.object({
  event_id: z.string().uuid(),
  status: jobStatusSchema,
  gps: gpsPointSchema.pick({ lat: true, lng: true, accuracy_m: true }).optional(),
  at: z.string().datetime()
});

export const deliveryProofSchema = z.union([
  z.object({ kind: z.literal("photo"), photo_key: z.string() }),
  z.object({ kind: z.literal("otp"), code: z.string().regex(/^\d{4,6}$/) })
]);

export const codRemittanceSchema = z.object({
  amount: moneySchema,
  rail: z.enum(["PI_SPI", "AGENT_DEPOSIT"]),
  idempotency_key: z.string().min(8).max(128)
});
