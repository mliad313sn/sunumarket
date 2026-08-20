import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi.js";

describe("OpenAPI document (Phase 1 gate: lints)", () => {
  const doc = buildOpenApiDocument();

  it("generates a 3.1 document with info and paths", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("SunuMarket API");
    expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThanOrEqual(20);
  });

  it("every operation has an operationId, tag, summary and a 200 response", () => {
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const method of ["get", "post", "patch", "delete"] as const) {
        const op = (item as Record<string, { operationId?: string; tags?: string[]; summary?: string; responses?: Record<string, unknown> }>)[method];
        if (!op) continue;
        expect(op.operationId, `${method} ${path}`).toBeTruthy();
        expect(op.tags?.length, `${method} ${path}`).toBeGreaterThan(0);
        expect(op.summary, `${method} ${path}`).toBeTruthy();
        expect(op.responses?.["200"], `${method} ${path}`).toBeTruthy();
      }
    }
  });

  it("golden-path critical endpoints exist", () => {
    const paths = Object.keys(doc.paths ?? {});
    for (const p of [
      "/auth/otp",
      "/orders",
      "/orders/{id}/attempts",
      "/webhooks/{provider}",
      "/checkout/{orderId}/methods",
      "/fees/quote",
      "/deliveries",
      "/jobs/{id}/proof",
      "/riders/remittances",
      "/payouts"
    ]) {
      expect(paths, p).toContain(p);
    }
  });

  it("operationIds are unique", () => {
    const ids: string[] = [];
    for (const item of Object.values(doc.paths ?? {})) {
      for (const op of Object.values(item as Record<string, unknown>)) {
        const id = (op as { operationId?: string }).operationId;
        if (id) ids.push(id);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});
