import type { WebhookResult } from "@sunumarket/shared";

/** FR-14 — PaymentProvider interface. Adapters are thin & config-selected; mocks first. */

export interface InitRequest {
  attemptId: string;
  orderId: string;
  method: string;
  amountMinor: bigint;
  currency: string;
  buyerPhone: string | null;
  /** Test/dev scenario steering for mocks (never read by real adapters). */
  mockScenario?: string | undefined;
}

export type InitResult =
  | { ok: true; providerRef: string; status: "initiated" | "ussd_pending"; next: NextAction }
  | { ok: false; kind: "declined"; reason: string }
  | { ok: false; kind: "provider_error"; reason: string };

export type NextAction =
  | { kind: "redirect"; url: string }
  | { kind: "qr"; qr_payload: string }
  | { kind: "ussd_confirm" }
  | { kind: "manual_reference"; manual_reference: string }
  | { kind: "none" };

export interface RefundResult {
  ok: boolean;
  providerRef?: string;
  reason?: string;
}

export interface PaymentProvider {
  readonly code: string;
  init(req: InitRequest): Promise<InitResult>;
  refund(providerRef: string, amountMinor: bigint, currency: string): Promise<RefundResult>;
  /**
   * NFR-3 signature isolation: each adapter verifies with its OWN secret and
   * algorithm; returns null on any signature mismatch.
   */
  verifyWebhook(rawBody: string, signatureHeader: string | undefined): WebhookResult | null;
  /** Active health probe for the routing layer. */
  probe(): Promise<boolean>;
}
