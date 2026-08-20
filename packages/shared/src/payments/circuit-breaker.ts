/**
 * Circuit breaker — ADR-0005 / FR-14 / NFR-2. Pure, injectable clock.
 * Keyed per (provider, method) by the caller.
 *
 * closed → open: 3 consecutive failures OR 5 failures in a rolling 60 s window.
 * open → half-open: after cool-down (30 s, doubling per consecutive open, cap 5 min).
 * half-open: one probe allowed; success → closed, failure → open (longer cool-down).
 */
export interface BreakerConfig {
  consecutiveFailures: number;
  windowFailures: number;
  windowMs: number;
  cooldownMs: number;
  cooldownMaxMs: number;
  /** Per-call timeout budget the caller should apply to init calls (ms). */
  callTimeoutMs: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  consecutiveFailures: 3,
  windowFailures: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
  cooldownMaxMs: 300_000,
  callTimeoutMs: 10_000
};

export type BreakerState = "closed" | "open" | "half_open";

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private consecutive = 0;
  private failures: number[] = [];
  private openedAt = 0;
  private openStreak = 0;
  private probeInFlight = false;

  constructor(private readonly cfg: BreakerConfig = DEFAULT_BREAKER_CONFIG) {}

  getState(now: number): BreakerState {
    if (this.state === "open" && now - this.openedAt >= this.currentCooldown()) {
      this.state = "half_open";
      this.probeInFlight = false;
    }
    return this.state;
  }

  /**
   * May the caller send a request through? In half-open, exactly one probe
   * is allowed at a time.
   */
  allowRequest(now: number): boolean {
    const s = this.getState(now);
    if (s === "closed") return true;
    if (s === "open") return false;
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(now: number): void {
    this.getState(now);
    this.state = "closed";
    this.consecutive = 0;
    this.failures = [];
    this.openStreak = 0;
    this.probeInFlight = false;
  }

  recordFailure(now: number): void {
    const s = this.getState(now);
    if (s === "half_open") {
      this.trip(now);
      return;
    }
    this.consecutive += 1;
    this.failures = this.failures.filter((t) => now - t < this.cfg.windowMs);
    this.failures.push(now);
    if (this.consecutive >= this.cfg.consecutiveFailures || this.failures.length >= this.cfg.windowFailures) {
      this.trip(now);
    }
  }

  private trip(now: number): void {
    this.state = "open";
    this.openedAt = now;
    this.openStreak += 1;
    this.consecutive = 0;
    this.failures = [];
    this.probeInFlight = false;
  }

  private currentCooldown(): number {
    const factor = 2 ** Math.max(0, this.openStreak - 1);
    return Math.min(this.cfg.cooldownMs * factor, this.cfg.cooldownMaxMs);
  }
}
