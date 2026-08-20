/**
 * Analytics events (FR-47) — payment funnel per method incl. the DC-14
 * USSD-step abandonment metric (Goal §10 KPI). Queued locally; a real sink
 * (batch POST) is config-selected later; events never block UX.
 */
export interface TrackEvent {
  name: string;
  props: Record<string, string | number | boolean>;
  at: string;
}

const queue: TrackEvent[] = [];

export function track(name: string, props: Record<string, string | number | boolean> = {}): void {
  queue.push({ name, props, at: new Date().toISOString() });
}

export function drainEvents(): TrackEvent[] {
  return queue.splice(0, queue.length);
}

/** Payment funnel helpers — one call site per step keeps the funnel honest. */
export const funnel = {
  checkoutOpened: (method_count: number) => track("checkout_opened", { method_count }),
  methodChosen: (method: string, remembered: boolean) => track("method_chosen", { method, remembered }),
  attemptCreated: (method: string, provider: string) => track("attempt_created", { method, provider }),
  ussdShown: (method: string) => track("ussd_confirm_shown", { method }),
  /** Abandonment: buyer left the USSD screen without confirm/switch (KPI §10). */
  ussdAbandoned: (method: string, seconds_on_screen: number) =>
    track("ussd_abandoned", { method, seconds_on_screen }),
  ussdResent: (method: string) => track("ussd_resend", { method }),
  methodSwitched: (from: string, to: string) => track("method_switched", { from, to }),
  paid: (method: string) => track("payment_succeeded", { method }),
  failed: (method: string, reason: string) => track("payment_failed", { method, reason })
};
