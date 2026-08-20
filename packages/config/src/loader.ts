import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CountryPack, PackMethod } from "./schema.js";
import { countryPackSchema } from "./schema.js";

const PACKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../countries");
const ZONES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export class PackValidationError extends Error {
  constructor(
    public readonly file: string,
    public readonly issues: string
  ) {
    super(`invalid country pack ${file}: ${issues}`);
    this.name = "PackValidationError";
  }
}

export interface ZoneFeature {
  name: string;
  city: string;
  band: number;
  fee_minor: string;
  currency: string;
  /** GeoJSON Polygon rings: [ [ [lng,lat], ... ] ] */
  polygon: number[][][];
}

/**
 * Country Config Pack loader — FR-49 / ADR-0008.
 * Packs are read from disk, Zod-validated, cached, and hot-reloadable:
 * `reload()` re-reads the directory so config flips without a process restart
 * (Phase 2 verify; admin panel calls it on pack updates in Phase 10).
 * Runtime method overrides (e.g. MANUAL_TRANSFER admin toggle, DC-8.2) layer on top.
 */
export class PackRegistry {
  private packs = new Map<string, CountryPack>();
  private overrides = new Map<string, Map<string, boolean>>();
  private routeOverrides = new Map<string, { primary: string; fallback: string | null }>();
  private loadedFrom: string;

  constructor(packsDir: string = PACKS_DIR) {
    this.loadedFrom = packsDir;
    this.reload();
  }

  reload(packsDir: string = this.loadedFrom): void {
    const next = new Map<string, CountryPack>();
    for (const file of readdirSync(packsDir).filter((f) => f.endsWith(".json"))) {
      const raw: unknown = JSON.parse(readFileSync(join(packsDir, file), "utf8"));
      const parsed = countryPackSchema.safeParse(raw);
      if (!parsed.success) {
        throw new PackValidationError(file, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      }
      next.set(parsed.data.country, parsed.data);
    }
    this.packs = next;
    this.loadedFrom = packsDir;
  }

  get(country: string): CountryPack {
    const pack = this.packs.get(country.toUpperCase());
    if (!pack) throw new Error(`no country pack for ${country}`);
    return pack;
  }

  has(country: string): boolean {
    return this.packs.has(country.toUpperCase());
  }

  list(includeDrafts = false): CountryPack[] {
    return [...this.packs.values()].filter((p) => includeDrafts || p.status === "active");
  }

  /** Admin runtime toggle (FR-44b): enable/disable a method without editing the pack. */
  setMethodOverride(country: string, method: string, enabled: boolean): void {
    const key = country.toUpperCase();
    if (!this.overrides.has(key)) this.overrides.set(key, new Map());
    this.overrides.get(key)!.set(method, enabled);
  }

  clearOverrides(country?: string): void {
    if (country) {
      this.overrides.delete(country.toUpperCase());
      for (const k of [...this.routeOverrides.keys()]) {
        if (k.startsWith(`${country.toUpperCase()}:`)) this.routeOverrides.delete(k);
      }
    } else {
      this.overrides.clear();
      this.routeOverrides.clear();
    }
  }

  /** Admin runtime route flip (FR-44b): change primary/fallback without redeploy. */
  setRouteOverride(country: string, method: string, primary: string, fallback: string | null): void {
    this.routeOverrides.set(`${country.toUpperCase()}:${method}`, { primary, fallback });
  }

  /**
   * Effective checkout methods for a country — pack order (dominant first, DC-1),
   * runtime overrides applied, disabled methods dropped (FR-13).
   */
  enabledMethods(country: string): PackMethod[] {
    const pack = this.get(country);
    const ov = this.overrides.get(country.toUpperCase());
    return pack.methods
      .filter((m) => ov?.get(m.type) ?? m.enabled)
      .sort((a, b) => a.order - b.order);
  }

  validatePhone(country: string, phone: string): boolean {
    return new RegExp(this.get(country).phone.regex).test(phone);
  }

  kycLimit(country: string, tier: 0 | 1 | 2): { payoutDailyMinor: bigint; codOutstandingMinor: bigint } {
    const t = this.get(country).kyc_tiers[`tier${tier}`];
    return {
      payoutDailyMinor: BigInt(t.payout_daily_minor),
      codOutstandingMinor: BigInt(t.cod_outstanding_minor)
    };
  }

  providerRoute(country: string, method: string): { primary: string; fallback: string | null } {
    const override = this.routeOverrides.get(`${country.toUpperCase()}:${method}`);
    if (override) return override;
    const route = this.get(country).provider_routes.find((r) => r.method === method);
    if (!route) throw new Error(`no provider route for ${method} in ${country}`);
    return { primary: route.primary, fallback: route.fallback };
  }

  zones(country: string): ZoneFeature[] {
    const pack = this.get(country);
    const raw: unknown = JSON.parse(readFileSync(join(ZONES_DIR, pack.zones_ref), "utf8"));
    const fc = raw as {
      features: Array<{
        properties: { name: string; city: string; band: number; fee_minor: string; currency: string };
        geometry: { type: string; coordinates: number[][][] };
      }>;
    };
    return fc.features.map((f) => ({
      name: f.properties.name,
      city: f.properties.city,
      band: f.properties.band,
      fee_minor: f.properties.fee_minor,
      currency: f.properties.currency,
      polygon: f.geometry.coordinates
    }));
  }
}

/** Process-wide default registry (API/workers import this). */
export const packRegistry: PackRegistry = new PackRegistry();
