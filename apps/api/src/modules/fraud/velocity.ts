/**
 * Fraud velocity rules — ADR-0010 / DC-8.5.
 * Pure sliding-window counters behind an interface; in-memory impl for API
 * instances and tests, Redis impl slot for multi-instance prod (BACKLOG).
 */
export interface CounterStore {
  /** Record an event and return how many occurred in the trailing windowMs. */
  bump(key: string, windowMs: number, now?: number): number;
  countInWindow(key: string, windowMs: number, now?: number): number;
}

export class MemoryCounterStore implements CounterStore {
  private events = new Map<string, number[]>();

  bump(key: string, windowMs: number, now = Date.now()): number {
    const list = (this.events.get(key) ?? []).filter((t) => now - t < windowMs);
    list.push(now);
    this.events.set(key, list);
    return list.length;
  }

  countInWindow(key: string, windowMs: number, now = Date.now()): number {
    return (this.events.get(key) ?? []).filter((t) => now - t < windowMs).length;
  }
}

export interface VelocityThresholds {
  failedPaymentsMax: number;
  failedPaymentsWindowMs: number;
  signupsPerDeviceMax: number;
  signupsWindowMs: number;
}

export const DEFAULT_THRESHOLDS: VelocityThresholds = {
  failedPaymentsMax: 10,
  failedPaymentsWindowMs: 5 * 60 * 1000,
  signupsPerDeviceMax: 5,
  signupsWindowMs: 60 * 60 * 1000
};

export type VelocityFlag =
  | { kind: "velocity_failed_payments"; subject: string; count: number }
  | { kind: "mass_signup"; subject: string; count: number };

export class VelocityRules {
  constructor(
    private readonly store: CounterStore,
    private readonly t: VelocityThresholds = DEFAULT_THRESHOLDS
  ) {}

  /** Returns a flag when the failed-payment burst threshold is crossed (exactly at threshold). */
  recordFailedPayment(subject: string, now = Date.now()): VelocityFlag | null {
    const n = this.store.bump(`fp:${subject}`, this.t.failedPaymentsWindowMs, now);
    return n === this.t.failedPaymentsMax
      ? { kind: "velocity_failed_payments", subject, count: n }
      : null;
  }

  /** Soft-block check (DC-2: friendly retry-later, never a ban). */
  isPaymentBlocked(subject: string, now = Date.now()): boolean {
    return (
      this.store.countInWindow(`fp:${subject}`, this.t.failedPaymentsWindowMs, now) >=
      this.t.failedPaymentsMax
    );
  }

  recordSignup(deviceOrIp: string, now = Date.now()): VelocityFlag | null {
    const n = this.store.bump(`su:${deviceOrIp}`, this.t.signupsWindowMs, now);
    return n === this.t.signupsPerDeviceMax ? { kind: "mass_signup", subject: deviceOrIp, count: n } : null;
  }
}
