import type { PrismaClient } from "@prisma/client";
import { PackRegistry } from "@sunumarket/config";
import type { MessagingProvider } from "../../lib/messaging.js";
import { generateOtp, generateToken, hashSecret, sha256, verifySecret } from "../../lib/crypto.js";
import type { VelocityRules } from "../fraud/velocity.js";
import { FraudService } from "../fraud/fraud.service.js";

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_THROTTLE_MS = 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** DC-8.3: payout cool-down after a new device is verified on a Tier≥1 account. */
export const NEW_DEVICE_COOLDOWN_MS = Number(process.env.SUNU_DEVICE_COOLDOWN_MS ?? 24 * 60 * 60 * 1000);

export class AuthError extends Error {
  constructor(
    public readonly code:
      | "otp_throttled"
      | "otp_invalid"
      | "otp_expired"
      | "otp_locked"
      | "invalid_phone"
      | "invalid_refresh",
    message: string
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: MessagingProvider,
    private readonly packs: PackRegistry,
    private readonly velocity: VelocityRules,
    private readonly fraud: FraudService
  ) {}

  async requestOtp(phone: string, country: string, deviceHash: string): Promise<void> {
    if (!this.packs.validatePhone(country, phone)) {
      throw new AuthError("invalid_phone", "numéro invalide pour ce pays");
    }
    const recent = await this.prisma.otpCode.findFirst({
      where: { phone, createdAt: { gt: new Date(Date.now() - OTP_RESEND_THROTTLE_MS) } }
    });
    if (recent) throw new AuthError("otp_throttled", "réessayez dans une minute");

    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (!existing) {
      const flag = this.velocity.recordSignup(deviceHash);
      if (flag) await this.fraud.record(flag.kind, { deviceHash, detail: { count: flag.count } });
    }

    const code = generateOtp();
    await this.prisma.otpCode.create({
      data: { phone, codeHash: sha256(code), expiresAt: new Date(Date.now() + OTP_TTL_MS) }
    });
    const senderId = this.packs.get(country).sms_sender_ids[0] ?? "SUNUMKT";
    await this.messaging.sendSms({
      phone,
      senderId,
      body: `SunuMarket: votre code est ${code}. Valable 5 minutes. Ne le partagez jamais.`
    });
  }

  async verifyOtp(
    phone: string,
    code: string,
    deviceHash: string,
    country?: string
  ): Promise<{ accessPayload: AccessPayload; refreshToken: string; reverifyRequired: boolean }> {
    const otp = await this.prisma.otpCode.findFirst({
      where: { phone, usedAt: null },
      orderBy: { createdAt: "desc" }
    });
    if (!otp) throw new AuthError("otp_invalid", "code invalide");
    if (otp.expiresAt < new Date()) throw new AuthError("otp_expired", "code expiré");
    if (otp.attempts >= OTP_MAX_ATTEMPTS) throw new AuthError("otp_locked", "trop d'essais — redemandez un code");

    if (otp.codeHash !== sha256(code)) {
      await this.prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      const updated = otp.attempts + 1;
      if (updated >= OTP_MAX_ATTEMPTS) throw new AuthError("otp_locked", "trop d'essais — redemandez un code");
      throw new AuthError("otp_invalid", "code invalide");
    }
    await this.prisma.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } });

    let user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) {
      user = await this.prisma.user.create({
        data: { phone, country: country ?? "SN", roles: ["buyer"], locale: "fr" }
      });
    }

    // Device binding (DC-8.3): a device becomes trusted by completing OTP on it.
    // On Tier≥1 accounts a brand-new device flags re-verification + payout cool-down.
    const known = await this.prisma.deviceBinding.findUnique({
      where: { userId_deviceHash: { userId: user.id, deviceHash } }
    });
    const isNewDevice = !known;
    await this.prisma.deviceBinding.upsert({
      where: { userId_deviceHash: { userId: user.id, deviceHash } },
      update: { trusted: true, lastVerified: new Date() },
      create: { userId: user.id, deviceHash, trusted: true, lastVerified: new Date() }
    });
    const reverifyRequired = isNewDevice && user.kycTier >= 1;
    if (reverifyRequired) {
      await this.fraud.record("new_device", { userId: user.id, deviceHash, detail: { kycTier: user.kycTier } });
    }

    const refreshToken = await this.issueRefresh(user.id, deviceHash);
    return {
      accessPayload: { sub: user.id, roles: user.roles, tier: user.kycTier, device: deviceHash },
      refreshToken,
      reverifyRequired
    };
  }

  private async issueRefresh(userId: string, deviceHash: string): Promise<string> {
    const token = generateToken();
    await this.prisma.refreshToken.create({
      data: {
        userId,
        deviceHash,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS)
      }
    });
    return token;
  }

  /** Refresh rotation: each refresh single-use; reuse of a rotated token revokes the family. */
  async rotateRefresh(token: string): Promise<{ accessPayload: AccessPayload; refreshToken: string }> {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.expiresAt < new Date()) throw new AuthError("invalid_refresh", "session expirée");
    if (row.revokedAt) {
      // Reuse of a rotated/revoked token — likely theft: revoke everything for the user.
      await this.prisma.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() }
      });
      await this.fraud.record("refresh_reuse", { userId: row.userId, deviceHash: row.deviceHash, detail: {} });
      throw new AuthError("invalid_refresh", "session invalide — reconnectez-vous");
    }
    const next = await this.issueRefresh(row.userId, row.deviceHash);
    const nextRow = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(next) } });
    await this.prisma.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date(), rotatedTo: nextRow?.id }
    });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: row.userId } });
    return {
      accessPayload: { sub: user.id, roles: user.roles, tier: user.kycTier, device: row.deviceHash },
      refreshToken: next
    };
  }

  /**
   * DC-8.3 payout gate: device must be trusted AND (for Tier≥1) past the new-device
   * cool-down window since first verification on this device.
   */
  async payoutAllowed(userId: string, deviceHash: string, now = new Date()): Promise<{ allowed: boolean; reason?: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const device = await this.prisma.deviceBinding.findUnique({
      where: { userId_deviceHash: { userId, deviceHash } }
    });
    if (!device?.trusted) return { allowed: false, reason: "appareil non vérifié" };
    if (user.kycTier >= 1) {
      const since = now.getTime() - device.firstSeen.getTime();
      if (since < NEW_DEVICE_COOLDOWN_MS) {
        return { allowed: false, reason: "nouvel appareil — patientez avant tout retrait (protection anti-fraude)" };
      }
    }
    return { allowed: true };
  }

  async setPayoutPin(userId: string, pin: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { payoutPinHash: hashSecret(pin) } });
  }

  async verifyPayoutPin(userId: string, pin: string | undefined): Promise<boolean> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.payoutPinHash) return true; // PIN optional (DC-8.3)
    return pin !== undefined && verifySecret(pin, user.payoutPinHash);
  }
}

export interface AccessPayload {
  sub: string;
  roles: string[];
  tier: number;
  device: string;
}
