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
import { MockPaymentProvider, MockPiSpiProvider } from "./modules/payments/mock-provider.js";
import { ProviderRouter } from "./modules/payments/router.js";
import { PaymentsService } from "./modules/payments/payments.service.js";
import { LedgerService } from "./modules/ledger/ledger.service.js";
import { PayoutsService } from "./modules/payouts/payouts.service.js";
import { ReconciliationService } from "./modules/reconciliation/reconciliation.service.js";
import { DeliveryService } from "./modules/delivery/delivery.service.js";
import { MockPartnerAdapter, type DeliveryPartnerAdapter } from "./modules/delivery/partner-adapter.js";
import { TrustService } from "./modules/trust/trust.service.js";
import { AdminService } from "./modules/admin/admin.service.js";

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
  router: ProviderRouter;
  payments: PaymentsService;
  mockAggA: MockPaymentProvider;
  mockAggB: MockPaymentProvider;
  mockPiSpi: MockPiSpiProvider;
  ledger: LedgerService;
  payouts: PayoutsService;
  reconciliation: ReconciliationService;
  delivery: DeliveryService;
  mockPartner: MockPartnerAdapter;
  trust: TrustService;
  admin: AdminService;
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
  const mockAggA = overrides.mockAggA ?? new MockPaymentProvider("AGG_A", process.env.MOCK_AGG_A_SECRET ?? "agg-a-secret");
  const mockAggB = overrides.mockAggB ?? new MockPaymentProvider("AGG_B", process.env.MOCK_AGG_B_SECRET ?? "agg-b-secret");
  const mockPiSpi = overrides.mockPiSpi ?? new MockPiSpiProvider(process.env.MOCK_PISPI_SECRET ?? "pispi-secret");
  const router = overrides.router ?? new ProviderRouter(packs, [mockAggA, mockAggB, mockPiSpi]);
  const ledger = overrides.ledger ?? new LedgerService(prisma, packs);
  const payments =
    overrides.payments ?? new PaymentsService(prisma, packs, router, orders, velocity, fraud, messaging, ledger);
  const payouts = overrides.payouts ?? new PayoutsService(prisma, ledger, kyc, auth, mockPiSpi);
  const reconciliation = overrides.reconciliation ?? new ReconciliationService(prisma);
  const mockPartner = overrides.mockPartner ?? new MockPartnerAdapter("MOCK", process.env.PARTNER_DIALOG_WEBHOOK_SECRET ?? "partner-secret");
  const partnerAdapters = new Map<string, DeliveryPartnerAdapter>([["MOCK", mockPartner]]);
  const delivery =
    overrides.delivery ?? new DeliveryService(prisma, orders, kyc, mockPiSpi, messaging, partnerAdapters);
  const trust = overrides.trust ?? new TrustService(prisma);
  const admin = overrides.admin ?? new AdminService(prisma, packs);
  payouts.setFrozenProvider((sellerId) => trust.frozenAmountFor(sellerId));
  return { prisma, packs, messaging, velocity, fraud, auth, kyc, catalog, geo, orders, router, payments, mockAggA, mockAggB, mockPiSpi, ledger, payouts, reconciliation, delivery, mockPartner, trust, admin };
}
