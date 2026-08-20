import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { Role } from "../src/modules/auth/rbac.js";

const url = process.env.DATABASE_URL;
const d = describe.skipIf(!url);

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});

function tokenFor(roles: Role[], tier = 0): string {
  return app.jwt.sign(
    { sub: "00000000-0000-4000-8000-00000000t3st".replace("t3st", "0042"), roles, tier, device: "rbac-test" },
    { expiresIn: "5m" }
  );
}

/** RBAC matrix (Phase 3 verify): 5 roles × representative protected routes. */
const MATRIX: Array<{
  route: { method: "GET" | "POST"; url: string };
  allowed: Role[];
}> = [
  { route: { method: "GET", url: "/admin/kyc/queue" }, allowed: ["admin"] },
  { route: { method: "GET", url: "/admin/fraud/queue" }, allowed: ["admin"] },
  { route: { method: "POST", url: "/auth/payout-pin" }, allowed: ["seller", "rider", "admin"] }
];

d("phase 3 — RBAC matrix", () => {
  it("anonymous requests are rejected on protected routes", async () => {
    for (const { route } of MATRIX) {
      const res = await app.inject({ method: route.method, url: route.url });
      expect(res.statusCode, route.url).toBe(401);
    }
  });

  const roles: Role[] = ["buyer", "seller", "rider", "partner", "admin"];
  for (const role of roles) {
    it(`role=${role} gets exactly its allowed routes`, async () => {
      for (const { route, allowed } of MATRIX) {
        const res = await app.inject({
          method: route.method,
          url: route.url,
          headers: { authorization: `Bearer ${tokenFor([role])}` },
          ...(route.method === "POST" ? { payload: { pin: "1234" } } : {})
        });
        if (allowed.includes(role)) {
          expect([200, 400, 404], `${role} ${route.url}`).not.toContain(403);
          expect(res.statusCode, `${role} ${route.url}`).not.toBe(403);
          expect(res.statusCode, `${role} ${route.url}`).not.toBe(401);
        } else {
          expect(res.statusCode, `${role} ${route.url}`).toBe(403);
        }
      }
    });
  }

  it("expired tokens are rejected", async () => {
    const expired = app.jwt.sign(
      { sub: "00000000-0000-4000-8000-000000000042", roles: ["admin"], tier: 2, device: "x" },
      { expiresIn: "-1s" }
    );
    const res = await app.inject({
      method: "GET",
      url: "/admin/kyc/queue",
      headers: { authorization: `Bearer ${expired}` }
    });
    expect(res.statusCode).toBe(401);
  });
});
