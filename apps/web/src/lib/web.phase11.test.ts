import { beforeEach, describe, expect, it } from "vitest";
import { dictionaries } from "./i18n.js";
import { drainEvents, funnel } from "./analytics.js";
import { OfflineQueue } from "./offline-queue.js";
import { isExpired, resend, secondsLeft, secondsOnScreen, startUssd } from "./ussd.js";

describe("phase 11 — i18n (FR/EN parity, no missing keys)", () => {
  it("EN covers every FR key with a non-empty string", () => {
    const { fr, en } = dictionaries();
    for (const key of Object.keys(fr)) {
      expect(en[key as keyof typeof en], key).toBeTruthy();
    }
    expect(Object.keys(en).length).toBe(Object.keys(fr).length);
  });

  it("critical DC microcopy is present in French", () => {
    const { fr } = dictionaries();
    expect(fr.ussd_body).toContain("confirmation sur votre téléphone"); // DC-2 microcopy
    expect(fr.payment_failed_balance).toContain("réservée 30 min"); // DC-3
    expect(fr.ussd_switch).toBeTruthy(); // DC-14 escape
  });
});

describe("phase 11 — USSD countdown (DC-14)", () => {
  it("counts down, expires, resend restarts", () => {
    const t0 = 1_000_000;
    const s = startUssd("ORANGE_MONEY", "#144#", 120, t0);
    expect(secondsLeft(s, t0)).toBe(120);
    expect(secondsLeft(s, t0 + 30_000)).toBe(90);
    expect(isExpired(s, t0 + 119_000)).toBe(false);
    expect(isExpired(s, t0 + 120_000)).toBe(true);
    const r = resend(s, t0 + 60_000);
    expect(secondsLeft(r, t0 + 60_000)).toBe(120);
    expect(secondsOnScreen(s, t0 + 45_500)).toBe(45);
  });
});

describe("phase 11 — offline queue (golden path 8 buyer leg)", () => {
  class MemStore {
    private m = new Map<string, string>();
    getItem(k: string) {
      return this.m.get(k) ?? null;
    }
    setItem(k: string, v: string) {
      this.m.set(k, v);
    }
  }

  beforeEach(() => {
    // fresh store per test via new instances
  });

  it("queues offline actions and flushes each exactly once", async () => {
    const sent: string[] = [];
    const q = new OfflineQueue(new MemStore(), async (req) => {
      sent.push(req.id);
      return true;
    });
    q.enqueue("/api/orders", { a: 1 });
    q.enqueue("/api/orders", { a: 2 });
    expect(q.size()).toBe(2);

    const r1 = await q.flush();
    expect(r1).toEqual({ sent: 2, remaining: 0 });
    // double flush cannot resend
    const r2 = await q.flush();
    expect(r2).toEqual({ sent: 0, remaining: 0 });
    expect(new Set(sent).size).toBe(2);
  });

  it("stops at the first failure and retries later in order", async () => {
    let failFirst = true;
    const sent: unknown[] = [];
    const q = new OfflineQueue(new MemStore(), async (req) => {
      if (failFirst) {
        failFirst = false;
        return false;
      }
      sent.push(req.body);
      return true;
    });
    q.enqueue("/api/orders", { n: 1 });
    q.enqueue("/api/orders", { n: 2 });

    const r1 = await q.flush();
    expect(r1.sent).toBe(0);
    expect(r1.remaining).toBe(2);

    const r2 = await q.flush();
    expect(r2).toEqual({ sent: 2, remaining: 0 });
    expect(sent).toEqual([{ n: 1 }, { n: 2 }]); // order preserved
  });
});

describe("phase 11 — payment funnel events incl. USSD abandonment (KPI §10)", () => {
  it("each golden-path step emits its event; abandonment carries seconds on screen", () => {
    drainEvents();
    funnel.checkoutOpened(4);
    funnel.methodChosen("ORANGE_MONEY", false);
    funnel.attemptCreated("ORANGE_MONEY", "AGG_A");
    funnel.ussdShown("ORANGE_MONEY");
    funnel.ussdResent("ORANGE_MONEY");
    funnel.ussdAbandoned("ORANGE_MONEY", 45);
    funnel.methodSwitched("ORANGE_MONEY", "WAVE");
    funnel.paid("WAVE");

    const events = drainEvents();
    expect(events.map((e) => e.name)).toEqual([
      "checkout_opened",
      "method_chosen",
      "attempt_created",
      "ussd_confirm_shown",
      "ussd_resend",
      "ussd_abandoned",
      "method_switched",
      "payment_succeeded"
    ]);
    const abandon = events.find((e) => e.name === "ussd_abandoned")!;
    expect(abandon.props.seconds_on_screen).toBe(45);
    expect(abandon.props.method).toBe("ORANGE_MONEY");
  });
});
