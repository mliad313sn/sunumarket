import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "@sunumarket/api/src/app.js";

// E2E scaffold (Playbook Phase 0). Golden-path suites land per phase and run
// against the composed stack; this smoke proves the harness boots the real app.
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
  await app.listen({ port: 0 });
});

afterAll(async () => {
  await app.close();
});

describe("smoke", () => {
  it("API answers /health over real HTTP", async () => {
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const res = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});
