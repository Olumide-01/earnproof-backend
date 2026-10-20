import * as request from "supertest";
import { integrationDatabase } from "../integration/harness/database";
import { e2eApp } from "./harness/app";

/**
 * CSP violation report ingestion over real HTTP (#336).
 *
 * The endpoint is intentionally unauthenticated (a reporting browser has no
 * session or API key) — this exercises that through the real guard pipeline
 * rather than by reading the controller source, and confirms the real
 * `ValidationPipe` (whitelist + forbidNonWhitelisted, configured once in
 * `src/bootstrap.ts`) rejects an unlisted property such as a raw URL at the
 * HTTP boundary, not only in the isolated DTO spec.
 */

const db = integrationDatabase();
const e2e = e2eApp();

function validBody() {
  return {
    directive: "SCRIPT_SRC",
    routeCategory: "DASHBOARD",
    release: "2026.10.1",
    disposition: "ENFORCE",
  };
}

describe("POST /api/v1/security/csp-reports", () => {
  it("authorization: accepts a well-formed report with no credentials at all", async () => {
    const res = await request(e2e.httpServer)
      .post("/api/v1/security/csp-reports")
      .send(validBody());

    expect(res.status).toBe(204);
  });

  it("positive: a well-formed report is persisted as an aggregate row", async () => {
    await request(e2e.httpServer)
      .post("/api/v1/security/csp-reports")
      .send(validBody());

    const row = await db.prisma.cspViolationSummary.findFirst({
      where: {
        directive: "SCRIPT_SRC",
        routeCategory: "DASHBOARD",
        release: "2026.10.1",
        disposition: "ENFORCE",
      },
    });
    expect(row).not.toBeNull();
    expect(row?.count).toBeGreaterThanOrEqual(1n);
  });

  it("negative: rejects an unknown directive value", async () => {
    const res = await request(e2e.httpServer)
      .post("/api/v1/security/csp-reports")
      .send({ ...validBody(), directive: "eval()" });

    expect(res.status).toBe(422);
  });

  it("regression: rejects a raw document-uri/blocked-uri rather than silently accepting and discarding it", async () => {
    const res = await request(e2e.httpServer)
      .post("/api/v1/security/csp-reports")
      .send({
        ...validBody(),
        "document-uri": "https://example.com/dashboard?token=secret-session-id",
        "blocked-uri": "https://evil.example/payload.js",
      });

    expect(res.status).toBe(422);
  });

  it("boundary: rejects a body larger than the route's tightened size limit", async () => {
    const res = await request(e2e.httpServer)
      .post("/api/v1/security/csp-reports")
      .send({ ...validBody(), release: "v" + "1".repeat(4000) });

    expect([413, 422]).toContain(res.status);
  });
});
