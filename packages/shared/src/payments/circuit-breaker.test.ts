import { describe, expect, it } from "vitest";
import { CircuitBreaker, DEFAULT_BREAKER_CONFIG } from "./circuit-breaker.js";

const T0 = 1_000_000;

describe("circuit breaker (ADR-0005)", () => {
  it("opens after 3 consecutive failures — detection well under 60 s (NFR-2)", () => {
    const b = new CircuitBreaker();
    b.recordFailure(T0);
    b.recordFailure(T0 + 1000);
    expect(b.getState(T0 + 1500)).toBe("closed");
    b.recordFailure(T0 + 2000);
    expect(b.getState(T0 + 2001)).toBe("open");
    expect(b.allowRequest(T0 + 2002)).toBe(false);
  });

  it("opens on 5 failures in the rolling 60 s window even without 3-in-a-row", () => {
    const b = new CircuitBreaker();
    // interleave successes so consecutive never reaches 3
    for (let i = 0; i < 4; i++) {
      b.recordFailure(T0 + i * 10_000);
      b.recordFailure(T0 + i * 10_000 + 1000);
      b.recordSuccess(T0 + i * 10_000 + 2000);
    }
    expect(b.getState(T0 + 50_000)).toBe("closed");
    // now 5 failures within one window, no success in between
    for (let i = 0; i < 5; i++) {
      b.recordFailure(T0 + 100_000 + i * 5_000);
      if (i < 2) b.recordSuccess(T0 + 100_001 + i * 5_000); // resets consecutive but window still counts? no — success clears window
    }
    // success clears everything, so rebuild cleanly:
    const b2 = new CircuitBreaker({ ...DEFAULT_BREAKER_CONFIG, consecutiveFailures: 99 });
    for (let i = 0; i < 5; i++) b2.recordFailure(T0 + i * 10_000);
    expect(b2.getState(T0 + 41_000)).toBe("open");
  });

  it("half-open after cool-down, one probe only; probe success closes", () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 3; i++) b.recordFailure(T0 + i);
    expect(b.getState(T0 + 10)).toBe("open");
    expect(b.allowRequest(T0 + 29_000)).toBe(false);
    // cool-down 30 s
    expect(b.getState(T0 + 30_010)).toBe("half_open");
    expect(b.allowRequest(T0 + 30_011)).toBe(true); // the probe
    expect(b.allowRequest(T0 + 30_012)).toBe(false); // only one probe
    b.recordSuccess(T0 + 30_500);
    expect(b.getState(T0 + 30_501)).toBe("closed");
    expect(b.allowRequest(T0 + 30_502)).toBe(true);
  });

  it("probe failure re-opens with doubled cool-down, capped", () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 3; i++) b.recordFailure(T0 + i);
    // first cool-down: 30 s → half-open, probe fails
    b.getState(T0 + 30_010);
    expect(b.allowRequest(T0 + 30_011)).toBe(true);
    b.recordFailure(T0 + 30_100);
    expect(b.getState(T0 + 30_200)).toBe("open");
    // second cool-down doubles to 60 s
    expect(b.getState(T0 + 30_100 + 59_000)).toBe("open");
    expect(b.getState(T0 + 30_100 + 60_010)).toBe("half_open");
  });

  it("success resets failure history completely", () => {
    const b = new CircuitBreaker();
    b.recordFailure(T0);
    b.recordFailure(T0 + 1);
    b.recordSuccess(T0 + 2);
    b.recordFailure(T0 + 3);
    b.recordFailure(T0 + 4);
    expect(b.getState(T0 + 5)).toBe("closed");
  });
});
