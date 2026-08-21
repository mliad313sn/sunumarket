import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * DeliveryPartnerAdapter — FR-32. Thin, config-selected; MockPartnerAdapter first.
 * Partner webhooks are signed with the partner's own secret (isolation, ADR-0012).
 */
export interface PartnerJobRequest {
  jobId: string;
  pickup: { lat: number; lng: number; landmark: string };
  dropoff: { lat: number; lng: number; landmark: string };
  cod: boolean;
  codAmountMinor: bigint | null;
}

export interface PartnerWebhookEvent {
  event_id: string;
  job_id: string;
  kind: "accepted" | "picked_up" | "en_route" | "delivered" | "failed";
  at: string;
}

export interface DeliveryPartnerAdapter {
  readonly partnerId: string;
  requestPickup(req: PartnerJobRequest): Promise<{ accepted: boolean; partnerRef: string }>;
  /**
   * Verify a webhook signature. `secret` is resolved PER PARTNER by the caller
   * (env-indirection via partners.webhook_secret_ref) so partner A's secret can
   * never validate a webhook aimed at partner B; when omitted the adapter's own
   * configured secret is used (dev/seed default).
   */
  verifyWebhook(rawBody: string, signature: string | undefined, secret?: string): PartnerWebhookEvent | null;
}

export class MockPartnerAdapter implements DeliveryPartnerAdapter {
  readonly requests: PartnerJobRequest[] = [];
  refuseNext = false;

  constructor(
    public readonly partnerId: string,
    private readonly secret: string
  ) {}

  async requestPickup(req: PartnerJobRequest): Promise<{ accepted: boolean; partnerRef: string }> {
    this.requests.push(req);
    if (this.refuseNext) {
      this.refuseNext = false;
      return { accepted: false, partnerRef: "" };
    }
    return { accepted: true, partnerRef: `PARTNER-${randomUUID()}` };
  }

  verifyWebhook(rawBody: string, signature: string | undefined, secret?: string): PartnerWebhookEvent | null {
    if (!signature) return null;
    const expected = createHmac("sha256", secret ?? this.secret).update(rawBody).digest("hex");
    let sig: Buffer;
    try {
      sig = Buffer.from(signature, "hex");
    } catch {
      return null;
    }
    const exp = Buffer.from(expected, "hex");
    if (exp.length !== sig.length || !timingSafeEqual(exp, sig)) return null;
    return JSON.parse(rawBody) as PartnerWebhookEvent;
  }

  /** Test helper: signed webhook as the partner would send it. */
  buildWebhook(ev: Omit<PartnerWebhookEvent, "event_id" | "at"> & { event_id?: string }): {
    rawBody: string;
    signature: string;
  } {
    const body: PartnerWebhookEvent = {
      event_id: ev.event_id ?? randomUUID(),
      job_id: ev.job_id,
      kind: ev.kind,
      at: new Date().toISOString()
    };
    const rawBody = JSON.stringify(body);
    return { rawBody, signature: createHmac("sha256", this.secret).update(rawBody).digest("hex") };
  }
}
