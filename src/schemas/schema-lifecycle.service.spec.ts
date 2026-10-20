import { BadRequestException } from "@nestjs/common";
import { ProofType, SchemaLifecycleStatus } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { SchemaLifecycleService } from "./schema-lifecycle.service";

describe("SchemaLifecycleService", () => {
  let service: SchemaLifecycleService;
  let prisma: {
    protocolSchema: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      protocolSchema: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    service = new SchemaLifecycleService(prisma as unknown as PrismaService);
  });

  describe("registerSchema", () => {
    it("should register new schema without predecessor", async () => {
      prisma.protocolSchema.findUnique.mockResolvedValue(null);
      prisma.protocolSchema.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: "ps-1",
          ...data,
          activatedAt: new Date(),
          deprecatedAt: null,
          sunsetAt: null,
          predecessor: null,
        }),
      );

      const result = await service.registerSchema({
        schemaId: "earnproof.income.v1",
        version: "1.0.0",
        proofType: ProofType.MINIMUM_INCOME,
        definition: { type: "object" },
        configVersion: "v1.2",
        network: "testnet",
      });

      expect(result.schemaId).toBe("earnproof.income.v1");
      expect(result.status).toBe(SchemaLifecycleStatus.ACTIVE);
      expect(result.canIssue).toBe(true);
    });

    it("should reject self-referential lineage cycles", async () => {
      prisma.protocolSchema.findUnique.mockResolvedValue(null);

      await expect(
        service.registerSchema({
          schemaId: "earnproof.income.v1",
          version: "1.0.0",
          proofType: ProofType.MINIMUM_INCOME,
          predecessorSchemaId: "earnproof.income.v1",
          definition: {},
          configVersion: "v1",
          network: "testnet",
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("evaluatePreflight", () => {
    it("should allow issuance for active, compatible schema within payload limits", async () => {
      prisma.protocolSchema.findUnique.mockResolvedValue({
        id: "ps-1",
        schemaId: "earnproof.income.v1",
        status: SchemaLifecycleStatus.ACTIVE,
        contractCompatible: true,
        maxPayloadBytes: 1024,
      });

      const result = await service.evaluatePreflight("earnproof.income.v1", 500);
      expect(result.canIssue).toBe(true);
      expect(result.compatible).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it("should reject issuance for deprecated schema (fail closed)", async () => {
      prisma.protocolSchema.findUnique.mockResolvedValue({
        id: "ps-1",
        schemaId: "earnproof.income.v1",
        status: SchemaLifecycleStatus.DEPRECATED,
        contractCompatible: true,
        maxPayloadBytes: 1024,
      });

      const result = await service.evaluatePreflight("earnproof.income.v1");
      expect(result.canIssue).toBe(false);
      expect(result.reasons).toContain("SCHEMA_DEPRECATED");
    });

    it("should reject issuance if payload limit is exceeded", async () => {
      prisma.protocolSchema.findUnique.mockResolvedValue({
        id: "ps-1",
        schemaId: "earnproof.income.v1",
        status: SchemaLifecycleStatus.ACTIVE,
        contractCompatible: true,
        maxPayloadBytes: 1000,
      });

      const result = await service.evaluatePreflight("earnproof.income.v1", 2000);
      expect(result.canIssue).toBe(false);
      expect(result.reasons.some((r) => r.includes("PAYLOAD_LIMIT_EXCEEDED"))).toBe(true);
    });

    it("should reject unknown schema (fail closed)", async () => {
      prisma.protocolSchema.findUnique.mockResolvedValue(null);

      const result = await service.evaluatePreflight("unknown.schema");
      expect(result.canIssue).toBe(false);
      expect(result.compatible).toBe(false);
      expect(result.reasons).toContain("SCHEMA_UNKNOWN");
    });
  });
});
