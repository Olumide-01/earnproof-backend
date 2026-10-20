import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../database/prisma.service";
import {
  AuditAdminService,
  MAX_EXPORT_RANGE_DAYS,
  MAX_EXPORT_RECORDS,
} from "./audit-admin.service";

describe("AuditAdminService", () => {
  let service: AuditAdminService;
  let findMany: jest.Mock;
  let findFirst: jest.Mock;

  const baseRow = {
    id: "log-1",
    actorType: "USER",
    actorId: "user-1",
    action: "DID_THING",
    resourceType: "Resource",
    resourceId: "res-1",
    metadata: { a: 1 },
    organizationId: "org-1",
    sequence: BigInt(1),
    hashVersion: 1,
    prevHash: null,
    hash: "hash-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  beforeEach(async () => {
    findMany = jest.fn();
    findFirst = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditAdminService,
        {
          provide: PrismaService,
          useValue: { auditLog: { findMany, findFirst } },
        },
      ],
    }).compile();

    service = module.get(AuditAdminService);
  });

  describe("list", () => {
    it("returns a page scoped to organizationId (positive)", async () => {
      findMany.mockResolvedValue([baseRow]);

      const result = await service.list({
        organizationId: "org-1",
        limit: 20,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].sequence).toBe("1");
      expect(result.pageInfo.hasMore).toBe(false);
      expect(findMany.mock.calls[0][0].where.organizationId).toBe("org-1");
    });

    it("reports hasMore and a nextCursor when more records exist than the page limit", async () => {
      findMany.mockResolvedValue([
        { ...baseRow, id: "log-1" },
        { ...baseRow, id: "log-2" },
      ]);

      const result = await service.list({ organizationId: "org-1", limit: 1 });

      expect(result.pageInfo.hasMore).toBe(true);
      expect(result.pageInfo.nextCursor).toBe("log-1");
      expect(result.data).toHaveLength(1);
    });

    it("rejects an invalid cursor for the given organization (negative)", async () => {
      findFirst.mockResolvedValue(null);

      await expect(
        service.list({
          organizationId: "org-1",
          cursor: "does-not-exist",
          limit: 20,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects createdFrom after createdTo (boundary)", async () => {
      await expect(
        service.list({
          organizationId: "org-1",
          limit: 20,
          createdFrom: "2026-02-01T00:00:00.000Z",
          createdTo: "2026-01-01T00:00:00.000Z",
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("export", () => {
    it("returns records within a bounded date range (positive)", async () => {
      findMany.mockResolvedValue([baseRow]);

      const result = await service.export({
        organizationId: "org-1",
        createdFrom: "2026-01-01T00:00:00.000Z",
        createdTo: "2026-01-31T00:00:00.000Z",
      });

      expect(result.records).toHaveLength(1);
      expect(result.truncated).toBe(false);
      expect(findMany.mock.calls[0][0].where.organizationId).toBe("org-1");
    });

    it("rejects a date range wider than MAX_EXPORT_RANGE_DAYS (boundary)", async () => {
      const from = new Date("2026-01-01T00:00:00.000Z");
      const to = new Date(
        from.getTime() + (MAX_EXPORT_RANGE_DAYS + 1) * 24 * 60 * 60 * 1000,
      );

      await expect(
        service.export({
          organizationId: "org-1",
          createdFrom: from.toISOString(),
          createdTo: to.toISOString(),
        }),
      ).rejects.toThrow(BadRequestException);

      expect(findMany).not.toHaveBeenCalled();
    });

    it("accepts a date range exactly at MAX_EXPORT_RANGE_DAYS (boundary)", async () => {
      const from = new Date("2026-01-01T00:00:00.000Z");
      const to = new Date(
        from.getTime() + MAX_EXPORT_RANGE_DAYS * 24 * 60 * 60 * 1000,
      );
      findMany.mockResolvedValue([]);

      await expect(
        service.export({
          organizationId: "org-1",
          createdFrom: from.toISOString(),
          createdTo: to.toISOString(),
        }),
      ).resolves.toBeDefined();
    });

    it("rejects createdFrom after createdTo (negative)", async () => {
      await expect(
        service.export({
          organizationId: "org-1",
          createdFrom: "2026-02-01T00:00:00.000Z",
          createdTo: "2026-01-01T00:00:00.000Z",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("flags truncation and caps output at MAX_EXPORT_RECORDS when the range matches more rows (safety-net boundary)", async () => {
      const rows = Array.from({ length: MAX_EXPORT_RECORDS + 1 }, (_, i) => ({
        ...baseRow,
        id: `log-${i}`,
        sequence: BigInt(i + 1),
      }));
      findMany.mockResolvedValue(rows);

      const result = await service.export({
        organizationId: "org-1",
        createdFrom: "2026-01-01T00:00:00.000Z",
        createdTo: "2026-01-31T00:00:00.000Z",
      });

      expect(result.truncated).toBe(true);
      expect(result.records).toHaveLength(MAX_EXPORT_RECORDS);
    });
  });
});
