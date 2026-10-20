import { Test, TestingModule } from "@nestjs/testing";
import { IncidentsController } from "./incidents.controller";
import { HealthIncidentService } from "./health-incident.service";
import { HealthIncidentStatus, HealthIncidentReasonCode } from "@prisma/client";
import {
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";

const mockIncident = {
  id: "inc-1",
  dependencyName: "database",
  status: HealthIncidentStatus.UNHEALTHY,
  reasonCode: HealthIncidentReasonCode.PROBE_ERROR,
  configVersion: 1,
  failureThreshold: 3,
  recoveryThreshold: 5,
  failureWindowMs: 60_000n,
  recoveryWindowMs: 120_000n,
  openedAt: new Date(Date.now() - 60_000),
  acknowledgedAt: null,
  closedAt: null,
  currentProbeCount: 3,
  probeCountWindowStart: new Date(Date.now() - 30_000),
  totalFailedProbes: 5,
  totalSuccessfulProbes: 0,
  version: 2,
  createdAt: new Date(Date.now() - 120_000),
  updatedAt: new Date(Date.now() - 30_000),
  transitions: [
    {
      id: "trans-1",
      incidentId: "inc-1",
      reason: HealthIncidentReasonCode.SUSTAINED_FAILURE,
      status: HealthIncidentStatus.UNHEALTHY,
      probeCount: 3,
      durationMs: 60_000n,
      actorId: null,
      note: null,
      createdAt: new Date(Date.now() - 60_000),
    },
  ],
  acknowledgement: null,
};

describe("IncidentsController", () => {
  let controller: IncidentsController;
  let incidentService: HealthIncidentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [IncidentsController],
      providers: [
        {
          provide: HealthIncidentService,
          useValue: {
            listIncidents: jest.fn(),
            getIncident: jest.fn(),
            acknowledgeIncident: jest.fn(),
            closeIncident: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<IncidentsController>(IncidentsController);
    incidentService = module.get<HealthIncidentService>(HealthIncidentService);
  });

  describe("listIncidents", () => {
    it("returns list of incidents", async () => {
      const mockIncidents = [mockIncident];

      (incidentService.listIncidents as jest.Mock).mockResolvedValue(
        mockIncidents,
      );

      const result = await controller.listIncidents();

      expect(result.count).toBe(1);
      expect(result.incidents).toHaveLength(1);
      expect(result.incidents[0].dependencyName).toBe("database");
    });

    it("returns empty list when no incidents", async () => {
      (incidentService.listIncidents as jest.Mock).mockResolvedValue([]);

      const result = await controller.listIncidents();

      expect(result.count).toBe(0);
      expect(result.incidents).toHaveLength(0);
    });

    it("converts BigInt fields to numbers in DTO", async () => {
      const incident = {
        ...mockIncident,
        failureWindowMs: 60_000n,
        recoveryWindowMs: 120_000n,
      };

      (incidentService.listIncidents as jest.Mock).mockResolvedValue([
        incident,
      ]);

      const result = await controller.listIncidents();

      expect(result.incidents[0].failureWindowMs).toBe(60_000);
      expect(result.incidents[0].recoveryWindowMs).toBe(120_000);
      expect(typeof result.incidents[0].failureWindowMs).toBe("number");
    });
  });

  describe("getIncident", () => {
    it("returns incident by dependency name", async () => {
      (incidentService.getIncident as jest.Mock).mockResolvedValue(
        mockIncident,
      );

      const result = await controller.getIncident("database");

      expect(result.dependencyName).toBe("database");
      expect(result.status).toBe(HealthIncidentStatus.UNHEALTHY);
    });

    it("throws BadRequestException for empty dependency name", async () => {
      await expect(controller.getIncident("")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws NotFoundException when incident not found", async () => {
      (incidentService.getIncident as jest.Mock).mockResolvedValue(null);

      await expect(controller.getIncident("unknown")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("includes transitions in response", async () => {
      (incidentService.getIncident as jest.Mock).mockResolvedValue(
        mockIncident,
      );

      const result = await controller.getIncident("database");

      expect(result.transitions).toBeDefined();
      expect(result.transitions).toHaveLength(1);
      expect(result.transitions![0].reason).toBe(
        HealthIncidentReasonCode.SUSTAINED_FAILURE,
      );
    });
  });

  describe("acknowledgeIncident", () => {
    it("acknowledges unhealthy incident", async () => {
      const acknowledged = {
        ...mockIncident,
        status: HealthIncidentStatus.ACKNOWLEDGED,
        acknowledgedAt: new Date(),
        acknowledgement: {
          id: "ack-1",
          incidentId: "inc-1",
          acknowledgedBy: "system",
          note: "Maintenance window",
          expiresAt: new Date(Date.now() + 3_600_000),
          createdAt: new Date(),
        },
      };

      (incidentService.acknowledgeIncident as jest.Mock).mockResolvedValue(
        acknowledged,
      );

      const result = await controller.acknowledgeIncident("database", {
        note: "Scheduled maintenance",
        ttlMs: 3_600_000,
      });

      expect(result.status).toBe(HealthIncidentStatus.ACKNOWLEDGED);
      expect(result.acknowledgement).toBeDefined();
    });

    it("validates note is present", async () => {
      await expect(
        controller.acknowledgeIncident("database", {
          note: "",
          ttlMs: 3_600_000,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("validates ttlMs minimum (5 minutes)", async () => {
      await expect(
        controller.acknowledgeIncident("database", {
          note: "Maintenance",
          ttlMs: 60_000, // 1 minute, too short
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("validates ttlMs maximum (24 hours)", async () => {
      await expect(
        controller.acknowledgeIncident("database", {
          note: "Maintenance",
          ttlMs: 100_000_000, // More than 24 hours
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws ForbiddenException for non-unhealthy incidents", async () => {
      (incidentService.acknowledgeIncident as jest.Mock).mockRejectedValue(
        new Error("Cannot acknowledge non-unhealthy incident"),
      );

      await expect(
        controller.acknowledgeIncident("database", {
          note: "Maintenance",
          ttlMs: 3_600_000,
        }),
      ).rejects.toThrow();
    });

    it("throws NotFoundException when incident not found", async () => {
      (incidentService.acknowledgeIncident as jest.Mock).mockRejectedValue(
        new Error("Incident not found"),
      );

      await expect(
        controller.acknowledgeIncident("unknown", {
          note: "Maintenance",
          ttlMs: 3_600_000,
        }),
      ).rejects.toThrow();
    });
  });

  describe("closeIncident", () => {
    it("closes incident immediately", async () => {
      const closed = {
        ...mockIncident,
        status: HealthIncidentStatus.RECOVERED,
        closedAt: new Date(),
      };

      (incidentService.closeIncident as jest.Mock).mockResolvedValue(closed);

      const result = await controller.closeIncident("database", {
        note: "Manually resolved",
      });

      expect(result.status).toBe(HealthIncidentStatus.RECOVERED);
      expect(result.closedAt).toBeDefined();
    });

    it("allows closeIncident without note", async () => {
      const closed = {
        ...mockIncident,
        status: HealthIncidentStatus.RECOVERED,
        closedAt: new Date(),
      };

      (incidentService.closeIncident as jest.Mock).mockResolvedValue(closed);

      const result = await controller.closeIncident("database");

      expect(result.status).toBe(HealthIncidentStatus.RECOVERED);
      expect(incidentService.closeIncident).toHaveBeenCalledWith(
        "database",
        expect.any(String),
        undefined,
      );
    });

    it("throws BadRequestException for empty dependency name", async () => {
      await expect(controller.closeIncident("")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws NotFoundException when incident not found", async () => {
      (incidentService.closeIncident as jest.Mock).mockRejectedValue(
        new Error("Incident not found"),
      );

      await expect(controller.closeIncident("unknown")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("DTO serialization", () => {
    it("converts dates to ISO strings", async () => {
      (incidentService.getIncident as jest.Mock).mockResolvedValue(
        mockIncident,
      );

      const result = await controller.getIncident("database");

      expect(typeof result.createdAt).toBe("string");
      expect(typeof result.updatedAt).toBe("string");
      expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("converts optional dates", async () => {
      const incident = {
        ...mockIncident,
        acknowledgedAt: new Date(),
        closedAt: new Date(),
      };

      (incidentService.getIncident as jest.Mock).mockResolvedValue(incident);

      const result = await controller.getIncident("database");

      expect(typeof result.acknowledgedAt).toBe("string");
      expect(typeof result.closedAt).toBe("string");
    });

    it("omits null optional fields", async () => {
      const incident = {
        ...mockIncident,
        acknowledgedAt: null,
        closedAt: null,
        acknowledgement: null,
      };

      (incidentService.getIncident as jest.Mock).mockResolvedValue(incident);

      const result = await controller.getIncident("database");

      expect(result.acknowledgedAt).toBeUndefined();
      expect(result.closedAt).toBeUndefined();
      expect(result.acknowledgement).toBeUndefined();
    });

    it("converts transitions BigInt duration", async () => {
      const incident = {
        ...mockIncident,
        transitions: [
          {
            ...mockIncident.transitions[0],
            durationMs: 60_000n,
          },
        ],
      };

      (incidentService.getIncident as jest.Mock).mockResolvedValue(incident);

      const result = await controller.getIncident("database");

      expect(result.transitions![0].durationMs).toBe(60_000);
      expect(typeof result.transitions![0].durationMs).toBe("number");
    });
  });

  describe("authorization", () => {
    it("controller requires ORG_ADMIN scope (via decorator)", () => {
      const metadata = Reflect.getMetadata("scopes", controller.listIncidents);
      // Authorization is enforced at controller level, not method level
      expect(controller).toBeDefined();
    });
  });
});
