import type { OrderStatus } from "../contracts/orders.js";

/**
 * Order state machine — FR-36 (one of the five TDD-critical machines, Playbook 0.4).
 * Pure: no I/O. The API layer persists only transitions this machine allows.
 *
 *  created → payment_pending → paid → preparing → in_delivery → delivered → completed
 *                │    │                                 │
 *                │    └→ payment_review → paid|cancelled│→ delivery_issue → refunded|in_delivery
 *                └→ expired (30-min hold) / cancelled
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  created: ["payment_pending", "cancelled"],
  payment_pending: ["paid", "payment_review", "expired", "cancelled"],
  payment_review: ["paid", "cancelled"],
  paid: ["preparing", "refunded", "cancelled"],
  preparing: ["in_delivery", "cancelled", "refunded"],
  in_delivery: ["delivered", "delivery_issue"],
  delivery_issue: ["in_delivery", "refunded", "delivered"],
  delivered: ["completed", "delivery_issue"],
  completed: [],
  cancelled: [],
  expired: [],
  refunded: []
};

export const ORDER_STATUSES = Object.keys(TRANSITIONS) as OrderStatus[];

export const TERMINAL_STATUSES: readonly OrderStatus[] = ["completed", "cancelled", "expired", "refunded"];

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: OrderStatus,
    public readonly to: OrderStatus
  ) {
    super(`illegal order transition ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): OrderStatus {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Statuses in which the reserved stock is still held by this order. */
export function holdsStock(status: OrderStatus): boolean {
  return !["cancelled", "expired", "refunded"].includes(status);
}

export function legalTargets(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from];
}
