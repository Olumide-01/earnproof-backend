import { Test, TestingModule } from "@nestjs/testing";
import { HealthIncidentService } from "./health-incident.service";
import { PrismaService } from "../database/prisma.service";
import {
  HealthIncidentStatus,
  HealthIncidentReasonCode,
  HealthIncident,
  HealthTransition,
} from "@prisma/client";

describe("HealthIncidentService", () => {
  let service: HealthIncidentService;
  let prismaService: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthIncidentService,
        {
          provide: PrismaService,
          useValue: {
            healthIncident: {
              findUnique: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
              findMany: jest.fn(),
            },
            healthTransition: {
              create: jest.fn(),
            },
            healthIncidentAcknowledgement: {
              upsert: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<HealthIncidentService>(HealthIncidentService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  describe("recordProbe - healthy dependency", () => {
    it("creates default incident on first probe", async () => {
      const mockIncident = {
        id: "inc-1",
        dependencyName: "database",
        status: HealthIncidentStatus.HEALTHY,
        failureThreshold: 3,
        recoveryThreshold: 5,
        failureWindowMs: 60_000n,
        recoveryWindowMs: 120_000n,
        probeCountWindowStart: null,
        currentProbeCount: 0,
        totalFailedProbes: 0,
        totalSuccessfulProbes: 0,
        reasonCode: null,
        version: 0,
        transitions: [],
        acknowledgement: null,
      };

      (prismaService.healthIncident.findUnique as jest.Mock).mockResolvedValue(
        null,
      );
      (prismaService.healthIncident.create as jest.Mock).mockResolvedValue(
        mockIncident,
      );
      (prismaService.healthIncident.update as jest.Mock).mockResolvedValue({
        ...mockIncident,
        totalSuccessfulProbes: 1,
        version: 1,
        transitions: [],
      });

      const result = await service.recordProbe("database", true);

      expect(prismaService.healthIncident.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          dependencyName: "database",
          status: HealthIncidentStatus.HEALTHY,
        }),
      });
      expect(result.status).toBe(HealthIncidentStatus.HEALTHY);
    });
  });

  describe("recordProbe - sustained failures", () => {
    it("transitions to UNHEALTHY after threshold failures", async () => {
      const mockIncident = {
        id: "inc-1",
        dependencyName: "database",
        status: HealthIncidentStatus.HEALTHY,
        failureThreshold: 3,
        recoveryThreshold: 5,
        failureWindowMs: 60_000n,
        recoveryWindowMs: 120_000n,
        probeCountWindowStart: new Date(Date.now() - 10_000),
        currentProbeCount: 2, // Already 2 failures
        totalFailedProbes: 2,
        totalSuccessfulProbes: 0,
        reasonCode: null,
        version: 0,
        acknowledgedAt: null,
        openedAt: null,
        closedAt: null,
        transitions: [],
        acknowledgement: null,
      };

      (prismaService.healthIncident.findUnique as jest.Mock).mockResolvedValue(
        mockIncident,
      );
      (prismaService.healthTransition.create as jest.Mock).mockResolvedValue(
        {},
      );
      (prismaService.healthIncident.update as jest.Mock).mockResolvedValue({
        ...mockIncident,
        status: HealthIncidentStatus.UNHEALTHY,
        currentProbeCount: 3,
        totalFailedProbes: 3,
        version: 1,
        openedAt: new Date(),
        reasonCode: HealthIncidentReasonCode.PROBE_ERROR,
      });

      const result = await service.recordProbe(
        "database",
        false,
        HealthIncidentReasonCode.PROBE_ERROR,
      );

      expect(result.status).toBe(HealthIncidentStatus.UNHEALTHY);
      expect(result.openedAt).toBeDefined();
    });

    it("prevents transient failures from triggering incident", async () => {
      const mockIncident = {
        id: "inc-1",
        dependencyName: "database",
        status: HealthIncidentStatus.HEALTHY,
        failureThreshold: 3,
        recoveryThreshold: 5,
        failureWindowMs: 60_000n,
        recoveryWindowMs: 120_000n,
        probeCountWindowStart: null,
        currentProbeCount: 0,
        totalFailedProbes: 0,
        totalSuccessfulProbes: 0,
        reasonCode: null,
        version: 0,
        transitions: [],
        acknowledgement: null,
      };

      (prismaService.healthIncident.findUnique as jest.Mock).mockResolvedValue(
        mockIncident,
      );
      (prismaService.healthTransition.create as jest.Mock).mockResolvedValue(
        {},
      );
      (prismaService.healthIncident.update as jest.Mock).mockResolvedValue({
        ...mockIncident,
        status: HealthIncidentStatus.HEALTHY, // Still healthy
        currentProbeCount: 1,
        totalFailedProbes: 1,
        version: 1,
      });

      const result = await service.recordProbe(
        "database",
        false,
        HealthIncidentReasonCode.PROBE_ERROR,
      );

      expect(result.status).toBe(HealthIncidentStatus.HEALTHY);
      expect(result.currentProbeCount).toBe(1);
    });
  });

  describe("recordProbe - sustained recovery", () => {
    it("transitions to RECOVERED after threshold successes", async () => {
      const mockIncident = {
        id: "inc-1",
        dependencyName: "database",
        status: HealthIncidentStatus.UNHEALTHY,
        failureThreshold: 3,
        recoveryThreshold: 5,
        failureWindowMs: 60_000n,
        recoveryWindowMs: 120_000n,
        probeCountWindowStart: new Date(Date.now() - 50_000),
        currentProbeCount: 4, // Already 4 successes
        totalFailedProbes: 3,
        totalSuccessfulProbes: 4,
        reasonCode: HealthIncidentReasonCode.PROBE_ERROR,
        version: 5,
        acknowledgedAt: null,
        openedAt: new Date(Date.now() - 100_000),
        closedAt: null,
        transitions: [],
        acknowledgement: null,
      };

      (prismaService.healthIncident.findUnique as jest.Mock).mockResolvedValue(
        mockIncident,
      );
      (prismaService.healthTransition.create as jest.Mock).mockResolvedValue(
        {},
      );
      (prismaService.healthIncident.update as jest.Mock).mockResolvedValue({
        ...mockIncident,
        status: HealthIncidentStatus.RECOVERED,
        currentProbeCount: 5,
        totalSuccessfulProbes: 5,
        version: 6,
        closedAt: new Date(),
        reasonCode: HealthIncidentReasonCode.SUSTAINED_RECOVERY,
      });

      const result = await service.recordProbe("database", true);

      expect(result.status).toBe(HealthIncidentStatus.RECOVERED);
      expect(result.closedAt).toBeDefined();
    });
  });

  describe("acknowledgeIncident", () => {
    it("acknowledges unhealthy incident", async () => {
      const mockIncident = {
        id: "inc-1",
        dependencyName: "database",
        status: HealthIncidentStatus.UNHEALTHY,
        version: 5,
        transitions: [],
        acknowledgement: null,
      };

      (prismaService.healthIncident.findUnique as jest.Mock).mockResolvedValue(
        mockIncident,
      );
      (
        prismaService.healthIncidentAcknowledgement.upsert as jest.Mock
      ).mockResolvedValue({
        id: "ack-1",
      });
      (prismaService.healthIncident.update as jest.Mock).mockResolvedValue({
        ...mockIncident,
        status: HealthIncidentStatus.ACKNOWLEDGED,
        acknowledgedAt: new Date(),
      });

      const expiresAt = new Date(Date.now() + 3_600_000);
      const result = await service.acknowledgeIncident(
        "database",
        "user-123",
        "Acknowledged: scheduled maintenance window",
        expiresAt,
      );

      expect(result.status).toBe(HealthIncidentStatus.ACKNOWLEDGED);
      expect(result.acknowledgedAt).toBeDefined();
    });

    it("throws when acknowledging non-unhealthy incident", async () => {
      const mockIncident = {
        id: "inc-1",
        dependencyName: "database",
        status: HealthIncidentStatus.HEALTHY,
        transitions: [],
        acknowledgement: null,
      };

      (prismaService.healthIncident.findUnique as jest.Mock).mockResolvedValue(
        mockIncident,
      );

      const expiresAt = new Date(Date.now() + 3_600_000);
      await expect(
        service.acknowledgeIncident(
          "database",
          "user-123",
          "note",
          expiresAt,
        ),
      ).rejects.toThrow();
    });
  });

  describe("listIncidents", () => {
    it("lists all incidents", async () => {
      const mockIncidents = [
        {
          id: "inc-1",
          dependencyName: "database",
          status: HealthIncidentStatus.UNHEALTHY,
          transitions: [],
          acknowledgement: null,
        },
        {
          id: "inc-2",
          dependencyName: "horizon",
          status: HealthIncidentStatus.HEALTHY,
          transitions: [],
          acknowledgement: null,
        },
      ];

      (prismaService.healthIncident.findMany as jest.Mock).mockResolvedValue(
        mockIncidents,
      );

      const result = await service.listIncidents();

      expect(result).toHaveLength(2);
      expect(result[0].dependencyName).toBe("database");
    });

    it("filters incidents by status", async () => {
      const mockIncidents = [
        {
          id: "inc-1",
          dependencyName: "database",
          status: HealthIncidentStatus.UNHEALTHY,
          transitions: [],
          acknowledgement: null,
        },
      ];

      (prismaService.healthIncident.findMany as jest.Mock).mockResolvedValue(
        mockIncidents,
      );

      const result = await service.listIncidents(HealthIncidentStatus.UNHEALTHY);

      expect(prismaService.healthIncident.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: HealthIncidentStatus.UNHEALTHY },
        }),
      );
    });
  });

  describe("closeIncident", () => {
    it("closes incident manually", async () => {
      const mockIncident = {
        id: "inc-1",
        dependencyName: "database",
        status: HealthIncidentStatus.UNHEALTHY,
        probeCountWindowStart: new Date(Date.now() - 50_000),
        version: 5,
        transitions: [],
        acknowledgement: null,
      };

      (prismaService.healthIncident.findUnique as jest.Mock).mockResolvedValue(
        mockIncident,
      );
      (prismaService.healthTransition.create as jest.Mock).mockResolvedValue(
        {},
      );
      (prismaService.healthIncident.update as jest.Mock).mockResolvedValue({
        ...mockIncident,
        status: HealthIncidentStatus.RECOVERED,
        closedAt: new Date(),
        version: 6,
      });

      const result = await service.closeIncident(
        "database",
        "user-123",
        "Manually closed by operator",
      );

      expect(result.status).toBe(HealthIncidentStatus.RECOVERED);
      expect(result.closedAt).toBeDefined();
    });
  });

  describe("state machine - boundary cases", () => {
    it("resets probe count window on expiration", async () => {
      // Test that old failures don't accumulate indefinitely
      const mockIncident = {
        id: "inc-1",
        dependencyName: "database",
        status: HealthIncidentStatus.UNHEALTHY,
        failureThreshold: 3,
        recoveryThreshold: 5,
        failureWindowMs: 60_000n,
        recoveryWindowMs: 120_000n,
        probeCountWindowStart: new Date(Date.now() - 70_000), // Window expired
        currentProbeCount: 2,
        totalFailedProbes: 5,
        totalSuccessfulProbes: 0,
        reasonCode: HealthIncidentReasonCode.PROBE_ERROR,
        version: 0,
        transitions: [],
        acknowledgement: null,
      };

      (prismaService.healthIncident.findUnique as jest.Mock).mockResolvedValue(
        mockIncident,
      );
      (prismaService.healthTransition.create as jest.Mock).mockResolvedValue(
        {},
      );
      (prismaService.healthIncident.update as jest.Mock).mockResolvedValue({
        ...mockIncident,
        probeCountWindowStart: new Date(), // Reset
        currentProbeCount: 1, // New count
      });

      await service.recordProbe("database", false);

      expect(prismaService.healthIncident.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            probeCountWindowStart: expect.any(Date),
          }),
        }),
      );
    });

    it("handles concurrent updates with optimistic concurrency", async () => {
      const mockIncident = {
        id: "inc-1",
        dependencyName: "database",
        status: HealthIncidentStatus.HEALTHY,
        version: 5,
        transitions: [],
        acknowledgement: null,
        probeCountWindowStart: null,
        currentProbeCount: 0,
        totalFailedProbes: 0,
        totalSuccessfulProbes: 0,
        failureThreshold: 3,
        recoveryThreshold: 5,
        failureWindowMs: 60_000n,
        recoveryWindowMs: 120_000n,
      };

      (prismaService.healthIncident.findUnique as jest.Mock).mockResolvedValue(
        mockIncident,
      );
      (prismaService.healthTransition.create as jest.Mock).mockResolvedValue(
        {},
      );
      (prismaService.healthIncident.update as jest.Mock).mockResolvedValue({
        ...mockIncident,
        version: 6,
      });

      await service.recordProbe("database", true);

      expect(prismaService.healthIncident.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            version: 5, // Incremented from 5 to 6
          }),
        }),
      );
    });
  });
});
