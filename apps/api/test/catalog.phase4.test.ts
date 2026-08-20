import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const url = process.env.DATABASE_URL;
const d = describe.skipIf(!url);

let app: Awaited<ReturnType<typeof buildApp>>;
let sellerToken: string;
let sellerId: string;

beforeAll(async () => {
  app = await buildApp();
  const seller = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+221771234501" } });
  sellerId = seller.id;
  sellerToken = app.jwt.sign(
    { sub: seller.id, roles: seller.roles, tier: seller.kycTier, device: "t" },
    { expiresIn: "10m" }
  );
});
afterAll(async () => {
  await app.close();
});

d("phase 4 — shops & products", () => {
  it("creates a shop in one call (wizard ≤5 steps) with pack-default methods, slug uniquified", async () => {
    const city = await app.deps.prisma.city.findFirstOrThrow({ where: { country: "SN" } });
    const res = await app.inject({
      method: "POST",
      url: "/shops",
      headers: { authorization: `Bearer ${sellerToken}` },
      payload: { name: "Test Boutique Wax", country: "SN", city_id: city.id }
    });
    expect(res.statusCode).toBe(201);
    const shop = res.json();
    expect(shop.slug).toMatch(/^test-boutique-wax/);
    // Pack matrix defaults, dominant first (Wave for SN); MANUAL_TRANSFER excluded (off in pack)
    expect(shop.enabledMethods[0]).toBe("WAVE");
    expect(shop.enabledMethods).not.toContain("MANUAL_TRANSFER");

    const res2 = await app.inject({
      method: "POST",
      url: "/shops",
      headers: { authorization: `Bearer ${sellerToken}` },
      payload: { name: "Test Boutique Wax", country: "SN", city_id: city.id }
    });
    expect(res2.json().slug).toBe(`${shop.slug}-2`);
  });

  it("seller subset must stay inside the country matrix (FR-13)", async () => {
    const shop = await app.deps.prisma.shop.findFirstOrThrow({ where: { sellerId, country: "SN" } });
    const bad = await app.inject({
      method: "POST",
      url: `/shops/${shop.id}/methods`,
      headers: { authorization: `Bearer ${sellerToken}` },
      payload: { methods: ["WAVE", "MPESA"] }
    });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: "POST",
      url: `/shops/${shop.id}/methods`,
      headers: { authorization: `Bearer ${sellerToken}` },
      payload: { methods: ["WAVE", "COD"] }
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().enabled_methods).toEqual(["WAVE", "COD"]);
  });

  it("another seller cannot touch the shop (isolation)", async () => {
    const other = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone: "+2250701234505" } });
    const shop = await app.deps.prisma.shop.findFirstOrThrow({ where: { sellerId } });
    const token = app.jwt.sign({ sub: other.id, roles: other.roles, tier: 1, device: "t" }, { expiresIn: "5m" });
    const res = await app.inject({
      method: "POST",
      url: `/shops/${shop.id}/products`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "intrus", price: { amount_minor: "1000", currency: "XOF" }, stock: 1, image_keys: [] }
    });
    expect(res.statusCode).toBe(403);
  });

  it("creates a product and serves it on the public shop page with money as wire format", async () => {
    const shop = await app.deps.prisma.shop.findUniqueOrThrow({ where: { slug: "chez-awa-mode" } });
    const res = await app.inject({
      method: "POST",
      url: `/shops/${shop.id}/products`,
      headers: { authorization: `Bearer ${sellerToken}` },
      payload: {
        title: "Boubou brodé premium",
        price: { amount_minor: "35000", currency: "XOF" },
        stock: 3,
        image_keys: ["img/boubou-1.webp"]
      }
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().price).toEqual({ amount_minor: "35000", currency: "XOF" });

    const page = await app.inject({ method: "GET", url: "/shops/chez-awa-mode" });
    expect(page.statusCode).toBe(200);
    const body = page.json();
    expect(body.products.some((p: { title: string }) => p.title === "Boubou brodé premium")).toBe(true);
    expect(body.completed_orders).toBeDefined(); // trust block slot (DC-16)
  });

  it("marketplace browses with country filter, search and cursor pagination; empty state is []", async () => {
    const res = await app.inject({ method: "GET", url: "/marketplace?country=SN&limit=2" });
    expect(res.statusCode).toBe(200);
    const { items, next_cursor } = res.json();
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(2);
    if (next_cursor) {
      const page2 = await app.inject({ method: "GET", url: `/marketplace?country=SN&limit=2&cursor=${next_cursor}` });
      const ids1 = new Set(items.map((i: { id: string }) => i.id));
      for (const i of page2.json().items) expect(ids1.has(i.id)).toBe(false);
    }
    const empty = await app.inject({ method: "GET", url: "/marketplace?q=zzz-introuvable-zzz" });
    expect(empty.json().items).toEqual([]);
  });

  it("product page carries share url + shop trust block (FR-10, DC-16)", async () => {
    const product = await app.deps.prisma.product.findFirstOrThrow({ where: { title: "Boubou brodé premium" } });
    const res = await app.inject({ method: "GET", url: `/products/${product.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.share_url).toContain("/s/chez-awa-mode/p/");
    expect(body.shop.verified).toBe(true);
    const missing = await app.inject({ method: "GET", url: "/products/00000000-0000-4000-8000-000000000000" });
    expect(missing.statusCode).toBe(404);
  });
});
