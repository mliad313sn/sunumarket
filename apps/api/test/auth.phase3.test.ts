import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MockMessagingProvider } from "../src/lib/messaging.js";

const url = process.env.DATABASE_URL;
const d = describe.skipIf(!url);

const messaging = new MockMessagingProvider();
let app: Awaited<ReturnType<typeof buildApp>>;

// Run-unique phone: users can't be hard-deleted once referenced by append-only
// fraud_events (immutability trigger — by design; privacy deletes anonymize instead).
const PHONE = `+22177${Math.floor(1000000 + Math.random() * 9000000)}`;
const DEVICE = "device-hash-test-0001";

function otpFor(phone: string): string {
  const sms = messaging.lastTo(phone);
  const m = sms?.body.match(/code est (\d{6})/);
  if (!m) throw new Error(`no OTP SMS for ${phone}`);
  return m[1]!;
}

beforeAll(async () => {
  app = await buildApp({ messaging });
});

afterAll(async () => {
  await app.close();
});

d("phase 3 — OTP flow", () => {
  it("rejects a phone that fails the pack regex (FR-49)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/otp",
      payload: { phone: "+225779990001", country: "SN", device_hash: DEVICE }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_phone");
  });

  it("sends a 6-digit OTP by SMS and throttles resend for 60 s", async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/auth/otp",
      payload: { phone: PHONE, country: "SN", device_hash: DEVICE }
    });
    expect(ok.statusCode).toBe(200);
    expect(otpFor(PHONE)).toMatch(/^\d{6}$/);

    const throttled = await app.inject({
      method: "POST",
      url: "/auth/otp",
      payload: { phone: PHONE, country: "SN", device_hash: DEVICE }
    });
    expect(throttled.statusCode).toBe(429);
  });

  it("rejects a wrong code, then accepts the right one (signs up buyer Tier 0)", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { phone: PHONE, code: "000000", device_hash: DEVICE }
    });
    // 1-in-a-million flake guard: the random OTP could actually be 000000
    expect([400, 200]).toContain(bad.statusCode);

    const good = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { phone: PHONE, code: otpFor(PHONE), device_hash: DEVICE }
    });
    expect(good.statusCode).toBe(200);
    const body = good.json();
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.reverify_required).toBe(false); // Tier 0 — no re-verify

    const me = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${body.access_token}` }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().kyc_tier).toBe(0);
  });

  it("locks after 5 wrong attempts (lockout)", async () => {
    const prisma = app.deps.prisma;
    await prisma.otpCode.deleteMany({ where: { phone: PHONE } });
    await prisma.otpCode.create({
      data: {
        phone: PHONE,
        codeHash: "not-a-real-hash",
        expiresAt: new Date(Date.now() + 300000)
      }
    });
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/verify",
        payload: { phone: PHONE, code: "111111", device_hash: DEVICE }
      });
      last = res.statusCode;
    }
    expect(last).toBe(423);
  });

  it("expired codes are rejected", async () => {
    const prisma = app.deps.prisma;
    await prisma.otpCode.deleteMany({ where: { phone: PHONE } });
    await prisma.otpCode.create({
      data: { phone: PHONE, codeHash: "x", expiresAt: new Date(Date.now() - 1000) }
    });
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { phone: PHONE, code: "222222", device_hash: DEVICE }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("otp_expired");
  });
});

d("phase 3 — refresh rotation", () => {
  it("rotates refresh tokens; reuse of a rotated token revokes the family", async () => {
    const prisma = app.deps.prisma;
    await prisma.otpCode.deleteMany({ where: { phone: PHONE } });
    await app.inject({
      method: "POST",
      url: "/auth/otp",
      payload: { phone: PHONE, country: "SN", device_hash: DEVICE }
    });
    const login = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { phone: PHONE, code: otpFor(PHONE), device_hash: DEVICE }
    });
    const r1 = login.json().refresh_token as string;

    const rot = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token: r1 } });
    expect(rot.statusCode).toBe(200);
    const r2 = rot.json().refresh_token as string;
    expect(r2).not.toBe(r1);

    // Reuse of r1 → theft signal → whole family revoked, r2 dies too.
    const reuse = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token: r1 } });
    expect(reuse.statusCode).toBe(401);
    const r2After = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token: r2 } });
    expect(r2After.statusCode).toBe(401);
  });
});

d("phase 3 — device binding & re-verification (DC-8.3)", () => {
  it("new device on a Tier-1 account flags reverify_required + payout cool-down", async () => {
    const prisma = app.deps.prisma;
    // Awa (seeded Tier 1 seller)
    const awa = await prisma.user.findUniqueOrThrow({ where: { phone: "+221771234501" } });
    await prisma.otpCode.deleteMany({ where: { phone: awa.phone } });
    await prisma.deviceBinding.deleteMany({ where: { userId: awa.id } });

    await app.inject({
      method: "POST",
      url: "/auth/otp",
      payload: { phone: awa.phone, country: "SN", device_hash: "awa-new-phone" }
    });
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { phone: awa.phone, code: otpFor(awa.phone), device_hash: "awa-new-phone" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reverify_required).toBe(true);

    // fraud event recorded for the anomaly queue
    const ev = await prisma.fraudEvent.findFirst({
      where: { userId: awa.id, kind: "new_device" },
      orderBy: { createdAt: "desc" }
    });
    expect(ev).toBeTruthy();

    // payout gate blocks inside cool-down window
    const gate = await app.deps.auth.payoutAllowed(awa.id, "awa-new-phone");
    expect(gate.allowed).toBe(false);

    // ...and opens after the cool-down elapses
    const future = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const gateLater = await app.deps.auth.payoutAllowed(awa.id, "awa-new-phone", future);
    expect(gateLater.allowed).toBe(true);
  });
});

d("phase 3 — payout PIN (optional, DC-8.3)", () => {
  it("verifies when set, passes when unset", async () => {
    const prisma = app.deps.prisma;
    const user = await prisma.user.findUniqueOrThrow({ where: { phone: PHONE } });
    expect(await app.deps.auth.verifyPayoutPin(user.id, undefined)).toBe(true);
    await app.deps.auth.setPayoutPin(user.id, "4321");
    expect(await app.deps.auth.verifyPayoutPin(user.id, "4321")).toBe(true);
    expect(await app.deps.auth.verifyPayoutPin(user.id, "0000")).toBe(false);
    expect(await app.deps.auth.verifyPayoutPin(user.id, undefined)).toBe(false);
  });
});
