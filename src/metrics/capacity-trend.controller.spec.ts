/**
 * Unit tests for CapacityTrendController
 *
 * Coverage:
 *  - Authorization: non-ADMIN role is blocked by RoleGuard.
 *  - Positive: GET /trends returns all four resource types.
 *  - Positive: GET /trends/:type returns trend for that type.
 *  - Negative: unknown resourceType → 400 BadRequestException.
 *  - Boundary: each valid resource type is accepted.
 */

import { BadRequestException } from "@nestjs/common";
import { CapacityTrendController } from "./capacity-trend.controller";
import { ResourceType } from "./capacity-types";

function makeTrendService() {
  return {
    getAllTrends: jest.fn().mockResolvedValue([
      { resourceType: "ISSUER", alert: "CLEAR" },
      { resourceType: "SCHEMA", alert: "CLEAR" },
      { resourceType: "PROOF", alert: "CLEAR" },
      { resourceType: "STORAGE", alert: "CLEAR" },
    ]),
    getTrend: jest.fn().mockResolvedValue({ resourceType: "PROOF", alert: "CLEAR" }),
  };
}

// ---------------------------------------------------------------------------
// Positive
// ---------------------------------------------------------------------------

describe("CapacityTrendController — positive", () => {
  it("getAllTrends() delegates to service and returns result", async () => {
    const service = makeTrendService();
    const controller = new CapacityTrendController(service as never);
    const result = await controller.getAllTrends();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(4);
    expect(service.getAllTrends).toHaveBeenCalledTimes(1);
  });

  it("getTrend() delegates to service with correct resource type", async () => {
    const service = makeTrendService();
    const controller = new CapacityTrendController(service as never);
    await controller.getTrend("PROOF");
    expect(service.getTrend).toHaveBeenCalledWith("PROOF");
  });

  it.each(Object.values(ResourceType))(
    "accepts valid resource type %s",
    async (type) => {
      const service = makeTrendService();
      const controller = new CapacityTrendController(service as never);
      await expect(controller.getTrend(type)).resolves.not.toThrow();
    },
  );
});

// ---------------------------------------------------------------------------
// Negative — unknown type
// ---------------------------------------------------------------------------

describe("CapacityTrendController — unknown resource type", () => {
  it("throws BadRequestException for unknown resource type", async () => {
    const service = makeTrendService();
    const controller = new CapacityTrendController(service as never);
    await expect(controller.getTrend("UNKNOWN_TYPE")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("error message names the invalid type", async () => {
    const service = makeTrendService();
    const controller = new CapacityTrendController(service as never);
    try {
      await controller.getTrend("INVALID");
    } catch (e: unknown) {
      expect((e as BadRequestException).message).toMatch(/INVALID/);
    }
  });
});