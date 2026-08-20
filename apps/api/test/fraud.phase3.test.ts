import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  MemoryCounterStore,
  VelocityRules
} from "../src/modules/fraud/velocity.js";

describe("phase 3 — velocity rules (pure, ADR-0010)", () => {
  it("10 failed payments in 5 min raises the flag exactly once", () => {
    const rules = new VelocityRules(new MemoryCounterStore());
    const t0 = 1_000_000;
    let flags = 0;
    for (let i = 0; i < 12; i++) {
      const f = rules.recordFailedPayment("buyer-1", t0 + i * 1000);
      if (f) {
        flags++;
        expect(f.kind).toBe("velocity_failed_payments");
        expect(f.count).toBe(10);
      }
    }
    expect(flags).toBe(1);
    expect(rules.isPaymentBlocked("buyer-1", t0 + 20000)).toBe(true);
  });

  it("events outside the window do not accumulate (soft-block expires)", () => {
    const rules = new VelocityRules(new MemoryCounterStore());
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) rules.recordFailedPayment("buyer-2", t0 + i * 1000);
    expect(rules.isPaymentBlocked("buyer-2", t0 + 10_000)).toBe(true);
    // 5 minutes later the window is empty — user can retry (DC-2: never a ban)
    expect(rules.isPaymentBlocked("buyer-2", t0 + DEFAULT_THRESHOLDS.failedPaymentsWindowMs + 11_000)).toBe(false);
  });

  it("5 signups from one device in an hour flags mass_signup", () => {
    const rules = new VelocityRules(new MemoryCounterStore());
    const t0 = 5_000_000;
    let flag = null;
    for (let i = 0; i < 5; i++) flag = rules.recordSignup("device-x", t0 + i * 60_000) ?? flag;
    expect(flag?.kind).toBe("mass_signup");
    expect(flag?.count).toBe(5);
  });

  it("different subjects do not cross-contaminate", () => {
    const rules = new VelocityRules(new MemoryCounterStore());
    for (let i = 0; i < 9; i++) rules.recordFailedPayment("a", 1000 + i);
    expect(rules.isPaymentBlocked("a", 2000)).toBe(false);
    expect(rules.isPaymentBlocked("b", 2000)).toBe(false);
  });
});
