import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

import { apiErrorSchema } from "./common.js";
import {
  refreshSchema,
  requestOtpSchema,
  tokenPairSchema,
  userSchema,
  verifyOtpSchema,
  kycUpgradeRequestSchema
} from "./auth.js";
import {
  createProductSchema,
  createShopSchema,
  marketplaceQuerySchema,
  productSchema,
  shopSchema
} from "./catalog.js";
import { createOrderSchema, orderSchema, trackingViewSchema } from "./orders.js";
import {
  attemptSchema,
  checkoutMethodsResponseSchema,
  createAttemptSchema,
  refundRequestSchema
} from "./payments.js";
import { createDeliveryPointSchema, deliveryPointSchema, feeQuoteRequestSchema, feeQuoteSchema } from "./geo.js";
import {
  codRemittanceSchema,
  deliveryJobSchema,
  deliveryProofSchema,
  jobStatusUpdateSchema,
  requestDeliverySchema
} from "./delivery.js";
import { balanceSchema, payoutRequestSchema, payoutSchema } from "./payouts.js";

export interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths?: Record<string, Record<string, { operationId?: string; tags?: string[]; summary?: string; responses?: Record<string, unknown> }>>;
}

export function buildOpenApiDocument(): OpenApiDoc {
  const registry = new OpenAPIRegistry();

  const err = registry.register("ApiError", apiErrorSchema);
  const errorResponse = {
    description: "Error",
    content: { "application/json": { schema: err } }
  };

  const routes: Array<{
    method: "get" | "post" | "patch" | "delete";
    path: string;
    operationId: string;
    tag: string;
    request?: { body?: z.ZodTypeAny; query?: z.ZodTypeAny };
    response: z.ZodTypeAny | null;
    summary: string;
  }> = [
    { method: "post", path: "/auth/otp", operationId: "requestOtp", tag: "auth", request: { body: requestOtpSchema }, response: z.object({ sent: z.boolean() }), summary: "Request login OTP (SMS)" },
    { method: "post", path: "/auth/verify", operationId: "verifyOtp", tag: "auth", request: { body: verifyOtpSchema }, response: tokenPairSchema, summary: "Verify OTP, issue token pair; flags new-device re-verify (DC-8.3)" },
    { method: "post", path: "/auth/refresh", operationId: "refreshToken", tag: "auth", request: { body: refreshSchema }, response: tokenPairSchema, summary: "Rotate refresh token" },
    { method: "get", path: "/me", operationId: "getMe", tag: "auth", response: userSchema, summary: "Current user" },
    { method: "delete", path: "/me", operationId: "deleteMe", tag: "auth", response: z.object({ anonymized: z.boolean() }), summary: "Anonymizing account delete (FR-25 privacy) — 409 while orders/COD/ledger balance are outstanding" },
    { method: "post", path: "/kyc/upgrade", operationId: "requestKycUpgrade", tag: "auth", request: { body: kycUpgradeRequestSchema }, response: z.object({ status: z.string() }), summary: "Request KYC tier upgrade (DC-13)" },

    { method: "post", path: "/shops", operationId: "createShop", tag: "catalog", request: { body: createShopSchema }, response: shopSchema, summary: "Create shop (wizard ≤5 steps)" },
    { method: "get", path: "/shops/{slug}", operationId: "getShop", tag: "catalog", response: shopSchema, summary: "Public shop page" },
    { method: "post", path: "/shops/{id}/products", operationId: "createProduct", tag: "catalog", request: { body: createProductSchema }, response: productSchema, summary: "Create product (≤60 s from photos)" },
    { method: "get", path: "/marketplace", operationId: "browseMarketplace", tag: "catalog", request: { query: marketplaceQuerySchema }, response: z.object({ items: z.array(productSchema), next_cursor: z.string().nullable() }), summary: "Browse marketplace" },

    { method: "post", path: "/delivery-points", operationId: "createDeliveryPoint", tag: "geo", request: { body: createDeliveryPointSchema }, response: deliveryPointSchema, summary: "Save GPS pin + landmark (consent-gated, FR-21/25)" },
    { method: "post", path: "/fees/quote", operationId: "quoteDeliveryFee", tag: "geo", request: { body: feeQuoteRequestSchema }, response: feeQuoteSchema, summary: "Zone/radius fee resolution pre-payment (FR-24)" },

    { method: "post", path: "/orders", operationId: "createOrder", tag: "orders", request: { body: createOrderSchema }, response: orderSchema, summary: "Create order (guest or account; idempotent)" },
    { method: "get", path: "/orders/{id}", operationId: "getOrder", tag: "orders", response: orderSchema, summary: "Order detail" },
    { method: "get", path: "/track/{token}", operationId: "trackOrder", tag: "orders", response: trackingViewSchema, summary: "Tokenized tracking view (no auth)" },

    { method: "get", path: "/checkout/{orderId}/methods", operationId: "listCheckoutMethods", tag: "payments", response: checkoutMethodsResponseSchema, summary: "Method matrix: pack ∩ seller subset, dominant first (FR-13)" },
    { method: "post", path: "/orders/{id}/attempts", operationId: "createPaymentAttempt", tag: "payments", request: { body: createAttemptSchema }, response: attemptSchema, summary: "Start payment attempt (routed, retry-able, FR-14/17)" },
    { method: "get", path: "/attempts/{id}", operationId: "getAttempt", tag: "payments", response: attemptSchema, summary: "Attempt status (USSD countdown polling)" },
    { method: "post", path: "/webhooks/{provider}", operationId: "providerWebhook", tag: "payments", response: null, summary: "Signed provider webhook — sole source of paid (DC-8.1)" },
    { method: "post", path: "/orders/{id}/refund", operationId: "refundOrder", tag: "payments", request: { body: refundRequestSchema }, response: z.object({ status: z.string() }), summary: "Refund per method (FR-18)" },

    { method: "post", path: "/deliveries", operationId: "requestDelivery", tag: "delivery", request: { body: requestDeliverySchema }, response: deliveryJobSchema, summary: "Request delivery (SELF/RIDER/PARTNER)" },
    { method: "post", path: "/jobs/{id}/accept", operationId: "acceptJob", tag: "delivery", response: deliveryJobSchema, summary: "Rider first-accept (race-protected)" },
    { method: "post", path: "/jobs/{id}/status", operationId: "updateJobStatus", tag: "delivery", request: { body: jobStatusUpdateSchema }, response: deliveryJobSchema, summary: "Status update (offline-queued, idempotent)" },
    { method: "post", path: "/jobs/{id}/proof", operationId: "submitProof", tag: "delivery", request: { body: deliveryProofSchema }, response: deliveryJobSchema, summary: "Proof of delivery (photo/OTP) gates close" },
    { method: "post", path: "/riders/remittances", operationId: "remitCod", tag: "delivery", request: { body: codRemittanceSchema }, response: z.object({ status: z.string() }), summary: "COD remittance via PI-SPI or agent deposit (FR-34b)" },

    { method: "get", path: "/balance", operationId: "getBalance", tag: "payouts", response: balanceSchema, summary: "Seller/rider balance view" },
    { method: "post", path: "/payouts", operationId: "requestPayout", tag: "payouts", request: { body: payoutRequestSchema }, response: payoutSchema, summary: "Payout — PI-SPI first, tier limits (FR-20)" }
  ];

  for (const r of routes) {
    registry.registerPath({
      method: r.method,
      path: r.path,
      operationId: r.operationId,
      tags: [r.tag],
      summary: r.summary,
      request: {
        ...(r.request?.body
          ? { body: { content: { "application/json": { schema: r.request.body } } } }
          : {}),
        ...(r.request?.query ? { query: r.request.query as never } : {})
      },
      responses: {
        200: r.response
          ? { description: "OK", content: { "application/json": { schema: r.response } } }
          : { description: "OK" },
        400: errorResponse,
        401: errorResponse
      }
    });
  }

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "SunuMarket API",
      version: "1.0.0",
      description:
        "Contract-first API generated from packages/shared Zod schemas (Phase 1). Money is always {amount_minor, currency} — DC-5."
    },
    servers: [{ url: "/v1" }]
  }) as unknown as OpenApiDoc;
}
