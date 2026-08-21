/**
 * In-process fixed-window rate limiter (pass-2 fix 9, NFR-3).
 *
 * Applied per IP to abuse-prone unauthenticated endpoints: POST /auth/otp
 * (SMS cost — the per-phone OTP throttle in AuthService stays on top of this)
 * and POST /webhooks/* (signature-checked but unauthenticated ingress).
 *
 * Single-process V1 by design: state lives in this process's memory, which is
 * correct while the API runs as one instance (like the worker sweeps). A
 * multi-instance deployment needs the Redis-backed limiter — tracked in
 * BACKLOG alongside the shared circuit breaker.
 *
 * Limits are env-tunable (SUNU_RL_OTP_PER_MIN / SUNU_RL_WEBHOOK_PER_MIN) and
 * the limiter instances are injectable via buildApp depOverrides (tests inject
 * tight windows with a fake clock).
 */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly clock: () => number = Date.now
  ) {}

  /** Count one hit for `key`; false when the key exceeded `limit` in the current window. */
  allow(key: string): boolean {
    const now = this.clock();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (this.windows.size > 10_000) this.prune(now); // bound memory on hostile traffic
      this.windows.set(key, { start: now, count: 1 });
      return this.limit >= 1;
    }
    w.count += 1;
    return w.count <= this.limit;
  }

  reset(): void {
    this.windows.clear();
  }

  private prune(now: number): void {
    for (const [key, w] of this.windows) {
      if (now - w.start >= this.windowMs) this.windows.delete(key);
    }
  }
}

export interface RateLimiters {
  /** POST /auth/otp — per-IP (the per-phone OTP throttle stays in AuthService). */
  otp: FixedWindowRateLimiter;
  /** POST /webhooks/* — payment + partner webhook ingress, per-IP. */
  webhooks: FixedWindowRateLimiter;
}

export function buildDefaultRateLimiters(env: NodeJS.ProcessEnv = process.env): RateLimiters {
  // Test runs hammer endpoints from one in-process IP — default generous there
  // (still active; a test asserting 429 injects a tight limiter via depOverrides).
  const testEnv = Boolean(env.VITEST) || env.NODE_ENV === "test";
  const otpPerMin = Number(env.SUNU_RL_OTP_PER_MIN ?? (testEnv ? 100_000 : 10));
  const webhookPerMin = Number(env.SUNU_RL_WEBHOOK_PER_MIN ?? (testEnv ? 100_000 : 120));
  return {
    otp: new FixedWindowRateLimiter(otpPerMin, 60_000),
    webhooks: new FixedWindowRateLimiter(webhookPerMin, 60_000)
  };
}
