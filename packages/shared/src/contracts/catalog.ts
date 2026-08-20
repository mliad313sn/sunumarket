import { z } from "zod";
import { moneySchema } from "../money/money.js";
import { countryCodeSchema, paginationQuerySchema, uuidSchema } from "./common.js";
import { paymentMethodSchema } from "./payments.js";

export const createShopSchema = z.object({
  name: z.string().min(2).max(80),
  country: countryCodeSchema,
  city_id: uuidSchema,
  description: z.string().max(500).optional(),
  whatsapp_phone: z.string().optional()
});

export const shopSchema = createShopSchema.extend({
  id: uuidSchema,
  slug: z.string(),
  seller_id: uuidSchema,
  verified: z.boolean(),
  completed_orders: z.number().int(),
  enabled_methods: z.array(paymentMethodSchema)
});
export type Shop = z.infer<typeof shopSchema>;

export const createProductSchema = z.object({
  title: z.string().min(2).max(120),
  description: z.string().max(2000).optional(),
  price: moneySchema,
  stock: z.number().int().min(0),
  image_keys: z.array(z.string()).max(6)
});

export const productSchema = createProductSchema.extend({
  id: uuidSchema,
  shop_id: uuidSchema,
  status: z.enum(["draft", "active", "archived"]),
  created_at: z.string().datetime()
});
export type Product = z.infer<typeof productSchema>;

export const marketplaceQuerySchema = paginationQuerySchema.extend({
  country: countryCodeSchema.optional(),
  city_id: uuidSchema.optional(),
  q: z.string().max(100).optional()
});
