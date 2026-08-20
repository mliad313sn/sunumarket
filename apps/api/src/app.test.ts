import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("api bootstrap", () => {
  it("serves /health", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    await app.close();
  });
});
