import { BadRequestException, ConflictException } from "@nestjs/common";
import { SchemaImportStatus } from "@prisma/client";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../database/prisma.service";
import { SchemaImportsService } from "./schema-imports.service";

describe("SchemaImportsService", () => {
  let service: SchemaImportsService;
  let prisma: {
    schemaImportJob: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    schemaImportRow: { createMany: jest.Mock; findMany: jest.Mock };
    schemaDefinition: { findUnique: jest.Mock; upsert: jest.Mock };
    auditLog: { create: jest.Mock };
    $transaction: jest.Mock;
  };

  const user = { id: "user-1", walletAddress: "G1", walletHash: "h1", role: "WORKER" };

  function job(overrides: Record<string, unknown> = {}) {
    return {
      id: "job-1",
      organizationId: "org-1",
      status: SchemaImportStatus.UPLOADED,
      rowCount: 1,
      uploadedById: user.id,
      canonicalHash: null,
      conflictCount: 0,
      errorCount: 0,
      approvedById: null,
      approvedAt: null,
      appliedAt: null,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchemaImportsService,
        {
          provide: PrismaService,
          useValue: {
            schemaImportJob: {
              create: jest.fn(),
              findUnique: jest.fn(),
              update: jest.fn(),
              updateMany: jest.fn(),
            },
            schemaImportRow: { createMany: jest.fn(), findMany: jest.fn() },
            schemaDefinition: { findUnique: jest.fn(), upsert: jest.fn() },
            auditLog: { create: jest.fn() },
            $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
          },
        },
      ],
    }).compile();

    service = module.get(SchemaImportsService);
    prisma = module.get(PrismaService) as unknown as typeof prisma;
  });

  describe("uploadAndDryRun — bounds and zero-mutation", () => {
    it("rejects an empty row set", async () => {
      await expect(
        service.uploadAndDryRun(user, "org-1", { rows: [] }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.schemaImportJob.create).not.toHaveBeenCalled();
    });

    it("never writes to schemaDefinition during dry-run", async () => {
      prisma.schemaImportJob.create.mockResolvedValue(job({ status: SchemaImportStatus.DRY_RUN_RUNNING }));
      prisma.schemaDefinition.findUnique.mockResolvedValue(null);
      prisma.schemaImportJob.update.mockResolvedValue(
        job({ status: SchemaImportStatus.DRY_RUN_COMPLETE, canonicalHash: "x" }),
      );

      await service.uploadAndDryRun(user, "org-1", {
        rows: [{ schemaKey: "proof.minimum_income", version: "1", definition: { a: 1 } }],
      });

      expect(prisma.schemaDefinition.upsert).not.toHaveBeenCalled();
    });

    it("flags malformed rows with errors and excludes them from conflicts", async () => {
      prisma.schemaImportJob.create.mockResolvedValue(job());
      prisma.schemaImportJob.update.mockImplementation((args) =>
        Promise.resolve(job(args.data)),
      );

      const result = await service.uploadAndDryRun(user, "org-1", {
        rows: [{ schemaKey: "", version: "1", definition: {} }],
      });

      expect(result.errorCount).toBe(1);
      const rowsWritten = prisma.schemaImportRow.createMany.mock.calls[0][0].data;
      expect(rowsWritten[0].errors).toBeDefined();
    });

    it("flags duplicate schemaKey/version within the same batch as conflicts", async () => {
      prisma.schemaImportJob.create.mockResolvedValue(job({ rowCount: 2 }));
      prisma.schemaDefinition.findUnique.mockResolvedValue(null);
      prisma.schemaImportJob.update.mockImplementation((args) =>
        Promise.resolve(job(args.data)),
      );

      const result = await service.uploadAndDryRun(user, "org-1", {
        rows: [
          { schemaKey: "proof.minimum_income", version: "1", definition: { a: 1 } },
          { schemaKey: "proof.minimum_income", version: "1", definition: { a: 2 } },
        ],
      });

      expect(result.conflictCount).toBe(1);
    });

    it("flags a row that would silently overwrite existing content with different data", async () => {
      prisma.schemaImportJob.create.mockResolvedValue(job());
      prisma.schemaDefinition.findUnique.mockResolvedValue({
        schemaKey: "proof.minimum_income",
        version: "1",
        definition: { a: "old" },
      });
      prisma.schemaImportJob.update.mockImplementation((args) =>
        Promise.resolve(job(args.data)),
      );

      const result = await service.uploadAndDryRun(user, "org-1", {
        rows: [{ schemaKey: "proof.minimum_income", version: "1", definition: { a: "new" } }],
      });

      expect(result.conflictCount).toBe(1);
    });

    it("produces a deterministic canonicalHash for the same input", async () => {
      prisma.schemaImportJob.create.mockResolvedValue(job());
      prisma.schemaDefinition.findUnique.mockResolvedValue(null);

      let capturedHashA: string | undefined;
      let capturedHashB: string | undefined;

      prisma.schemaImportJob.update.mockImplementationOnce((args) => {
        capturedHashA = args.data.canonicalHash;
        return Promise.resolve(job(args.data));
      });

      await service.uploadAndDryRun(user, "org-1", {
        rows: [{ schemaKey: "k", version: "1", definition: { a: 1 } }],
      });

      prisma.schemaImportJob.update.mockImplementationOnce((args) => {
        capturedHashB = args.data.canonicalHash;
        return Promise.resolve(job(args.data));
      });

      await service.uploadAndDryRun(user, "org-1", {
        rows: [{ schemaKey: "k", version: "1", definition: { a: 1 } }],
      });

      expect(capturedHashA).toBe(capturedHashB);
    });
  });

  describe("approve", () => {
    it("rejects a hash that does not match the job's canonicalHash", async () => {
      prisma.schemaImportJob.findUnique.mockResolvedValue(
        job({ status: SchemaImportStatus.DRY_RUN_COMPLETE, canonicalHash: "real-hash" }),
      );

      await expect(
        service.approve(user, "job-1", { reviewedHash: "wrong-hash" }),
      ).rejects.toThrow(ConflictException);
    });

    it("rejects approval of a job that is not DRY_RUN_COMPLETE", async () => {
      prisma.schemaImportJob.findUnique.mockResolvedValue(
        job({ status: SchemaImportStatus.UPLOADED }),
      );

      await expect(
        service.approve(user, "job-1", { reviewedHash: "anything" }),
      ).rejects.toThrow(ConflictException);
    });

    it("approves when the hash matches exactly", async () => {
      prisma.schemaImportJob.findUnique
        .mockResolvedValueOnce(
          job({ status: SchemaImportStatus.DRY_RUN_COMPLETE, canonicalHash: "real-hash" }),
        )
        .mockResolvedValueOnce(
          job({ status: SchemaImportStatus.APPROVED, canonicalHash: "real-hash" }),
        );

      const result = await service.approve(user, "job-1", { reviewedHash: "real-hash" });
      expect(result.status).toBe(SchemaImportStatus.APPROVED);
    });
  });

  describe("apply — hash pinning and concurrency", () => {
    it("refuses to apply a different result than was reviewed", async () => {
      prisma.schemaImportJob.findUnique.mockResolvedValue(
        job({ status: SchemaImportStatus.APPROVED, canonicalHash: "real-hash" }),
      );

      await expect(
        service.apply(user, "job-1", { reviewedHash: "different-hash" }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.schemaImportJob.updateMany).not.toHaveBeenCalled();
    });

    it("lets only one concurrent apply call claim the APPROVED -> APPLYING transition", async () => {
      prisma.schemaImportJob.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      prisma.schemaImportRow.findMany.mockResolvedValue([]);
      prisma.schemaImportJob.update.mockResolvedValue(
        job({ status: SchemaImportStatus.APPLIED, canonicalHash: "real-hash" }),
      );

      // First caller: sees APPROVED, claims the APPLYING transition, applies.
      prisma.schemaImportJob.findUnique.mockResolvedValueOnce(
        job({ status: SchemaImportStatus.APPROVED, canonicalHash: "real-hash" }),
      );

      const first = await service.apply(user, "job-1", { reviewedHash: "real-hash" });
      expect(first.status).toBe(SchemaImportStatus.APPLIED);

      // Second (concurrent/retry) caller: now sees it already APPLIED, so its
      // own APPROVED -> APPLYING claim misses (count 0); the follow-up lookup
      // confirms APPLIED, making this a no-op rather than an error.
      prisma.schemaImportJob.findUnique
        .mockResolvedValueOnce(
          job({ status: SchemaImportStatus.APPLIED, canonicalHash: "real-hash" }),
        )
        .mockResolvedValueOnce(
          job({ status: SchemaImportStatus.APPLIED, canonicalHash: "real-hash" }),
        );

      const second = await service.apply(user, "job-1", { reviewedHash: "real-hash" });
      expect(second.status).toBe(SchemaImportStatus.APPLIED);
    });

    it("only applies non-conflicting, error-free rows", async () => {
      prisma.schemaImportJob.findUnique.mockResolvedValue(
        job({ status: SchemaImportStatus.APPROVED, canonicalHash: "real-hash" }),
      );
      prisma.schemaImportJob.updateMany.mockResolvedValue({ count: 1 });
      prisma.schemaImportRow.findMany.mockResolvedValue([
        {
          schemaKey: "k",
          version: "1",
          definition: { a: 1 },
          conflict: false,
          errors: null,
        },
      ]);
      prisma.schemaDefinition.upsert.mockResolvedValue({});
      prisma.schemaImportJob.update.mockResolvedValue(
        job({ status: SchemaImportStatus.APPLIED }),
      );

      await service.apply(user, "job-1", { reviewedHash: "real-hash" });

      expect(prisma.schemaDefinition.upsert).toHaveBeenCalledTimes(1);
    });

    it("marks the job FAILED and rethrows if the apply transaction throws", async () => {
      prisma.schemaImportJob.findUnique.mockResolvedValue(
        job({ status: SchemaImportStatus.APPROVED, canonicalHash: "real-hash" }),
      );
      prisma.schemaImportJob.updateMany.mockResolvedValue({ count: 1 });
      prisma.schemaImportRow.findMany.mockRejectedValue(new Error("db exploded"));

      await expect(
        service.apply(user, "job-1", { reviewedHash: "real-hash" }),
      ).rejects.toThrow("db exploded");

      expect(prisma.schemaImportJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: SchemaImportStatus.FAILED }),
        }),
      );
    });
  });
});
