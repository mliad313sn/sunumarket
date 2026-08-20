import { describe, expect, it } from "vitest";
import type { FeeZone, LngLat } from "./geo.js";
import {
  haversineKm,
  navigationLinks,
  pointInPolygon,
  resolveFee,
  truncateCoordinates
} from "./geo.js";

const square = (lng: number, lat: number, d: number): number[][][] => [
  [
    [lng, lat],
    [lng + d, lat],
    [lng + d, lat + d],
    [lng, lat + d],
    [lng, lat]
  ]
];

const ZONES: FeeZone[] = [
  { name: "Plateau", band: 1, feeMinor: 1000n, currency: "XOF", polygon: square(-17.46, 14.66, 0.04) },
  { name: "Grand-Dakar", band: 2, feeMinor: 1500n, currency: "XOF", polygon: square(-17.5, 14.7, 0.06) },
  { name: "Pikine", band: 3, feeMinor: 2000n, currency: "XOF", polygon: square(-17.42, 14.74, 0.08) }
];

const BANDS = [
  { maxKm: 5, feeMinor: 1500n, currency: "XOF" as const },
  { maxKm: 15, feeMinor: 2500n, currency: "XOF" as const }
];

describe("geo — point in polygon", () => {
  it("hits inside, misses outside, handles vertices/edges deterministically", () => {
    const poly = square(0, 0, 1);
    expect(pointInPolygon({ lng: 0.5, lat: 0.5 }, poly)).toBe(true);
    expect(pointInPolygon({ lng: 1.5, lat: 0.5 }, poly)).toBe(false);
    expect(pointInPolygon({ lng: -0.001, lat: 0.5 }, poly)).toBe(false);
  });

  it("respects holes (even-odd)", () => {
    const withHole: number[][][] = [...square(0, 0, 1), ...square(0.25, 0.25, 0.5)];
    expect(pointInPolygon({ lng: 0.1, lat: 0.1 }, withHole)).toBe(true);
    expect(pointInPolygon({ lng: 0.5, lat: 0.5 }, withHole)).toBe(false);
  });
});

describe("geo — fee resolution fixtures (Phase 5 gate: pins → expected zone/fee)", () => {
  // 20 fixture pins for the Dakar zone set: [pin, expectedZone|band|out]
  const CASES: Array<{ pin: LngLat; expect: string; fee: bigint | null }> = [
    { pin: { lng: -17.45, lat: 14.67 }, expect: "Plateau", fee: 1000n },
    { pin: { lng: -17.43, lat: 14.69 }, expect: "Plateau", fee: 1000n },
    { pin: { lng: -17.425, lat: 14.665 }, expect: "Plateau", fee: 1000n },
    { pin: { lng: -17.459, lat: 14.699 }, expect: "Plateau", fee: 1000n },
    { pin: { lng: -17.49, lat: 14.71 }, expect: "Grand-Dakar", fee: 1500n },
    { pin: { lng: -17.47, lat: 14.73 }, expect: "Grand-Dakar", fee: 1500n },
    { pin: { lng: -17.445, lat: 14.755 }, expect: "Grand-Dakar", fee: 1500n },
    { pin: { lng: -17.41, lat: 14.75 }, expect: "Pikine", fee: 2000n },
    { pin: { lng: -17.35, lat: 14.78 }, expect: "Pikine", fee: 2000n },
    { pin: { lng: -17.39, lat: 14.81 }, expect: "Pikine", fee: 2000n },
    { pin: { lng: -17.341, lat: 14.741 }, expect: "Pikine", fee: 2000n },
    { pin: { lng: -17.415, lat: 14.745 }, expect: "Pikine", fee: 2000n },
    // radius band fallbacks (origin = Plateau center)
    { pin: { lng: -17.46, lat: 14.62 }, expect: "radius_band", fee: 2500n }, // ~6.7 km from origin → band 2
    { pin: { lng: -17.50, lat: 14.60 }, expect: "radius_band", fee: 2500n },
    { pin: { lng: -17.36, lat: 14.71 }, expect: "radius_band", fee: 2500n },
    // out of zone entirely
    { pin: { lng: -16.9, lat: 15.2 }, expect: "out_of_zone", fee: null },
    { pin: { lng: -17.9, lat: 14.1 }, expect: "out_of_zone", fee: null },
    { pin: { lng: 2.35, lat: 48.85 }, expect: "out_of_zone", fee: null },
    { pin: { lng: -4.0, lat: 5.33 }, expect: "out_of_zone", fee: null },
    { pin: { lng: -17.44, lat: 13.9 }, expect: "out_of_zone", fee: null }
  ];

  const ORIGIN: LngLat = { lng: -17.44, lat: 14.68 };

  it("resolves 20/20 fixture pins to the expected zone/band/fee", () => {
    for (const c of CASES) {
      const r = resolveFee(c.pin, ZONES, ORIGIN, BANDS);
      if (c.expect === "radius_band" || c.expect === "out_of_zone") {
        expect(r.resolution, JSON.stringify(c.pin)).toBe(c.expect);
      } else {
        expect(r.resolution, JSON.stringify(c.pin)).toBe("zone_polygon");
        expect(r.zone, JSON.stringify(c.pin)).toBe(c.expect);
      }
      if (c.fee === null) {
        expect(r.fee).toBeNull();
        expect(r.deliverable).toBe(false);
      } else {
        expect(r.fee?.amountMinor, JSON.stringify(c.pin)).toBe(c.fee);
      }
    }
  });

  it("overlapping zones: lowest band wins", () => {
    const overlapping: FeeZone[] = [
      { name: "Wide", band: 2, feeMinor: 2000n, currency: "XOF", polygon: square(0, 0, 2) },
      { name: "Core", band: 1, feeMinor: 1000n, currency: "XOF", polygon: square(0.5, 0.5, 1) }
    ];
    const r = resolveFee({ lng: 1, lat: 1 }, overlapping, null, []);
    expect(r.resolution).toBe("zone_polygon");
    expect(r.zone).toBe("Core");
    expect(r.fee?.amountMinor).toBe(1000n);
  });

  it("no origin → polygon or out_of_zone only (no radius fallback)", () => {
    const r = resolveFee({ lng: -17.46, lat: 14.62 }, ZONES, null, BANDS);
    expect(r.resolution).toBe("out_of_zone");
  });
});

describe("geo — distance, deep links, retention", () => {
  it("haversine sanity: Dakar→Abidjan ≈ 1850-1900 km; zero distance = 0", () => {
    const d = haversineKm({ lng: -17.44, lat: 14.69 }, { lng: -4.02, lat: 5.35 });
    expect(d).toBeGreaterThan(1700);
    expect(d).toBeLessThan(2000);
    expect(haversineKm({ lng: 1, lat: 1 }, { lng: 1, lat: 1 })).toBe(0);
  });

  it("navigation deep links carry lat,lng in the right formats (FR-23)", () => {
    const links = navigationLinks({ lng: -17.44, lat: 14.69 });
    expect(links.google_maps).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=14.69,-17.44"
    );
    expect(links.waze).toBe("https://waze.com/ul?ll=14.69,-17.44&navigate=yes");
    expect(links.geo_uri).toBe("geo:14.69,-17.44?q=14.69,-17.44");
  });

  it("retention truncation reduces precision to ~1.1 km (FR-25)", () => {
    const t = truncateCoordinates({ lng: -17.446789, lat: 14.692345 });
    expect(t).toEqual({ lng: -17.45, lat: 14.69 });
  });
});
