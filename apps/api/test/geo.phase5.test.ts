import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const url = process.env.DATABASE_URL;
const d = describe.skipIf(!url);

let app: Awaited<ReturnType<typeof buildApp>>;
let buyerToken: string;
let buyerId: string;

beforeAll(async () => {
  app = await buildApp();
  const buyer = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+2250701234502" } });
  buyerId = buyer.id;
  buyerToken = app.jwt.sign({ sub: buyer.id, roles: buyer.roles, tier: 0, device: "t" }, { expiresIn: "10m" });
});
afterAll(async () => {
  await app.close();
});

d("phase 5 — delivery points & fee engine", () => {
  it("requires consent and landmark to save a pin (FR-21/25)", async () => {
    const noConsent = await app.inject({
      method: "POST",
      url: "/delivery-points",
      headers: { authorization: `Bearer ${buyerToken}` },
      payload: { pin: { lat: 5.33, lng: -4.0, landmark: "Chez moi" }, consent: false }
    });
    expect(noConsent.statusCode).toBe(400);

    const noLandmark = await app.inject({
      method: "POST",
      url: "/delivery-points",
      headers: { authorization: `Bearer ${buyerToken}` },
      payload: { pin: { lat: 5.33, lng: -4.0, landmark: "" }, consent: true }
    });
    expect(noLandmark.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST",
      url: "/delivery-points",
      headers: { authorization: `Bearer ${buyerToken}` },
      payload: { pin: { lat: 5.331, lng: -4.001, landmark: "Portail bleu après la station" }, label: "Bureau", consent: true }
    });
    expect(ok.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/delivery-points",
      headers: { authorization: `Bearer ${buyerToken}` }
    });
    expect(list.json().some((p: { label: string }) => p.label === "Bureau")).toBe(true);
  });

  it("fee quote: zone polygon resolution matches PostGIS ST_Contains (cross-check)", async () => {
    const shop = await app.deps.prisma.shop.findUniqueOrThrow({ where: { slug: "adjoua-beaute" } });
    const pin = { lat: 5.33, lng: -4.0 }; // inside Plateau-Cocody fixture zone
    const res = await app.inject({ method: "POST", url: "/fees/quote", payload: { shop_id: shop.id, pin } });
    expect(res.statusCode).toBe(200);
    const quote = res.json();
    expect(quote.resolution).toBe("zone_polygon");
    expect(quote.zone_name).toBe("Plateau-Cocody");
    expect(quote.fee).toEqual({ amount_minor: "1000", currency: "XOF" });

    const pg = await app.deps.prisma.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM zones WHERE ST_Contains(polygon, ST_SetSRID(ST_MakePoint(${pin.lng}, ${pin.lat}), 4326))`;
    expect(pg[0]?.name).toBe(quote.zone_name);
  });

  it("out-of-zone pins are flagged not deliverable (FR-24)", async () => {
    const shop = await app.deps.prisma.shop.findUniqueOrThrow({ where: { slug: "adjoua-beaute" } });
    const res = await app.inject({
      method: "POST",
      url: "/fees/quote",
      payload: { shop_id: shop.id, pin: { lat: 48.85, lng: 2.35 } }
    });
    expect(res.json().deliverable).toBe(false);
    expect(res.json().fee).toBeNull();
  });

  it("nav deep links format (FR-23)", async () => {
    const res = await app.inject({ method: "GET", url: "/nav-links?lat=14.69&lng=-17.44" });
    const links = res.json();
    expect(links.google_maps).toContain("destination=14.69,-17.44");
    expect(links.waze).toContain("ll=14.69,-17.44");
  });

  it("retention job truncates overdue pins exactly once (FR-25)", async () => {
    const { id } = await app.deps.geo.createDeliveryPoint(buyerId, {
      pin: { lat: 5.123456, lng: -4.654321, landmark: "Test rétention" }
    });
    await app.deps.prisma.$executeRaw`
      UPDATE delivery_points SET truncate_after = now() - interval '1 day' WHERE id = ${id}::uuid`;

    const n1 = await app.deps.geo.runRetentionTruncation();
    expect(n1).toBeGreaterThanOrEqual(1);
    const after = await app.deps.prisma.$queryRaw<Array<{ lng: number; lat: number; truncate_after: Date | null }>>`
      SELECT ST_X(point) as lng, ST_Y(point) as lat, truncate_after FROM delivery_points WHERE id = ${id}::uuid`;
    expect(after[0]!.lng).toBe(-4.65);
    expect(after[0]!.lat).toBe(5.12);
    expect(after[0]!.truncate_after).toBeNull();

    const n2 = await app.deps.geo.runRetentionTruncation();
    expect(n2).toBe(0); // idempotent — nothing left to truncate
  });
});
