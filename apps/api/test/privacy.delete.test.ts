import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MockMessagingProvider } from "../src/lib/messaging.js";

const url = process.env.DATABASE_URL;
const d = describe.skipIf(!url);

const messaging = new MockMessagingProvider();
let app: Awaited<ReturnType<typeof buildApp>>;

// Hermetic: run-unique phones, dedicated users, seed shops read-only.
const runId = Math.floor(1000000 + Math.random() * 9000000);
const phoneFor = (n: number): string => `+22176${(runId + n).toString().slice(-7)}`;

function otpFor(phone: string): string {
  const sms = messaging.lastTo(phone);
  const m = sms?.body.match(/code est (\d{6})/);
  if (!m) throw new Error(`no OTP SMS for ${phone}`);
  return m[1]!;
}

async function signup(phone: string, device: string): Promise<{ userId: string; access: string; refresh: string }> {
  await app.inject({ method: "POST", url: "/auth/otp", payload: { phone, country: "SN", device_hash: device } });
  const res = await app.inject({
    method: "POST",
    url: "/auth/verify",
    payload: { phone, code: otpFor(phone), device_hash: device }
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  const user = await app.deps.prisma.user.findUniqueOrThrow({ where: { phone } });
  return { userId: user.id, access: res.json().access_token, refresh: res.json().refresh_token };
}

beforeAll(async () => {
  app = await buildApp({ messaging });
});

afterAll(async () => {
  await app.close();
});

d("privacy delete (FR-25 adjunct) — anonymization", () => {
  it("DELETE /me anonymizes PII, revokes sessions, scrubs pins/KYC/outbox, audits", async () => {
    const prisma = app.deps.prisma;
    const phone = phoneFor(1);
    const { userId, access, refresh } = await signup(phone, "priv-device-1");

    await prisma.user.update({ where: { id: userId }, data: { name: "Tantie Rokia" } });
    await app.deps.auth.setPayoutPin(userId, "4321");
    await prisma.kycRecord.create({
      data: { userId, tier: 1, status: "approved", documents: { id_document: "cni-scan-key" } }
    });
    const point = await app.deps.geo.createDeliveryPoint(userId, {
      pin: { lat: 14.712345, lng: -17.456789, landmark: "chez Fatou, porte bleue" },
      label: "maison"
    });
    await prisma.smsOutbox.createMany({
      data: [
        { phone, body: "en attente", senderId: "SUNUMKT", status: "queued" },
        { phone, body: "déjà partie", senderId: "SUNUMKT", status: "sent", sentAt: new Date() }
      ]
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/me",
      headers: { authorization: `Bearer ${access}` }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ anonymized: true });

    // User row tombstoned: no phone, no name, no PIN, no roles.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.phone).toBe(`deleted:${userId}`);
    expect(user.name).toBeNull();
    expect(user.payoutPinHash).toBeNull();
    expect(user.roles).toEqual([]);

    // Sessions dead: devices gone, every refresh token revoked, rotation refused.
    expect(await prisma.deviceBinding.count({ where: { userId } })).toBe(0);
    expect(await prisma.refreshToken.count({ where: { userId, revokedAt: null } })).toBe(0);
    const rot = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token: refresh } });
    expect(rot.statusCode).toBe(401);

    // KYC documents scrubbed (record itself retained for tier audit).
    const kyc = await prisma.kycRecord.findFirstOrThrow({ where: { userId } });
    expect(kyc.documents).toEqual({});

    // Delivery point: label + landmark wiped, coordinates truncated NOW (FR-25).
    const rows = await prisma.$queryRaw<Array<{ label: string | null; landmark: string; lng: number; lat: number; truncate_after: Date | null }>>`
      SELECT label, landmark, ST_X(point) AS lng, ST_Y(point) AS lat, truncate_after
      FROM delivery_points WHERE id = ${point.id}::uuid`;
    expect(rows[0]!.label).toBeNull();
    expect(rows[0]!.landmark).toBe("[supprimé]");
    expect(rows[0]!.lng).toBeCloseTo(-17.46, 5);
    expect(rows[0]!.lat).toBeCloseTo(14.71, 5);
    expect(rows[0]!.truncate_after).toBeNull();

    // SMS outbox: pending sends cancelled, phone scrubbed everywhere.
    expect(await prisma.smsOutbox.count({ where: { phone } })).toBe(0);
    expect(await prisma.smsOutbox.count({ where: { phone: `deleted:${userId}`, status: "queued" } })).toBe(0);
    expect(await prisma.smsOutbox.count({ where: { phone: `deleted:${userId}` } })).toBe(2);

    // Append-only audit trail records the deletion.
    const audit = await prisma.auditLog.findFirst({ where: { actorId: userId, action: "privacy_delete" } });
    expect(audit).toBeTruthy();
  });
});

