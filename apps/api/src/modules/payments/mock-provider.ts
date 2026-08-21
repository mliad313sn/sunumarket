import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { WebhookResult } from "@sunumarket/shared";
import type { InitRequest, InitResult, PaymentProvider, RefundResult } from "./provider.js";

/**
 * MockPaymentProvider — Playbook 0.5. Covers WAVE, ORANGE_MONEY, MTN_MOMO,
 * MOOV_MONEY, MIXX_BY_YAS, CARD with scenarios:
 *   success | decline | ussd_pending (→ confirm/timeout via completeUssd) |
 *   late-webhook (success, webhook built later by test) | provider_500 | timeout
 * Scenario source: InitRequest.mockScenario, else per-provider forced scenario,
 * else "success". USSD-confirmed methods default to ussd_pending.
 */
export class MockPaymentProvider implements PaymentProvider {
  /** Force every init to behave this way (outage simulation). */
  forcedScenario: string | null = null;
  down = false;
  readonly initCalls: InitRequest[] = [];
  readonly refunds: Array<{ providerRef: string; amountMinor: bigint }> = [];

  constructor(
    public readonly code: string,
    private readonly secret: string,
    private readonly ussdMethods: Set<string> = new Set(["ORANGE_MONEY", "MTN_MOMO", "MOOV_MONEY", "MIXX_BY_YAS"])
  ) {}

  async init(req: InitRequest): Promise<InitResult> {
    this.initCalls.push(req);
    const scenario =
      this.forcedScenario ??
      req.mockScenario ??
      (this.ussdMethods.has(req.method) ? "ussd_pending" : "success");

    if (this.down || scenario === "provider_500") {
      return { ok: false, kind: "provider_error", reason: "HTTP 500 from provider" };
    }
    if (scenario === "timeout") {
      return { ok: false, kind: "provider_error", reason: "timeout after 10s" };
    }
    if (scenario === "decline") {
      return { ok: false, kind: "declined", reason: "solde insuffisant" };
    }
    const providerRef = `${this.code}-${randomUUID()}`;
    if (scenario === "ussd_pending") {
      return { ok: true, providerRef, status: "ussd_pending", next: { kind: "ussd_confirm" } };
    }
    if (req.method === "CARD" || req.method === "WAVE") {
      return {
        ok: true,
        providerRef,
        status: "initiated",
        next: { kind: "redirect", url: `https://mock.${this.code.toLowerCase()}.example/pay/${providerRef}` }
      };
    }
    return { ok: true, providerRef, status: "initiated", next: { kind: "none" } };
  }

  async refund(providerRef: string, amountMinor: bigint): Promise<RefundResult> {
    this.refunds.push({ providerRef, amountMinor });
    return { ok: true, providerRef: `${providerRef}-refund` };
  }

  verifyWebhook(rawBody: string, signatureHeader: string | undefined): WebhookResult | null {
    if (!signatureHeader) return null;
    const expected = createHmac("sha256", this.secret).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "hex");
    let b: Buffer;
    try {
      b = Buffer.from(signatureHeader, "hex");
    } catch {
      return null;
    }
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(rawBody) as WebhookResult & { provider_code?: string };
    if (parsed.provider_code && parsed.provider_code !== this.code) return null;
    return parsed;
  }

  async probe(): Promise<boolean> {
    return !this.down && this.forcedScenario !== "provider_500";
  }

  /** Test/E2E helper: a signed webhook exactly as the real provider would send it. */
  buildWebhook(input: {
    providerRef: string;
    kind: WebhookResult["kind"];
    amountMinor?: bigint;
    currency?: string;
    eventId?: string;
    /** Override for freshness-window tests; defaults to "now". */
    occurredAt?: string;
  }): { rawBody: string; signature: string } {
    const body = {
      provider_code: this.code,
      event_id: input.eventId ?? randomUUID(),
      provider_ref: input.providerRef,
      kind: input.kind,
      ...(input.amountMinor !== undefined
        ? { amount: { amount_minor: input.amountMinor.toString(), currency: input.currency ?? "XOF" } }
        : {}),
      occurred_at: input.occurredAt ?? new Date().toISOString()
    };
    const rawBody = JSON.stringify(body);
    return { rawBody, signature: createHmac("sha256", this.secret).update(rawBody).digest("hex") };
  }
}

/**
 * MockPiSpiProvider — DC-6. Instant rail: init returns alias/QR; confirmation
 * arrives (near-)instantly. transfer() is the payout/remittance leg (FR-20).
 */
export class MockPiSpiProvider extends MockPaymentProvider {
  readonly transfers: Array<{ alias: string; amountMinor: bigint; kind: string }> = [];

  constructor(secret: string) {
    super("PISPI", secret, new Set());
  }

  override async init(req: InitRequest): Promise<InitResult> {
    this.initCalls.push(req);
    if (this.down) return { ok: false, kind: "provider_error", reason: "PI-SPI unavailable" };
    if (req.mockScenario === "decline") return { ok: false, kind: "declined", reason: "refusé" };
    const providerRef = `PISPI-${randomUUID()}`;
    return {
      ok: true,
      providerRef,
      status: "initiated",
      next: { kind: "qr", qr_payload: `pispi://pay?alias=sunumarket&ref=${providerRef}` }
    };
  }

  /** Instant transfer (payouts, rider remittances). */
  async transfer(alias: string, amountMinor: bigint, kind: "payout" | "remittance" | "refund"): Promise<RefundResult> {
    if (this.down) return { ok: false, reason: "PI-SPI unavailable" };
    this.transfers.push({ alias, amountMinor, kind });
    return { ok: true, providerRef: `PISPI-T-${randomUUID()}` };
  }
}
