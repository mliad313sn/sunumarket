import type { PrismaClient } from "@prisma/client";
import {
  navigationLinks,
  resolveFee,
  truncateCoordinates,
  type FeeResolution,
  type FeeZone,
  type LngLat
} from "@sunumarket/shared";
import type { CurrencyCode } from "@sunumarket/shared";

const RETENTION_DAYS = Number(process.env.SUNU_PIN_RETENTION_DAYS ?? 180);

export class GeoApiService {
  constructor(private readonly prisma: PrismaClient) {}

  /** FR-21: pin + mandatory landmark, consent-gated; retention clock starts at capture. */
  async createDeliveryPoint(
    ownerId: string | null,
    input: { pin: { lat: number; lng: number; landmark: string }; label?: string }
  ): Promise<{ id: string }> {
    const truncateAfter = new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO delivery_points (id, owner_id, label, landmark, point, consent, truncate_after, created_at)
      VALUES (gen_random_uuid(), ${ownerId}::uuid, ${input.label ?? null}, ${input.pin.landmark},
              ST_SetSRID(ST_MakePoint(${input.pin.lng}, ${input.pin.lat}), 4326), true, ${truncateAfter}, now())
      RETURNING id`;
    return { id: rows[0]!.id };
  }

  async listSavedPoints(ownerId: string) {
    return this.prisma.$queryRaw<Array<{ id: string; label: string | null; landmark: string; lng: number; lat: number }>>`
      SELECT id, label, landmark, ST_X(point) as lng, ST_Y(point) as lat
      FROM delivery_points WHERE owner_id = ${ownerId}::uuid ORDER BY created_at DESC`;
  }

  async getPoint(id: string): Promise<{ lng: number; lat: number; landmark: string } | null> {
    const rows = await this.prisma.$queryRaw<Array<{ lng: number; lat: number; landmark: string }>>`
      SELECT ST_X(point) as lng, ST_Y(point) as lat, landmark FROM delivery_points WHERE id = ${id}::uuid`;
    return rows[0] ?? null;
  }

  /** Zones for a shop's city, shaped for the shared fee engine. */
  async zonesForShop(shopId: string): Promise<FeeZone[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ name: string; band: number; fee_minor: bigint; currency: string; geojson: string }>
    >`
      SELECT z.name, z.band, z.fee_minor, z.currency, ST_AsGeoJSON(z.polygon) as geojson
      FROM zones z JOIN shops s ON s.city_id = z.city_id
      WHERE s.id = ${shopId}::uuid`;
    return rows.map((r) => ({
      name: r.name,
      band: r.band,
      feeMinor: BigInt(r.fee_minor),
      currency: r.currency as CurrencyCode,
      polygon: (JSON.parse(r.geojson) as { coordinates: number[][][] }).coordinates
    }));
  }

  /** FR-24: polygon > radius > out-of-zone. Cross-checked against PostGIS in tests. */
  async quoteFee(shopId: string, pin: LngLat): Promise<FeeResolution> {
    const zones = await this.zonesForShop(shopId);
    return resolveFee(pin, zones, null, []);
  }

  navLinks(pin: LngLat) {
    return navigationLinks(pin);
  }

  /**
   * FR-25 retention job: truncate precise coordinates past their retention date.
   * Idempotent — truncated rows get truncate_after = NULL so they never re-process.
   */
  async runRetentionTruncation(now = new Date()): Promise<number> {
    const due = await this.prisma.$queryRaw<Array<{ id: string; lng: number; lat: number }>>`
      SELECT id, ST_X(point) as lng, ST_Y(point) as lat
      FROM delivery_points WHERE truncate_after IS NOT NULL AND truncate_after < ${now}`;
    for (const row of due) {
      const t = truncateCoordinates({ lng: row.lng, lat: row.lat });
      await this.prisma.$executeRaw`
        UPDATE delivery_points
        SET point = ST_SetSRID(ST_MakePoint(${t.lng}, ${t.lat}), 4326), truncate_after = NULL
        WHERE id = ${row.id}::uuid`;
    }
    return due.length;
  }
}
