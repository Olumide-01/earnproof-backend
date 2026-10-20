import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ReportCspViolationDto } from "./report-csp-violation.dto";

function valid() {
  return {
    directive: "SCRIPT_SRC",
    routeCategory: "DASHBOARD",
    release: "2026.10.1",
    disposition: "ENFORCE",
  };
}

async function validateDto(body: Record<string, unknown>) {
  const dto = plainToInstance(ReportCspViolationDto, body);
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

describe("ReportCspViolationDto", () => {
  it("positive: accepts a well-formed report", async () => {
    expect(await validateDto(valid())).toHaveLength(0);
  });

  it("negative: rejects an unknown directive value", async () => {
    const errors = await validateDto({ ...valid(), directive: "eval()" });
    expect(errors.some((e) => e.property === "directive")).toBe(true);
  });

  it("negative: rejects an unknown route category", async () => {
    const errors = await validateDto({ ...valid(), routeCategory: "/dashboard/secret-id" });
    expect(errors.some((e) => e.property === "routeCategory")).toBe(true);
  });

  it("negative: rejects an unknown disposition", async () => {
    const errors = await validateDto({ ...valid(), disposition: "block" });
    expect(errors.some((e) => e.property === "disposition")).toBe(true);
  });

  it("boundary: rejects a release string longer than the field limit", async () => {
    const errors = await validateDto({ ...valid(), release: "v" + "1".repeat(64) });
    expect(errors.some((e) => e.property === "release")).toBe(true);
  });

  it("boundary: accepts a release string exactly at the field limit", async () => {
    const release = "v" + "1".repeat(63); // 64 chars total
    const errors = await validateDto({ ...valid(), release });
    expect(errors).toHaveLength(0);
  });

  it("negative: rejects a release value that is not the bounded version format", async () => {
    const errors = await validateDto({ ...valid(), release: "../../etc/passwd" });
    expect(errors.some((e) => e.property === "release")).toBe(true);
  });

  it("abuse resistance: never accepts a raw URL, even if the caller tries to smuggle one through an allowed field", async () => {
    const errors = await validateDto({
      ...valid(),
      release: "https://example.com/?token=secret",
    });
    expect(errors.some((e) => e.property === "release")).toBe(true);
  });

  it("regression: rejects an unlisted property (document-uri, blocked-uri, etc.) rather than silently dropping it", async () => {
    const errors = await validateDto({
      ...valid(),
      "document-uri": "https://example.com/dashboard?token=secret",
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("regression: a report with every CSP directive value validates", async () => {
    const directives = [
      "DEFAULT_SRC", "SCRIPT_SRC", "STYLE_SRC", "IMG_SRC", "CONNECT_SRC",
      "FONT_SRC", "FRAME_SRC", "OBJECT_SRC", "MEDIA_SRC", "WORKER_SRC",
      "MANIFEST_SRC", "BASE_URI", "FORM_ACTION", "FRAME_ANCESTORS",
      "UPGRADE_INSECURE_REQUESTS", "OTHER",
    ];
    for (const directive of directives) {
      const errors = await validateDto({ ...valid(), directive });
      expect(errors).toHaveLength(0);
    }
  });
});