d("privacy delete — money/dispatch guards", () => {
  it("refuses while the buyer has a non-terminal order, then succeeds and scrubs snapshots", async () => {
    const prisma = app.deps.prisma;
    const { userId, access } = await signup(phoneFor(2), "priv-device-2");
    const shop = await prisma.shop.findFirstOrThrow(); // read-only use of a seed shop

    const order = await prisma.order.create({
      data: {
        shopId: shop.id,
        buyerId: userId,
        status: "created",
        subtotalMinor: 5000n,
        deliveryFeeMinor: 0n,
        totalMinor: 5000n,
        currency: "XOF",
        deliveryPointSnapshot: { lat: 14.712345, lng: -17.456789, landmark: "chez moi" },
        idempotencyKey: `priv-del-${runId}`,
        trackingToken: `priv-trk-${runId}`
      }
    });

    const blocked = await app.inject({ method: "DELETE", url: "/me", headers: { authorization: `Bearer ${access}` } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("active_orders");

    await prisma.order.update({ where: { id: order.id }, data: { status: "cancelled" } });
    const ok = await app.inject({ method: "DELETE", url: "/me", headers: { authorization: `Bearer ${access}` } });
    expect(ok.statusCode).toBe(200);

    // Terminal order retained for the books, but its GPS/landmark snapshot is gone.
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.deliveryPointSnapshot).toEqual({ anonymized: true });
  });

  it("refuses a rider still carrying COD cash, then succeeds once remitted", async () => {
    const prisma = app.deps.prisma;
    const { userId, access } = await signup(phoneFor(3), "priv-device-3");
    await prisma.rider.create({ data: { userId, vehicle: "moto", codOutstandingMinor: 4500n } });
    await prisma.riderCashLedger.create({
      data: { riderId: userId, amountMinor: 4500n, currency: "XOF", kind: "cod_collected" }
    });

    const blocked = await app.inject({ method: "DELETE", url: "/me", headers: { authorization: `Bearer ${access}` } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("cod_outstanding");

    // Remit (append-only ledger) and refresh the cache to keep invariant #3.
    await prisma.riderCashLedger.create({
      data: { riderId: userId, amountMinor: -4500n, currency: "XOF", kind: "remitted_pispi" }
    });
    await prisma.rider.update({ where: { userId }, data: { codOutstandingMinor: 0n } });

    const ok = await app.inject({ method: "DELETE", url: "/me", headers: { authorization: `Bearer ${access}` } });
    expect(ok.statusCode).toBe(200);
  });

  it("refuses a seller with an un-withdrawn payable balance, then succeeds at zero", async () => {
    const { userId, access } = await signup(phoneFor(4), "priv-device-4");
    await app.deps.ledger.post("adjustment", [
      { ownerType: "seller", ownerId: userId, amountMinor: 1000n, currency: "XOF", leg: "net" },
      { ownerType: "buyer_funds", amountMinor: -1000n, currency: "XOF", leg: "gross" }
    ]);

    const blocked = await app.inject({ method: "DELETE", url: "/me", headers: { authorization: `Bearer ${access}` } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("ledger_balance");

    await app.deps.ledger.post("adjustment", [
      { ownerType: "seller", ownerId: userId, amountMinor: -1000n, currency: "XOF", leg: "net" },
      { ownerType: "buyer_funds", amountMinor: 1000n, currency: "XOF", leg: "gross" }
    ]);
    const ok = await app.inject({ method: "DELETE", url: "/me", headers: { authorization: `Bearer ${access}` } });
    expect(ok.statusCode).toBe(200);
  });
});
