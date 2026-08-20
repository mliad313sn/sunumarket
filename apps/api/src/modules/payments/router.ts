import { CircuitBreaker, type BreakerState } from "@sunumarket/shared";
import type { PackRegistry } from "@sunumarket/config";
import type { PaymentProvider } from "./provider.js";

/**
 * Routing layer — FR-14 / ADR-0005. Per (provider, method) breakers; new
 * attempts auto-route to the fallback while the primary's breaker is open.
 * In-memory per instance (Redis-backed sharing is a prod BACKLOG item).
 */
export class ProviderRouter {
  private breakers = new Map<string, CircuitBreaker>();
  private providers = new Map<string, PaymentProvider>();

  constructor(
    private readonly packs: PackRegistry,
    providers: PaymentProvider[],
    private readonly clock: () => number = Date.now
  ) {
    for (const p of providers) this.providers.set(p.code, p);
  }

  provider(code: string): PaymentProvider {
    const p = this.providers.get(code);
    if (!p) throw new Error(`unknown payment provider ${code}`);
    return p;
  }

  breaker(providerCode: string, method: string): CircuitBreaker {
    const key = `${providerCode}:${method}`;
    if (!this.breakers.has(key)) this.breakers.set(key, new CircuitBreaker());
    return this.breakers.get(key)!;
  }

  breakerState(providerCode: string, method: string): BreakerState {
    return this.breaker(providerCode, method).getState(this.clock());
  }

  /**
   * Providers to try, in order, for a country+method — primary first unless its
   * breaker refuses, then fallback. Empty array = both routes down.
   */
  candidates(country: string, method: string): PaymentProvider[] {
    const route = this.packs.providerRoute(country, method);
    const now = this.clock();
    const list: PaymentProvider[] = [];
    const primary = this.provider(route.primary);
    const fallback = route.fallback ? this.provider(route.fallback) : null;

    if (this.breaker(primary.code, method).allowRequest(now)) list.push(primary);
    if (fallback && this.breaker(fallback.code, method).allowRequest(now)) list.push(fallback);
    // If neither breaker admits traffic, still try the fallback (or primary) once —
    // an attempt should fail loudly rather than silently never trying (NFR-2 queue UX).
    if (list.length === 0) list.push(fallback ?? primary);
    return list;
  }

  recordSuccess(providerCode: string, method: string): void {
    this.breaker(providerCode, method).recordSuccess(this.clock());
  }

  recordFailure(providerCode: string, method: string): void {
    this.breaker(providerCode, method).recordFailure(this.clock());
  }

  /** Test/ops helper: drop all breaker state (e.g. after simulated outages). */
  resetBreakers(): void {
    this.breakers.clear();
  }
}
