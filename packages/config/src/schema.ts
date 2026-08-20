import { z } from "zod";
import { paymentMethodSchema } from "@sunumarket/shared/contracts/payments";

/**
 * Country Config Pack — FR-49 / ADR-0008.
 * One versioned data bundle per country. Activating a Wave-2 country = pack + credentials,
 * zero code (NFR-8). Money limits are decimal strings of minor units (DC-5).
 */

const minorAmountSchema = z.string().regex(/^\d+$/, "minor units as decimal string");

export const packMethodSchema = z.object({
  type: paymentMethodSchema,
  enabled: z.boolean(),
  /** 1 = dominant; checkout renders ascending (DC-1). */
  order: z.number().int().min(1),
  label: z.string(),
  /** DC-14: USSD-confirmed methods carry the operator dial code shown on the confirm screen. */
  ussd_confirm: z.boolean().default(false),
  ussd_dial_code: z.string().optional(),
  /** Dated planning input, never a runtime constant (Goal §12). */
  market_share_note: z.string().optional()
});

export const providerRouteSchema = z.object({
  method: paymentMethodSchema,
  primary: z.string().min(1),
  fallback: z.string().min(1).nullable()
});

export const feePassThroughSchema = z.object({
  kind: z.enum(["provider_fee", "mm_transaction_tax", "platform_fee", "delivery_fee"]),
  bearer: z.enum(["platform", "seller", "buyer"]),
  /** Transparent pre-payment display (DC-11). */
  display_fr: z.string(),
  display_en: z.string(),
  /** Basis points where proportional; absolute minor units where flat. */
  bps: z.number().int().min(0).max(10000).optional(),
  flat_minor: minorAmountSchema.optional()
});

export const kycTierLimitSchema = z.object({
  payout_daily_minor: minorAmountSchema,
  cod_outstanding_minor: minorAmountSchema
});

export const complianceItemSchema = z.object({
  id: z.string(),
  label_fr: z.string(),
  authority: z.string(),
  status: z.enum(["todo", "in_progress", "done", "n/a"])
});

export const countryPackSchema = z
  .object({
    country: z.enum(["SN", "CI", "BF", "ML", "TG", "BJ", "NE"]),
    version: z.number().int().min(1),
    /** Wave-2 drafts ship as draft until launch-approved. */
    status: z.enum(["active", "draft"]),
    currency: z.enum(["XOF", "GHS", "NGN", "KES"]),
    language_default: z.enum(["fr", "en"]),
    phone: z.object({
      calling_code: z.string().regex(/^\+\d{1,4}$/),
      regex: z.string(),
      example: z.string()
    }),
    methods: z.array(packMethodSchema).min(2),
    provider_routes: z.array(providerRouteSchema),
    fees_taxes: z.object({
      note: z.string().optional(),
      pass_through: z.array(feePassThroughSchema)
    }),
    kyc_tiers: z.object({
      tier0: kycTierLimitSchema,
      tier1: kycTierLimitSchema,
      tier2: kycTierLimitSchema
    }),
    sms_sender_ids: z.array(z.string()).min(1),
    compliance_checklist: z.array(complianceItemSchema),
    zones_ref: z.string(),
    market_data_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  })
  .superRefine((pack, ctx) => {
    // DC-8.2: MANUAL_TRANSFER must never ship enabled by default in an active pack.
    const manual = pack.methods.find((m) => m.type === "MANUAL_TRANSFER");
    if (manual?.enabled && pack.status === "active" && !process.env.SUNU_ALLOW_MANUAL_TRANSFER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MANUAL_TRANSFER must be admin-enabled at runtime, not enabled in a pack (DC-8.2)"
      });
    }
    // Every enabled non-COD/non-manual method needs a provider route.
    for (const m of pack.methods) {
      if (!m.enabled || m.type === "COD" || m.type === "MANUAL_TRANSFER") continue;
      if (!pack.provider_routes.some((r) => r.method === m.type)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `enabled method ${m.type} has no provider route`
        });
      }
    }
    // USSD-confirmed methods must carry a dial code (DC-14).
    for (const m of pack.methods) {
      if (m.enabled && m.ussd_confirm && !m.ussd_dial_code) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `USSD-confirmed method ${m.type} missing ussd_dial_code (DC-14)`
        });
      }
    }
    // Method ordering must be unique.
    const orders = pack.methods.map((m) => m.order);
    if (new Set(orders).size !== orders.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "method orders must be unique" });
    }
  });

export type CountryPack = z.infer<typeof countryPackSchema>;
export type PackMethod = z.infer<typeof packMethodSchema>;
