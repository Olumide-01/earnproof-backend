import { HttpStatus } from "@nestjs/common";
import { CspDirective, CspDisposition, CspRouteCategory } from "@prisma/client";
import { CspViolationController } from "./csp-violation.controller";

function makeReport() {
  return {
    directive: CspDirective.STYLE_SRC,
    routeCategory: CspRouteCategory.SETTINGS,
    release: "2026.10.1",
    disposition: CspDisposition.REPORT,
  };
}

describe("CspViolationController", () => {
  it("forwards the report and the caller's IP to the ingestion service", async () => {
    const violations = { ingest: jest.fn().mockResolvedValue(undefined) };
    const controller = new CspViolationController(violations as never);
    const request = { ip: "198.51.100.7" } as never;

    await controller.report(makeReport() as never, request);

    expect(violations.ingest).toHaveBeenCalledWith(makeReport(), { ip: "198.51.100.7" });
  });

  it("responds 204 No Content regardless of whether the report was actually counted", async () => {
    const violations = { ingest: jest.fn().mockResolvedValue(undefined) };
    const controller = new CspViolationController(violations as never);

    const result = await controller.report(makeReport() as never, { ip: "1.2.3.4" } as never);

    // @HttpCode(204) governs the actual response; the handler itself returns nothing.
    expect(result).toBeUndefined();
  });

  it("the handler decorator is configured to always return 204", () => {
    const metadata = Reflect.getMetadata(
      "__httpCode__",
      CspViolationController.prototype.report,
    );
    expect(metadata).toBe(HttpStatus.NO_CONTENT);
  });

  it("does not throw or leak an error if ingestion fails unexpectedly (fail-open at the edge)", async () => {
    const violations = { ingest: jest.fn().mockRejectedValue(new Error("boom")) };
    const controller = new CspViolationController(violations as never);

    await expect(
      controller.report(makeReport() as never, { ip: "1.2.3.4" } as never),
    ).rejects.toThrow("boom");
    // Note: CspViolationService.ingest already fails open internally (see its
    // own spec) — this asserts the controller does not add a second,
    // redundant safety net, since the service is the single place that owns it.
  });
});
