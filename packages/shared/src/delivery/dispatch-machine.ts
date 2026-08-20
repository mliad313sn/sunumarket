import type { JobStatus } from "../contracts/delivery.js";

/**
 * Dispatch/job state machine — FR-26 (TDD-critical machine, Playbook 0.4). Pure.
 *
 * requested → broadcasting → accepted → picked_up → en_route → arrived → delivered
 * failed_attempt loops back to en_route (retry) or ends in cancelled (refund path).
 * SELF/PARTNER modes enter at accepted (no broadcast).
 */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  requested: ["broadcasting", "accepted", "cancelled"],
  broadcasting: ["accepted", "cancelled"],
  accepted: ["picked_up", "cancelled"],
  picked_up: ["en_route", "failed_attempt", "cancelled"],
  en_route: ["arrived", "failed_attempt"],
  arrived: ["delivered", "failed_attempt"],
  failed_attempt: ["en_route", "arrived", "cancelled"],
  delivered: [],
  cancelled: []
};

export const JOB_STATUSES = Object.keys(TRANSITIONS) as JobStatus[];

export class IllegalJobTransitionError extends Error {
  constructor(
    public readonly from: JobStatus,
    public readonly to: JobStatus
  ) {
    super(`illegal job transition ${from} → ${to}`);
    this.name = "IllegalJobTransitionError";
  }
}

export function canJobTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertJobTransition(from: JobStatus, to: JobStatus): JobStatus {
  if (!canJobTransition(from, to)) throw new IllegalJobTransitionError(from, to);
  return to;
}

export function isJobTerminal(status: JobStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Delivered requires proof (photo or OTP) — FR-30; enforced by the service layer. */
export function requiresProof(to: JobStatus): boolean {
  return to === "delivered";
}
