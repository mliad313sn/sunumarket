import type { FastifyInstance } from "fastify";
import { createShopSchema, marketplaceQuerySchema } from "@sunumarket/shared";
import { z } from "zod";
import type { AppDeps } from "../../deps.js";
import { requireRoles } from "../auth/rbac.js";
import { CatalogError } from "./catalog.service.js";

const createProductBody = z.object({
  title: z.string().min(2).max(120),
  description: z.string().max(2000).optional(),
  price: z.object({ amount_minor: z.string().regex(/^\d+$/), currency: z.string() }),
  stock: z.number().int().min(0),
  image_keys: z.array(z.string()).max(6).default([])
});

export function registerCatalogRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { catalog } = deps;

  app.post("/shops", { preHandler: requireRoles() }, async (req, reply) => {
    const body = createShopSchema.parse(req.body);
    try {
      const shop = await catalog.createShop(req.user.sub, body);
      return reply.code(201).send(shop);
    } catch (e) {
      if (e instanceof CatalogError) return reply.code(400).send({ code: e.code, message: e.message });
      throw e;
    }
  });

  // Seller self-service (pass-2 fix 13, seller-space prereq): the caller's own
  // shop with ALL products (draft/archived included — the public /shops/:slug
  // view filters to active, which is useless for managing stock).
  app.get("/me/shop", { preHandler: requireRoles("seller") }, async (req, reply) => {
    const shop = await deps.prisma.shop.findFirst({
      where: { sellerId: req.user.sub },
      include: { products: { orderBy: { createdAt: "desc" } } }
    });
    if (!shop) return reply.code(404).send({ code: "no_shop", message: "aucune boutique pour ce compte" });
    return serializeShop(shop);
  });

  app.get("/shops/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    try {
      const shop = await catalog.getShopBySlug(slug);
      return serializeShop(shop);
    } catch (e) {
      if (e instanceof CatalogError) return reply.code(404).send({ code: e.code, message: e.message });
      throw e;
    }
  });

  app.post("/shops/:id/methods", { preHandler: requireRoles() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { methods } = req.body as { methods: string[] };
    try {
      const shop = await catalog.setShopMethods(id, req.user.sub, methods);
      return { enabled_methods: shop.enabledMethods };
    } catch (e) {
      if (e instanceof CatalogError) {
        return reply.code(e.code === "forbidden" ? 403 : 400).send({ code: e.code, message: e.message });
      }
      throw e;
    }
  });

  app.post("/shops/:id/products", { preHandler: requireRoles() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createProductBody.parse(req.body);
    try {
      const product = await catalog.createProduct(id, req.user.sub, {
        title: body.title,
        price_minor: BigInt(body.price.amount_minor),
        currency: body.price.currency,
        stock: body.stock,
        image_keys: body.image_keys,
        ...(body.description !== undefined ? { description: body.description } : {})
      });
      return reply.code(201).send(serializeProduct(product));
    } catch (e) {
      if (e instanceof CatalogError) {
        return reply.code(e.code === "forbidden" ? 403 : 400).send({ code: e.code, message: e.message });
      }
      throw e;
    }
  });

  app.get("/products/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const p = await catalog.getProduct(id);
      // DC-16 trust block in wire format (snake_case) — the buyer PWA reads these keys.
      const shop = {
        id: p.shop.id,
        slug: p.shop.slug,
        name: p.shop.name,
        country: p.shop.country,
        verified: p.shop.verified,
        completed_orders: p.shop.completedOrders,
        whatsapp_phone: p.shop.whatsappPhone
      };
      return { ...serializeProduct(p), shop, share_url: `/s/${p.shop.slug}/p/${p.id}` };
    } catch (e) {
      if (e instanceof CatalogError) return reply.code(404).send({ code: e.code, message: e.message });
      throw e;
    }
  });

  app.get("/marketplace", async (req) => {
    const q = marketplaceQuerySchema.parse(req.query ?? {});
    const { items, next_cursor } = await deps.catalog.browse({
      limit: q.limit,
      ...(q.country !== undefined ? { country: q.country } : {}),
      ...(q.city_id !== undefined ? { city_id: q.city_id } : {}),
      ...(q.q !== undefined ? { q: q.q } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {})
    });
    return { items: items.map(serializeProduct), next_cursor };
  });
}

function serializeProduct(p: {
  id: string;
  shopId: string;
  title: string;
  description: string | null;
  priceMinor: bigint;
  currency: string;
  stock: number;
  status: string;
  images: unknown;
}) {
  return {
    id: p.id,
    shop_id: p.shopId,
    title: p.title,
    description: p.description,
    price: { amount_minor: p.priceMinor.toString(), currency: p.currency },
    stock: p.stock,
    status: p.status,
    images: p.images
  };
}

function serializeShop(s: {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  country: string;
  verified: boolean;
  completedOrders: number;
  whatsappPhone: string | null;
  enabledMethods: string[];
  products?: Array<Parameters<typeof serializeProduct>[0]>;
}) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
    country: s.country,
    verified: s.verified,
    completed_orders: s.completedOrders,
    whatsapp_phone: s.whatsappPhone,
    enabled_methods: s.enabledMethods,
    products: (s.products ?? []).map(serializeProduct)
  };
}
