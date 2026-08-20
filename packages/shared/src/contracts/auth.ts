import { z } from "zod";
import { countryCodeSchema, localeSchema, phoneSchema, uuidSchema } from "./common.js";

export const roleSchema = z.enum(["buyer", "seller", "rider", "partner", "admin"]);
export type Role = z.infer<typeof roleSchema>;

export const kycTierSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

export const requestOtpSchema = z.object({
  phone: phoneSchema,
  country: countryCodeSchema,
  device_hash: z.string().min(8).max(128)
});

export const verifyOtpSchema = z.object({
  phone: phoneSchema,
  code: z.string().regex(/^\d{6}$/),
  device_hash: z.string().min(8).max(128)
});

export const tokenPairSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  /** DC-8.3: true when a new device on a Tier≥1 account forces re-verification. */
  reverify_required: z.boolean().default(false)
});

export const refreshSchema = z.object({ refresh_token: z.string() });

export const userSchema = z.object({
  id: uuidSchema,
  phone: phoneSchema,
  name: z.string().nullable(),
  roles: z.array(roleSchema),
  country: countryCodeSchema,
  locale: localeSchema,
  kyc_tier: kycTierSchema
});
export type User = z.infer<typeof userSchema>;

export const kycUpgradeRequestSchema = z.object({
  target_tier: z.union([z.literal(1), z.literal(2)]),
  id_document_key: z.string(),
  address: z.string().optional(),
  vehicle: z.string().optional()
});
