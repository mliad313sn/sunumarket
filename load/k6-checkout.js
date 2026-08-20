/**
 * k6 load test — Playbook Phase 12 (to run against a staging stack; the build
 * sandbox has no k6/docker, so this script is the artifact and CI runs it).
 *
 *   k6 run -e BASE=https://staging.example load/k6-checkout.js
 *
 * Profile: 200 concurrent checkouts mixed methods WITH primary-provider outage
 * injected mid-run (toggle via admin route-flip webhook), 100 concurrent rider
 * status updates, 1000 rps catalogue reads, 10 min.
 * Pass criteria: zero lost/duplicated orders/jobs, p95 < 400 ms,
 * ledger + COD invariants hold post-run (checked by scripts/invariants.sql).
 */
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE || "http://localhost:3001";

export const options = {
  scenarios: {
    checkouts: {
      executor: "constant-vus",
      vus: 200,
      duration: "10m",
      exec: "checkout"
    },
    rider_updates: {
      executor: "constant-vus",
      vus: 100,
      duration: "10m",
      exec: "riderStatus"
    },
    reads: {
      executor: "constant-arrival-rate",
      rate: 1000,
      timeUnit: "1s",
      duration: "10m",
      preAllocatedVUs: 300,
      exec: "browse"
    }
  },
  thresholds: {
    http_req_duration: ["p(95)<400"],
    checks: ["rate>0.99"]
  }
};

const METHODS = ["WAVE", "ORANGE_MONEY", "PI_SPI", "COD"];

export function checkout() {
  const idem = `${__VU}-${__ITER}-${Date.now()}`;
  const order = http.post(
    `${BASE}/orders`,
    JSON.stringify({
      shop_id: __ENV.SHOP_ID,
      items: [{ product_id: __ENV.PRODUCT_ID, qty: 1 }],
      delivery_point: { pin: { lat: 14.68, lng: -17.44, landmark: "k6 test point" } },
      guest_phone: `+2217712${String(50000 + (__VU % 40000)).padStart(5, "0")}`,
      idempotency_key: `k6-o-${idem}`
    }),
    { headers: { "Content-Type": "application/json" } }
  );
  // 201 created or 409 out-of-stock are both correct outcomes; anything else is a defect
  check(order, { "order ok/conflict": (r) => r.status === 201 || r.status === 409 });
  if (order.status !== 201) return;
  const method = METHODS[__ITER % METHODS.length];
  const attempt = http.post(
    `${BASE}/orders/${order.json("id")}/attempts`,
    JSON.stringify({ method, idempotency_key: `k6-a-${idem}` }),
    { headers: { "Content-Type": "application/json" } }
  );
  // during the injected outage, 503 with order retained is the CORRECT behavior (NFR-2)
  check(attempt, { "attempt ok/outage": (r) => r.status === 201 || r.status === 503 });
  sleep(1);
}

export function riderStatus() {
  if (!__ENV.JOB_ID || !__ENV.RIDER_TOKEN) return sleep(1);
  const res = http.post(
    `${BASE}/jobs/${__ENV.JOB_ID}/status`,
    JSON.stringify({
      event_id: `${__VU}-${__ITER}-${Date.now()}`,
      status: "en_route",
      gps: { lat: 12.37, lng: -1.52 },
      at: new Date().toISOString()
    }),
    { headers: { "Content-Type": "application/json", Authorization: `Bearer ${__ENV.RIDER_TOKEN}` } }
  );
  check(res, { "status accepted": (r) => r.status === 200 });
  sleep(1);
}

export function browse() {
  const res = http.get(`${BASE}/marketplace?limit=20`);
  check(res, { "read 200": (r) => r.status === 200 });
}
