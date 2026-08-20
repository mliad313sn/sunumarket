/* eslint-disable no-console */
// Phase 2 seeds: 3 cities + zones (from config GeoJSON), personas, shops, products,
// riders, partner, delivery points, provider fixtures, country pack records.
import { PrismaClient } from "@prisma/client";
import { PackRegistry } from "@sunumarket/config";

const prisma = new PrismaClient();
const packs = new PackRegistry();

async function main() {
  const providerRows = [
    { code: "AGG_A", kind: "aggregator", config: { display: "Aggregator A (mock)" } },
    { code: "AGG_B", kind: "aggregator", config: { display: "Aggregator B (mock)" } },
    { code: "PISPI", kind: "instant_rail", config: { display: "PI-SPI (mock)" } }
  ];
  for (const p of providerRows) {
    await prisma.paymentProvider.upsert({
      where: { code: p.code },
      update: { kind: p.kind, config: p.config, active: true },
      create: { ...p, active: true }
    });
  }

  for (const pack of packs.list(true)) {
    await prisma.countryPackRecord.upsert({
      where: { country: pack.country },
      update: { version: pack.version, pack: pack as object, active: pack.status === "active" },
      create: {
        country: pack.country,
        version: pack.version,
        pack: pack as object,
        active: pack.status === "active"
      }
    });
  }

  const cityDefs = [
    { country: "SN", name: "Dakar" },
    { country: "CI", name: "Abidjan" },
    { country: "BF", name: "Ouagadougou" }
  ];
  const cities: Record<string, string> = {};
  for (const c of cityDefs) {
    const city = await prisma.city.upsert({
      where: { country_name: { country: c.country, name: c.name } },
      update: {},
      create: c
    });
    cities[c.country] = city.id;
  }

  for (const country of ["SN", "CI", "BF"] as const) {
    for (const z of packs.zones(country)) {
      const exists = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM zones WHERE city_id = ${cities[country]}::uuid AND name = ${z.name}`;
      if (exists.length > 0) continue;
      const geojson = JSON.stringify({ type: "Polygon", coordinates: z.polygon });
      await prisma.$executeRaw`
        INSERT INTO zones (id, city_id, name, band, fee_minor, currency, polygon)
        VALUES (gen_random_uuid(), ${cities[country]}::uuid, ${z.name}, ${z.band},
                ${BigInt(z.fee_minor)}, ${z.currency},
                ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326))`;
    }
  }

  async function upsertUser(phone: string, name: string, country: string, roles: string[], kycTier = 0) {
    return prisma.user.upsert({
      where: { phone },
      update: { roles, kycTier },
      create: { phone, name, country, roles, kycTier, locale: "fr" }
    });
  }

  const awa = await upsertUser("+221771234501", "Awa Diop", "SN", ["buyer", "seller"], 1);
  const yao = await upsertUser("+2250701234502", "Yao Kouassi", "CI", ["buyer"]);
  const moussa = await upsertUser("+22670123503", "Moussa Ouédraogo", "BF", ["buyer", "rider"], 2);
  await upsertUser("+221771234504", "Fatou Ndiaye", "SN", ["admin"], 2);
  const sellerCi = await upsertUser("+2250701234505", "Adjoua Konan", "CI", ["buyer", "seller"], 1);
  const sellerBf = await upsertUser("+22670123506", "Salif Kaboré", "BF", ["buyer", "seller"], 1);

  await prisma.rider.upsert({
    where: { userId: moussa.id },
    update: {},
    create: { userId: moussa.id, vehicle: "moto", active: true }
  });

  const partnerOps = await upsertUser("+221771234508", "DiaLog Ops", "SN", ["partner"], 1);
  await prisma.partner.upsert({
    where: { id: "00000000-0000-4000-8000-000000000001" },
    update: { contactUserId: partnerOps.id },
    create: {
      id: "00000000-0000-4000-8000-000000000001",
      name: "DiaLog Express",
      adapter: "MOCK",
      webhookSecretRef: "PARTNER_DIALOG_WEBHOOK_SECRET",
      contactUserId: partnerOps.id
    }
  });

  const shopDefs = [
    { seller: awa, country: "SN", name: "Chez Awa Mode", slug: "chez-awa-mode", methods: ["WAVE", "ORANGE_MONEY", "COD", "PI_SPI"] },
    { seller: sellerCi, country: "CI", name: "Adjoua Beauté", slug: "adjoua-beaute", methods: ["WAVE", "ORANGE_MONEY", "MTN_MOMO", "COD", "PI_SPI"] },
    { seller: sellerBf, country: "BF", name: "Kaboré Électronique", slug: "kabore-electronique", methods: ["ORANGE_MONEY", "MOOV_MONEY", "COD", "PI_SPI"] }
  ];
  const products = [
    ["Robe wax fleurie", 15000n, 12],
    ["Sac à main cuir", 25000n, 5],
    ["Perruque lace front", 45000n, 8],
    ["Crème karité 500g", 3500n, 40],
    ["Écouteurs Bluetooth", 8000n, 20],
    ["Chargeur rapide 25W", 6000n, 15]
  ] as const;

  let pi = 0;
  for (const def of shopDefs) {
    const shop = await prisma.shop.upsert({
      where: { slug: def.slug },
      update: { enabledMethods: def.methods },
      create: {
        sellerId: def.seller.id,
        slug: def.slug,
        name: def.name,
        country: def.country,
        cityId: cities[def.country]!,
        enabledMethods: def.methods,
        verified: true
      }
    });
    for (let k = 0; k < 2; k++) {
      const [title, price, stock] = products[pi++ % products.length]!;
      const existing = await prisma.product.findFirst({ where: { shopId: shop.id, title } });
      if (!existing) {
        await prisma.product.create({
          data: { shopId: shop.id, title, priceMinor: price, currency: "XOF", stock, status: "active" }
        });
      }
    }
  }

  // Delivery points: one saved pin per persona, inside a seeded zone (consented).
  const pins = [
    { owner: yao.id, lng: -4.0, lat: 5.33, landmark: "En face de la pharmacie du Plateau", label: "Maison" },
    { owner: awa.id, lng: -17.44, lat: 14.68, landmark: "À côté de la boulangerie Jaune, Médina", label: "Boutique" },
    { owner: moussa.id, lng: -1.51, lat: 12.36, landmark: "Derrière le marché de Koulouba", label: "Base" }
  ];
  for (const p of pins) {
    const exists = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM delivery_points WHERE owner_id = ${p.owner}::uuid AND landmark = ${p.landmark}`;
    if (exists.length > 0) continue;
    await prisma.$executeRaw`
      INSERT INTO delivery_points (id, owner_id, label, landmark, point, consent, created_at)
      VALUES (gen_random_uuid(), ${p.owner}::uuid, ${p.label}, ${p.landmark},
              ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326), true, now())`;
  }

  console.log("seed complete: providers, packs, cities, zones, users, shops, products, rider, partner, delivery points");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
