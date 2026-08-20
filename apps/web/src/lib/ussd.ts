/**
 * DC-14 USSD confirmation screen state — pure, testable countdown logic.
 * Screen shows: operator dial code, countdown, resend, switch-method escape.
 */
export interface UssdState {
  method: string;
  dialCode: string;
  totalSeconds: number;
  startedAt: number;
}

export function startUssd(method: string, dialCode: string, totalSeconds = 120, now = Date.now()): UssdState {
  return { method, dialCode, totalSeconds, startedAt: now };
}

export function secondsLeft(s: UssdState, now = Date.now()): number {
  return Math.max(0, s.totalSeconds - Math.floor((now - s.startedAt) / 1000));
}

export function isExpired(s: UssdState, now = Date.now()): boolean {
  return secondsLeft(s, now) === 0;
}

export function resend(s: UssdState, now = Date.now()): UssdState {
  return { ...s, startedAt: now };
}

/** Seconds the buyer spent before abandoning (feeds the KPI event). */
export function secondsOnScreen(s: UssdState, now = Date.now()): number {
  return Math.floor((now - s.startedAt) / 1000);
}
