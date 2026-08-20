import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { KycError } from "../src/modules/kyc/kyc.service.js";

const url = process.env.DATABASE_URL;
const d = describe.skipIf(!url);

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});

d("phase 3 — KYC tier limits from country pack (DC-13)", () => {
  it("Tier-1 payout above the SN pack daily limit is blocked WITH an upgrade path", async () => {
    const prisma = app.deps.prisma;
    const awa = await prisma.user.findUniqueOrThrow({ where: { phone: "+221771234501" } }); // Tier 1
    await prisma.payout.deleteMany({ where: { sellerId: awa.id } });

    // SN tier1 payout_daily_minor = 200 000
    await expect(app.deps.kyc.assertPayoutWithinLimit(awa.id, 150000n)).resolves.toBeUndefined();

    try {
      await app.deps.kyc.assertPayoutWithinLimit(awa.id, 250000n);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(KycError);
      const err = e as KycError;
      expect(err.code).toBe("limit_exceeded");
      expect(err.upgradePath?.targetTier).toBe(2);
    }
  });

  it("daily limit accumulates across payouts of the day", async () => {
    const prisma = app.deps.prisma;
    const awa = await prisma.user.findUniqueOrThrow({ where: { phone: "+221771234501" } });
    await prisma.payout.deleteMany({ where: { sellerId: awa.id } });
    await prisma.payout.create({
      data: {
        sellerId: awa.id,
        amountMinor: 180000n,
        currency: "XOF",
        rail: "PI_SPI",
        status: "settled",
        idempotencyKey: `kyc-test-${Date.now()}`
      }
    });
    await expect(app.deps.kyc.assertPayoutWithinLimit(awa.id, 50000n)).rejects.toThrow(/plafond/);
    await expect(app.deps.kyc.assertPayoutWithinLimit(awa.id, 20000n)).resolves.toBeUndefined();
    await prisma.payout.deleteMany({ where: { sellerId: awa.id } });
  });

  it("Tier-2 rider COD outstanding cap enforced (BF pack: 75 000)", async () => {
    const prisma = app.deps.prisma;
    const moussa = await prisma.user.findUniqueOrThrow({ where: { phone: "+22670123503" } }); // Tier 2, BF
    const sum = await prisma.riderCashLedger.aggregate({
      where: { riderId: moussa.id },
      _sum: { amountMinor: true }
    });
    const outstanding = sum._sum.amountMinor ?? 0n;
    const headroom = 75000n - outstanding;
    if (headroom > 0n) {
      await expect(app.deps.kyc.assertCodWithinLimit(moussa.id, headroom)).resolves.toBeUndefined();
    }
    await expect(app.deps.kyc.assertCodWithinLimit(moussa.id, headroom + 1n)).rejects.toThrow(/plafond/);
  });

  it("upgrade request: creates pending record; duplicate blocked; admin approve raises tier", async () => {
    const prisma = app.deps.prisma;
    const yao = await prisma.user.findUniqueOrThrow({ where: { phone: "+2250701234502" } }); // Tier 0
    await prisma.kycRecord.deleteMany({ where: { userId: yao.id } });
    await prisma.user.update({ where: { id: yao.id }, data: { kycTier: 0 } });

    const req = await app.deps.kyc.requestUpgrade(yao.id, 1, { id_document: "s3://kyc/yao-id.jpg" });
    expect(req.status).toBe("pending");
    await expect(app.deps.kyc.requestUpgrade(yao.id, 1, { id_document: "x" })).rejects.toThrow(/en cours/);

    await app.deps.kyc.decide(req.id, true);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: yao.id } });
    expect(after.kycTier).toBe(1);

    // restore seed state
    await prisma.user.update({ where: { id: yao.id }, data: { kycTier: 0 } });
    await prisma.kycRecord.deleteMany({ where: { userId: yao.id } });
  });
});
