import { z } from "zod";
import { moneySchema } from "../money/money.js";

export const uuidSchema = z.string().uuid();

/** E.164; country-specific regex comes from the Country Config Pack at runtime. */
export const phoneSchema = z.string().regex(/^\+\d{8,15}$/, "phone must be E.164 (+XXX...)");

export const countryCodeSchema = z.enum(["SN", "CI", "BF", "ML", "TG", "BJ", "NE"]);
export type CountryCode = z.infer<typeof countryCodeSchema>;

export const localeSchema = z.enum(["fr", "en"]);

export const idempotencyKeySchema = z.string().min(8).max(128);

export const paginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional()
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** GPS pin: WGS84. Landmark is mandatory — it IS the address format (Goal §2). */
export const gpsPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy_m: z.number().nonnegative().optional(),
  landmark: z.string().min(3).max(200)
});
export type GpsPoint = z.infer<typeof gpsPointSchema>;

export { moneySchema };
