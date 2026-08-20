import { z } from "zod";
import { moneySchema } from "../money/money.js";
import { gpsPointSchema, uuidSchema } from "./common.js";

export const createDeliveryPointSchema = z.object({
  pin: gpsPointSchema,
  label: z.string().max(60).optional(),
  /** FR-25: explicit consent per capture — location data is sensitive. */
  consent: z.literal(true)
});

export const deliveryPointSchema = z.object({
  id: uuidSchema,
  pin: gpsPointSchema,
  label: z.string().nullable(),
  created_at: z.string().datetime()
});

/** FR-24: polygon zone > radius band > out-of-zone (quote or refuse). */
export const feeQuoteRequestSchema = z.object({
  shop_id: uuidSchema,
  pin: gpsPointSchema.pick({ lat: true, lng: true })
});

export const feeQuoteSchema = z.object({
  fee: moneySchema.nullable(),
  zone_name: z.string().nullable(),
  resolution: z.enum(["zone_polygon", "radius_band", "out_of_zone"]),
  deliverable: z.boolean()
});
export type FeeQuote = z.infer<typeof feeQuoteSchema>;
