import type { PrismaClient } from "@prisma/client";
import { PackRegistry } from "@sunumarket/config";
import { getPrisma } from "./lib/prisma.js";
import { MockMessagingProvider, type MessagingProvider } from "./lib/messaging.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { FraudService } from "./modules/fraud/fraud.service.js";
import { MemoryCounterStore, VelocityRules } from "./modules/fraud/velocity.js";
import { KycService } from "./modules/kyc/kyc.service.js";
import { CatalogService } from "./modules/catalog/catalog.service.js";
import { GeoApiService } from "./modules/geo/geo.service.js";
import { OrdersService } from "./modules/orders/orders.service.js";

export interface AppDeps {
  prisma: PrismaClient;
  packs: PackRegistry;
  messaging: MessagingProvider;
  velocity: VelocityRules;
  fraud: FraudService;
  auth: AuthService;
  kyc: KycService;
  catalog: CatalogService;
  geo: GeoApiService;
  orders: OrdersService;
}

export function buildDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const prisma = overrides.prisma ?? getPrisma();
  const packs = overrides.packs ?? new PackRegistry();
  const messaging = overrides.messaging ?? new MockMessagingProvider();
  const velocity = overrides.velocity ?? new VelocityRules(new MemoryCounterStore());
  const fraud = overrides.fraud ?? new FraudService(prisma);
  const auth = overrides.auth ?? new AuthService(prisma, messaging, packs, velocity, fraud);
  const kyc = overrides.kyc ?? new KycService(prisma, packs);
  const catalog = overrides.catalog ?? new CatalogService(prisma, packs);
  const geo = overrides.geo ?? new GeoApiService(prisma);
  const orders = overrides.orders ?? new OrdersService(prisma, geo);
  return { prisma, packs, messaging, velocity, fraud, auth, kyc, catalog, geo, orders };
}
