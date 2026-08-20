import type { PrismaClient } from "@prisma/client";
import type { PackRegistry } from "@sunumarket/config";

export class CatalogError extends Error {
  constructor(
    public readonly code: "slug_taken" | "not_found" | "invalid_method" | "forbidden",
    message: string
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

export class CatalogService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly packs: PackRegistry
  ) {}

  /** FR-4: wizard ≤5 steps lands in one call; slug derived, uniquified. */
  async createShop(
    sellerId: string,
    input: { name: string; country: string; city_id: string; description?: string | undefined; whatsapp_phone?: string | undefined }
  ) {
    const base = slugify(input.name);
    let slug = base;
    for (let i = 2; await this.prisma.shop.findUnique({ where: { slug } }); i++) {
      slug = `${base}-${i}`;
    }
    // Default enabled methods = full country matrix (seller can narrow later).
    const methods = this.packs.enabledMethods(input.country).map((m) => m.type);
    const shop = await this.prisma.shop.create({
      data: {
        sellerId,
        slug,
        name: input.name,
        country: input.country,
        cityId: input.city_id,
        description: input.description ?? null,
        whatsappPhone: input.whatsapp_phone ?? null,
        enabledMethods: methods
      }
    });
    // Seller role granted on first shop.
    await this.prisma.user.update({
      where: { id: sellerId },
      data: { roles: { push: "seller" } }
    }).catch(() => undefined);
    return shop;
  }

  async getShopBySlug(slug: string) {
    const shop = await this.prisma.shop.findUnique({
      where: { slug },
      include: {
        products: { where: { status: "active" }, orderBy: { createdAt: "desc" } },
        city: true
      }
    });
    if (!shop) throw new CatalogError("not_found", "boutique introuvable");
    return shop;
  }

  /** Seller narrows the method subset — must stay within the pack matrix (FR-13). */
  async setShopMethods(shopId: string, sellerId: string, methods: string[]) {
    const shop = await this.prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    if (shop.sellerId !== sellerId) throw new CatalogError("forbidden", "pas votre boutique");
    const allowed = new Set(this.packs.enabledMethods(shop.country).map((m) => m.type));
    for (const m of methods) {
      if (!allowed.has(m as never)) throw new CatalogError("invalid_method", `méthode ${m} indisponible en ${shop.country}`);
    }
    return this.prisma.shop.update({ where: { id: shopId }, data: { enabledMethods: methods } });
  }

  async createProduct(
    shopId: string,
    sellerId: string,
    input: { title: string; description?: string; price_minor: bigint; currency: string; stock: number; image_keys: string[] }
  ) {
    const shop = await this.prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    if (shop.sellerId !== sellerId) throw new CatalogError("forbidden", "pas votre boutique");
    return this.prisma.product.create({
      data: {
        shopId,
        title: input.title,
        description: input.description ?? null,
        priceMinor: input.price_minor,
        currency: input.currency,
        stock: input.stock,
        images: input.image_keys as object,
        status: "active"
      }
    });
  }

  async getProduct(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { shop: { select: { id: true, slug: true, name: true, country: true, verified: true, completedOrders: true, whatsappPhone: true } } }
    });
    if (!product || product.status === "archived") throw new CatalogError("not_found", "produit introuvable");
    return product;
  }

  async browse(query: { country?: string; city_id?: string; q?: string; cursor?: string; limit: number }) {
    const where = {
      status: "active",
      ...(query.q ? { title: { contains: query.q, mode: "insensitive" as const } } : {}),
      shop: {
        ...(query.country ? { country: query.country } : {}),
        ...(query.city_id ? { cityId: query.city_id } : {})
      }
    };
    const items = await this.prisma.product.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: { shop: { select: { slug: true, name: true, verified: true } } }
    });
    const next = items.length > query.limit ? items.pop()!.id : null;
    return { items, next_cursor: next };
  }
}
