import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function generateOtp(): string {
  return randomInt(0, 1000000).toString().padStart(6, "0");
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

const SCRYPT_KEYLEN = 32;

export function hashSecret(secret: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(secret, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(secret, salt, SCRYPT_KEYLEN);
  return timingSafeEqual(candidate, Buffer.from(hash, "hex"));
}
