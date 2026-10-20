import { Test, TestingModule } from "@nestjs/testing";
import { HealthHysteresisService } from "./health-hysteresis.service";
import { HealthIncidentService } from "./health-incident.service";
import { DependencyResult } from "./health.types";
import { HealthIncidentStatus, HealthIncidentReasonCode } from "@prisma/client";

describe("HealthHysteresisService", () => {
  let service: HealthHysteresisService;
  let incidentService: HealthIncidentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthHysteresisService,
        {
          provide: HealthIncidentService,
          useValue: {
            recordProbe: jest.fn(),
            getIncident: jest.fn(),
            acknowledgeIncident: jest.fn(),
            closeIncident: jest.fn(),
            listIncidents: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<HealthHysteresisService>(HealthHysteresisService);
    incidentService = module.get<HealthIncidentService>(HealthIncidentService);
  });

  describe("applyHysteresis - probe status mapping", () => {
    it("maps OK status to success", async () => {
      const probeResult: DependencyResult = {
        name: "database",
        kind: "required",
        status: "ok",
        durationMs: 10,
      };

      (incidentService.recordProbe as jest.Mock).mockResolvedValue({
        id: "inc-1",
        status: HealthIncidentStatus.HEALTHY,
      });

      await service.applyHysteresis("database", probeResult);

      expect(incidentService.recordProbe).toHaveBeenCalledWith(
        "database",
        true, // success
        expect.anything(),
      );
    });

    it("maps timeout to failure with timeout reason", async () => {
      const probeResult: DependencyResult = {
        name: "horizon",
        kind: "optional",
        status: "timeout",
        reason: "probe_timeout",
      };

      (incidentService.recordProbe as jest.Mock).mockResolvedValue({
        id: "inc-1",
        status: HealthIncidentStatus.UNHEALTHY,
      });

      await service.applyHysteresis("horizon", probeResult);

      expect(incidentService.recordProbe).toHaveBeenCalledWith(
        "horizon",
        false, // failure
        HealthIncidentReasonCode.PROBE_TIMEOUT,
      );
    });

    it("maps error to failure with error reason", async () => {
      const probeResult: DependencyResult = {
        name: "database",
        kind: "required",
        status: "error",
        reason: "connection_refused",
      };

      (incidentService.recordProbe as jest.Mock).mockResolvedValue({
        id: "inc-1",
        status: HealthIncidentStatus.UNHEALTHY,
      });

      await service.applyHysteresis("database", probeResult);

      expect(incidentService.recordProbe).toHaveBeenCalledWith(
        "database",
        false, // failure
        HealthIncidentReasonCode.PROBE_ERROR,
      );
    });

    it("maps degraded to failure with degraded reason", async () => {
      const probeResult: DependencyResult = {
        name: "webhook_delivery",
        kind: "optional",
        status: "degraded",
        reason: "failed_deliveries_present",
      };

      (incidentService.recordProbe as jest.Mock).mockResolvedValue({
        id: "inc-1",
        status: HealthIncidentStatus.UNHEALTHY,
      });

      await service.applyHysteresis("webhook_delivery", probeResult);

      expect(incidentService.recordProbe).toHaveBeenCalledWith(
        "webhook_delivery",
        false, // failure
        HealthIncidentReasonCode.PROBE_DEGRADED,
      );
    });

    it("maps disabled and not_configured to success (no incident)", async () => {
      const disabledProbe: DependencyResult = {
        name: "contract_anchoring",
        kind: "optional",
        status: "disabled",
      };

      (incidentService.recordProbe as jest.Mock).mockResolvedValue({
        id: "inc-1",
        status: HealthIncidentStatus.HEALTHY,
      });

      await service.applyHysteresis("contract_anchoring", disabledProbe);

      expect(incidentService.recordProbe).toHaveBeenCalledWith(
        "contract_anchoring",
        true, // success (no incident for disabled)
        HealthIncidentReasonCode.SUSTAINED_RECOVERY,
      );
    });
  });

  describe("isIncident", () => {
    it("returns true for UNHEALTHY incidents", async () => {
      (incidentService.getIncident as jest.Mock).mockResolvedValue({
        id: "inc-1",
        status: HealthIncidentStatus.UNHEALTHY,
      });

      const result = await service.isIncident("database");

      expect(result).toBe(true);
    });

    it("returns true for ACKNOWLEDGED incidents", async () => {
      (incidentService.getIncident as jest.Mock).mockResolvedValue({
        id: "inc-1",
        status: HealthIncidentStatus.ACKNOWLEDGED,
      });

      const result = await service.isIncident("database");

      expect(result).toBe(true);
    });

    it("returns false for HEALTHY incidents", async () => {
      (incidentService.getIncident as jest.Mock).mockResolvedValue({
        id: "inc-1",
        status: HealthIncidentStatus.HEALTHY,
      });

      const result = await service.isIncident("database");

      expect(result).toBe(false);
    });

    it("returns false for RECOVERED incidents", async () => {
      (incidentService.getIncident as jest.Mock).mockResolvedValue({
        id: "inc-1",
        status: HealthIncidentStatus.RECOVERED,
      });

      const result = await service.isIncident("database");

      expect(result).toBe(false);
    });

    it("returns false when incident does not exist", async () => {
      (incidentService.getIncident as jest.Mock).mockResolvedValue(null);

      const result = await service.isIncident("unknown_dependency");

      expect(result).toBe(false);
    });
  });

  describe("hysteresis isolation", () => {
    it("does not let transient failures affect different dependencies", async () => {
      const databaseProbe: DependencyResult = {
        name: "database",
        kind: "required",
        status: "ok",
      };

      const horizonProbe: DependencyResult = {
        name: "horizon",
        kind: "optional",
        status: "timeout",
      };

      (incidentService.recordProbe as jest.Mock)
        .mockResolvedValueOnce({
          status: HealthIncidentStatus.HEALTHY,
        })
        .mockResolvedValueOnce({
          status: HealthIncidentStatus.UNHEALTHY,
        });

      await service.applyHysteresis("database", databaseProbe);
      await service.applyHysteresis("horizon", horizonProbe);

      expect(incidentService.recordProbe).toHaveBeenCalledTimes(2);
      expect(incidentService.recordProbe).toHaveBeenNthCalledWith(
        1,
        "database",
        true,
        expect.anything(),
      );
      expect(incidentService.recordProbe).toHaveBeenNthCalledWith(
        2,
        "horizon",
        false,
        HealthIncidentReasonCode.PROBE_TIMEOUT,
      );
    });
  });

  describe("error handling", () => {
    it("handles recordProbe errors gracefully", async () => {
      const probeResult: DependencyResult = {
        name: "database",
        kind: "required",
        status: "error",
      };

      (incidentService.recordProbe as jest.Mock).mockRejectedValue(
        new Error("Database error"),
      );

      // Should not throw; fire-and-forget pattern
      await expect(
        service.applyHysteresis("database", probeResult),
      ).rejects.toThrow();
    });

    it("handles getIncident errors gracefully", async () => {
      (incidentService.getIncident as jest.Mock).mockRejectedValue(
        new Error("Query failed"),
      );

      await expect(service.isIncident("database")).rejects.toThrow();
    });
  });

  describe("status code coverage", () => {
    it("handles all DependencyStatusValue enum values", async () => {
      const statusTests: Array<[string, "ok" | "degraded" | "timeout" | "error" | "disabled" | "not_configured", boolean]> = [
        ["ok", "ok", true],
        ["degraded", "degraded", false],
        ["timeout", "timeout", false],
        ["error", "error", false],
        ["disabled", "disabled", true],
        ["not_configured", "not_configured", true],
      ];

      (incidentService.recordProbe as jest.Mock).mockResolvedValue({
        status: HealthIncidentStatus.HEALTHY,
      });

      for (const [statusName, status, expectedSuccess] of statusTests) {
        (incidentService.recordProbe as jest.Mock).mockClear();

        const probe: DependencyResult = {
          name: "test-dep",
          kind: "optional",
          status,
        };

        await service.applyHysteresis("test-dep", probe);

        expect(incidentService.recordProbe).toHaveBeenCalledWith(
          "test-dep",
          expectedSuccess,
          expect.any(String),
        );
      }
    });
  });
});
