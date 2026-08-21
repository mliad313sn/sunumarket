import { describe, expect, it } from "vitest";
import type { JobStatus } from "../contracts/delivery.js";
import {
  JOB_STATUSES,
  IllegalJobTransitionError,
  assertJobTransition,
  canJobTransition,
  isJobTerminal,
  requiresProof
} from "./dispatch-machine.js";

describe("dispatch state machine — full coverage (Phase 9)", () => {
  const LEGAL: Array<[JobStatus, JobStatus]> = [
    ["requested", "broadcasting"],
    ["requested", "accepted"],
    ["requested", "cancelled"],
    ["broadcasting", "accepted"],
    ["broadcasting", "cancelled"],
    ["accepted", "picked_up"],
    ["accepted", "cancelled"],
    ["picked_up", "en_route"],
    ["picked_up", "failed_attempt"],
    ["picked_up", "cancelled"],
    ["en_route", "arrived"],
    ["en_route", "failed_attempt"],
    ["arrived", "delivered"],
    ["arrived", "failed_attempt"],
    ["failed_attempt", "en_route"],
    ["failed_attempt", "arrived"],
    // Rider incident → the job is released back to the market (re-dispatch).
    ["failed_attempt", "broadcasting"],
    ["failed_attempt", "cancelled"]
  ];

  it("all legal transitions pass", () => {
    for (const [f, t] of LEGAL) expect(assertJobTransition(f, t)).toBe(t);
  });

  it("everything else is illegal (exhaustive sweep)", () => {
    const legal = new Set(LEGAL.map(([f, t]) => `${f}|${t}`));
    for (const f of JOB_STATUSES) {
      for (const t of JOB_STATUSES) {
        if (f === t || legal.has(`${f}|${t}`)) continue;
        expect(canJobTransition(f, t), `${f}→${t}`).toBe(false);
        expect(() => assertJobTransition(f, t)).toThrow(IllegalJobTransitionError);
      }
    }
  });

  it("delivered/cancelled are terminal; delivered demands proof", () => {
    expect(isJobTerminal("delivered")).toBe(true);
    expect(isJobTerminal("cancelled")).toBe(true);
    expect(requiresProof("delivered")).toBe(true);
    expect(requiresProof("arrived")).toBe(false);
  });

  it("a rider can never jump from accepted to delivered (proof-gated close)", () => {
    expect(canJobTransition("accepted", "delivered")).toBe(false);
    expect(canJobTransition("picked_up", "delivered")).toBe(false);
  });
});
