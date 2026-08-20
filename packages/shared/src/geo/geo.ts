import { money, type Money } from "../money/money.js";
import type { CurrencyCode } from "../money/money.js";

/**
 * GeoService domain core — FR-21..25. Pure TS (unit-tested first, Playbook Phase 5).
 * PostGIS mirrors these results at the storage layer; integration tests cross-check.
 */

export interface LngLat {
  lng: number;
  lat: number;
}

/** GeoJSON polygon rings: outer ring first; [lng, lat] positions. */
export type PolygonRings = number[][][];

export interface FeeZone {
  name: string;
  band: number;
  feeMinor: bigint;
  currency: CurrencyCode;
  polygon: PolygonRings;
}

export interface RadiusBand {
  maxKm: number;
  feeMinor: bigint;
  currency: CurrencyCode;
}

export type FeeResolution =
  | { resolution: "zone_polygon"; zone: string; fee: Money; deliverable: true }
  | { resolution: "radius_band"; zone: null; fee: Money; deliverable: true }
  | { resolution: "out_of_zone"; zone: null; fee: null; deliverable: false };

/** Ray-casting point-in-polygon with hole support (even-odd rule). */
export function pointInPolygon(point: LngLat, rings: PolygonRings): boolean {
  let inside = false;
  for (const ring of rings) {
    let ringHit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i]![0]!,
        yi = ring[i]![1]!;
      const xj = ring[j]![0]!,
        yj = ring[j]![1]!;
      const intersects =
        yi > point.lat !== yj > point.lat &&
        point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
      if (intersects) ringHit = !ringHit;
    }
    if (ringHit) inside = !inside; // outer ring sets, holes unset
  }
  return inside;
}

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * FR-24 fee resolution, in priority order:
 *  1. first zone polygon containing the pin (lowest band wins on overlap),
 *  2. else radius bands from the shop origin,
 *  3. else out_of_zone (not deliverable — seller may still quote manually in V2).
 */
export function resolveFee(
  pin: LngLat,
  zones: readonly FeeZone[],
  origin: LngLat | null,
  radiusBands: readonly RadiusBand[]
): FeeResolution {
  const hits = zones
    .filter((z) => pointInPolygon(pin, z.polygon))
    .sort((a, b) => a.band - b.band);
  const hit = hits[0];
  if (hit) {
    return {
      resolution: "zone_polygon",
      zone: hit.name,
      fee: money(hit.feeMinor, hit.currency),
      deliverable: true
    };
  }
  if (origin) {
    const km = haversineKm(origin, pin);
    const band = [...radiusBands].sort((a, b) => a.maxKm - b.maxKm).find((b) => km <= b.maxKm);
    if (band) {
      return {
        resolution: "radius_band",
        zone: null,
        fee: money(band.feeMinor, band.currency),
        deliverable: true
      };
    }
  }
  return { resolution: "out_of_zone", zone: null, fee: null, deliverable: false };
}

/** Navigation deep links (FR-23) — no own tiles, hand off to installed apps. */
export function navigationLinks(pin: LngLat): { google_maps: string; waze: string; geo_uri: string } {
  const ll = `${pin.lat},${pin.lng}`;
  return {
    google_maps: `https://www.google.com/maps/dir/?api=1&destination=${ll}`,
    waze: `https://waze.com/ul?ll=${ll}&navigate=yes`,
    geo_uri: `geo:${ll}?q=${ll}`
  };
}

/**
 * FR-25 retention: after the retention window, coordinates are truncated to ~1.1 km
 * precision (2 decimals) — enough for analytics, useless for tracking a person.
 */
export function truncateCoordinates(pin: LngLat): LngLat {
  return { lng: Math.round(pin.lng * 100) / 100, lat: Math.round(pin.lat * 100) / 100 };
}
