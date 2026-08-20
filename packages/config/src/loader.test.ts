import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PackRegistry, PackValidationError } from "./loader.js";

describe("country packs — validation (FR-49)", () => {
  const reg = new PackRegistry();

  it("loads and validates all shipped packs (sn, ci, bf active; ml, tg, bj, ne drafts)", () => {
    expect(reg.list().map((p) => p.country).sort()).toEqual(["BF", "CI", "SN"]);
    expect(reg.list(true).length).toBe(7);
  });

  it("SN matrix: Wave first, OM second (Goal §3.2 seed); BF has no Wave", () => {
    const sn = reg.enabledMethods("SN");
    expect(sn[0]!.type).toBe("WAVE");
    expect(sn[1]!.type).toBe("ORANGE_MONEY");
    const bf = reg.enabledMethods("BF");
    expect(bf.some((m) => m.type === "WAVE")).toBe(false);
    expect(bf[0]!.type).toBe("ORANGE_MONEY");
  });

  it("CI shows ≥3 mobile-money methods (four-operator market)", () => {
    const mm = reg
      .enabledMethods("CI")
      .filter((m) => ["WAVE", "ORANGE_MONEY", "MTN_MOMO", "MOOV_MONEY"].includes(m.type));
    expect(mm.length).toBeGreaterThanOrEqual(3);
  });

  it("MANUAL_TRANSFER is default OFF in every pack (DC-8.2)", () => {
    for (const p of reg.list(true)) {
      const manual = p.methods.find((m) => m.type === "MANUAL_TRANSFER");
      expect(manual, p.country).toBeDefined();
      expect(manual!.enabled, p.country).toBe(false);
    }
  });

  it("every enabled USSD method carries a dial code (DC-14)", () => {
    for (const p of reg.list(true)) {
      for (const m of p.methods.filter((m) => m.enabled && m.ussd_confirm)) {
        expect(m.ussd_dial_code, `${p.country}/${m.type}`).toBeTruthy();
      }
    }
  });

  it("phone validation follows pack regex (+221/+225/+226)", () => {
    expect(reg.validatePhone("SN", "+221771234567")).toBe(true);
    expect(reg.validatePhone("SN", "+225771234567")).toBe(false);
    expect(reg.validatePhone("CI", "+2250701234567")).toBe(true);
    expect(reg.validatePhone("BF", "+22670123456")).toBe(true);
  });

  it("KYC tier limits parse to bigint (DC-13)", () => {
    const t2 = reg.kycLimit("SN", 2);
    expect(t2.payoutDailyMinor).toBe(2000000n);
    expect(t2.codOutstandingMinor).toBe(100000n);
    expect(reg.kycLimit("SN", 0).payoutDailyMinor).toBe(0n);
  });

  it("provider routes resolve primary + fallback (FR-14b)", () => {
    expect(reg.providerRoute("SN", "WAVE")).toEqual({ primary: "AGG_A", fallback: "AGG_B" });
    expect(reg.providerRoute("SN", "PI_SPI").fallback).toBeNull();
    expect(() => reg.providerRoute("BF", "WAVE")).toThrow();
  });

  it("zones load with polygons and fee bands", () => {
    const zones = reg.zones("SN");
    expect(zones.length).toBeGreaterThanOrEqual(3);
    expect(zones[0]!.polygon[0]!.length).toBeGreaterThanOrEqual(4);
    expect(BigInt(zones[0]!.fee_minor)).toBeGreaterThan(0n);
  });
});

describe("country packs — hot reload & overrides", () => {
  it("reload() flips checkout config without restart (Phase 2 verify)", () => {
    const dir = mkdtempSync(join(tmpdir(), "packs-"));
    cpSync(new URL("../countries", import.meta.url).pathname, dir, { recursive: true });
    const reg = new PackRegistry(dir);
    expect(reg.enabledMethods("SN")[0]!.type).toBe("WAVE");

    const snPath = join(dir, "sn.json");
    const sn = JSON.parse(readFileSync(snPath, "utf8")) as {
      version: number;
      methods: Array<{ type: string; enabled: boolean }>;
    };
    sn.version = 2;
    sn.methods.find((m) => m.type === "WAVE")!.enabled = false;
    writeFileSync(snPath, JSON.stringify(sn));

    reg.reload();
    expect(reg.get("SN").version).toBe(2);
    expect(reg.enabledMethods("SN")[0]!.type).toBe("ORANGE_MONEY");
  });

  it("invalid pack fails loudly with file + issues", () => {
    const dir = mkdtempSync(join(tmpdir(), "packs-bad-"));
    cpSync(new URL("../countries", import.meta.url).pathname, dir, { recursive: true });
    const snPath = join(dir, "sn.json");
    const sn = JSON.parse(readFileSync(snPath, "utf8")) as { methods: Array<{ type: string; ussd_dial_code?: string }> };
    delete sn.methods.find((m) => m.type === "ORANGE_MONEY")!.ussd_dial_code;
    writeFileSync(snPath, JSON.stringify(sn));
    expect(() => new PackRegistry(dir)).toThrow(PackValidationError);
  });

  it("admin override toggles MANUAL_TRANSFER at runtime without pack edit (FR-44b)", () => {
    const reg = new PackRegistry();
    expect(reg.enabledMethods("SN").some((m) => m.type === "MANUAL_TRANSFER")).toBe(false);
    reg.setMethodOverride("SN", "MANUAL_TRANSFER", true);
    expect(reg.enabledMethods("SN").some((m) => m.type === "MANUAL_TRANSFER")).toBe(true);
    reg.clearOverrides("SN");
    expect(reg.enabledMethods("SN").some((m) => m.type === "MANUAL_TRANSFER")).toBe(false);
  });
});
