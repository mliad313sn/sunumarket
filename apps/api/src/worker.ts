/**
 * Worker entrypoint — committee finding D. Runs the periodic sweeps that the
 * services expose (they were previously only exercised by tests):
 *   - order expiry (30-min hold → expired + restock exactly once, FR-17)
 *   - USSD confirmation timeouts (DC-14)
 *   - dispatch re-broadcast + seller escalation (FR-26)
 *   - delivery-point retention truncation (FR-25)
 *   - delivered → completed auto-close (FR-36)
 *   - SMS outbox retry (DC-15)
 *
 * Interval-based single process for V1; BullMQ repeatable jobs replace this
 * when multi-instance prod lands (BACKLOG, with the Redis-shared breaker).
 */
import { buildDeps } from "./deps.js";
import { OutboxMessagingProvider } from "./lib/messaging.js";

const FAST_SWEEP_MS = Number(process.env.SUNU_WORKER_FAST_MS ?? 60_000);
const SLOW_SWEEP_MS = Number(process.env.SUNU_WORKER_SLOW_MS ?? 60 * 60_000);

const deps = buildDeps();

async function safely(name: string, fn: () => Promise<number>): Promise<void> {
  try {
    const n = await fn();
    if (n > 0) console.log(`[worker] ${name}: ${n}`);
  } catch (e) {
    console.error(`[worker] ${name} failed`, e);
  }
}

/** Liveness (pass-2 fix 10): each sweep upserts its heartbeat; /health flags staleness. */
async function beat(id: string): Promise<void> {
  const beatAt = new Date();
  try {
    await deps.prisma.workerHeartbeat.upsert({ where: { id }, update: { beatAt }, create: { id, beatAt } });
  } catch (e) {
    console.error(`[worker] heartbeat ${id} failed`, e);
  }
}

export async function fastSweep(): Promise<void> {
  await safely("expire-orders", () => deps.orders.expireOverdueOrders());
  await safely("ussd-timeouts", () => deps.payments.sweepUssdTimeouts());
  await safely("rebroadcast", () => deps.delivery.rebroadcastStale());
  if (deps.messaging instanceof OutboxMessagingProvider) {
    await safely("sms-outbox-retry", () => (deps.messaging as OutboxMessagingProvider).flushQueued());
  }
  await beat("fast");
}

export async function slowSweep(): Promise<void> {
  await safely("retention-truncation", () => deps.geo.runRetentionTruncation());
  await safely("auto-complete", () => deps.orders.autoCompleteDelivered());
  await beat("slow");
}

if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  console.log(`[worker] up — fast sweep ${FAST_SWEEP_MS}ms, slow sweep ${SLOW_SWEEP_MS}ms`);
  void fastSweep();
  void slowSweep();
  setInterval(() => void fastSweep(), FAST_SWEEP_MS);
  setInterval(() => void slowSweep(), SLOW_SWEEP_MS);
}
