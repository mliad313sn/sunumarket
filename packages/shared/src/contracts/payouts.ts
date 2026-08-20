import { z } from "zod";
import { moneySchema } from "../money/money.js";
import { idempotencyKeySchema, uuidSchema } from "./common.js";

export const payoutRequestSchema = z.object({
  amount: moneySchema,
  /** DC-8.3: required when the account has a payout PIN set. */
  payout_pin: z.string().regex(/^\d{4,6}$/).optional(),
  idempotency_key: idempotencyKeySchema
});

export const payoutSchema = z.object({
  id: uuidSchema,
  amount: moneySchema,
  rail: z.enum(["PI_SPI", "AGGREGATOR"]),
  status: z.enum(["requested", "processing", "settled", "failed", "held_review"]),
  created_at: z.string().datetime()
});
export type Payout = z.infer<typeof payoutSchema>;

export const balanceSchema = z.object({
  available: moneySchema,
  pending: moneySchema,
  payout_limit_remaining_today: moneySchema
});
