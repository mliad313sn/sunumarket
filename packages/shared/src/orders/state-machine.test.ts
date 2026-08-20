import { describe, expect, it } from "vitest";
import type { OrderStatus } from "../contracts/orders.js";
import {
  ORDER_STATUSES,
  IllegalTransitionError,
  assertTransition,
  canTransition,
  holdsStock,
  isTerminal,
  legalTargets
} from "./state-machine.js";

describe("order state machine — 100% transition coverage (Phase 6 gate)", () => {
  const LEGAL: Array<[OrderStatus, OrderStatus]> = [
    ["created", "payment_pending"],
    ["created", "cancelled"],
    ["payment_pending", "paid"],
    ["payment_pending", "payment_review"],
    ["payment_pending", "expired"],
    ["payment_pending", "cancelled"],
    ["payment_review", "paid"],
    ["payment_review", "cancelled"],
    ["paid", "preparing"],
    ["paid", "refunded"],
    ["paid", "cancelled"],
    ["preparing", "in_delivery"],
    ["preparing", "cancelled"],
    ["preparing", "refunded"],
    ["in_delivery", "delivered"],
    ["in_delivery", "delivery_issue"],
    ["delivery_issue", "in_delivery"],
    ["delivery_issue", "refunded"],
    ["delivery_issue", "delivered"],
    ["delivered", "completed"],
    ["delivered", "delivery_issue"]
  ];

  it("every legal transition is allowed", () => {
    for (const [from, to] of LEGAL) {
      expect(canTransition(from, to), `${from}→${to}`).toBe(true);
      expect(assertTransition(from, to)).toBe(to);
    }
  });

  it("every other pair is illegal (exhaustive negative sweep)", () => {
    const legalSet = new Set(LEGAL.map(([f, t]) => `${f}|${t}`));
    let illegalCount = 0;
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        if (from === to || legalSet.has(`${from}|${to}`)) continue;
        expect(canTransition(from, to), `${from}→${to} must be illegal`).toBe(false);
        expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
        illegalCount++;
      }
    }
    expect(illegalCount).toBeGreaterThan(100); // sweep really covered the space
  });

  it("terminal states have no exits", () => {
    for (const s of ["completed", "cancelled", "expired", "refunded"] as OrderStatus[]) {
      expect(isTerminal(s)).toBe(true);
      expect(legalTargets(s)).toHaveLength(0);
    }
  });

  it("stock is held until cancel/expiry/refund (drives restore-exactly-once)", () => {
    expect(holdsStock("payment_pending")).toBe(true);
    expect(holdsStock("paid")).toBe(true);
    expect(holdsStock("delivered")).toBe(true);
    expect(holdsStock("expired")).toBe(false);
    expect(holdsStock("cancelled")).toBe(false);
    expect(holdsStock("refunded")).toBe(false);
  });

  it("the paid state is reachable only from payment_pending/payment_review (DC-8.1 guard)", () => {
    const sources = ORDER_STATUSES.filter((s) => canTransition(s, "paid"));
    expect(sources.sort()).toEqual(["payment_pending", "payment_review"]);
  });
});
