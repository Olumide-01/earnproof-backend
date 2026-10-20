import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  OrganizationExportCategory,
  OrganizationExportStatus,
} from "@prisma/client";
import { AuthenticatedUser } from "../../auth/auth.types";
import { OrganizationsService } from "../organizations.service";
import { PrismaService } from "../../database/prisma.service";
import { sha256 } from "../../common/crypto/hash";
import { ExportArtifactStore } from "./export-artifact-store";
import { OrganizationExportService } from "./organization-export.service";

const USER: AuthenticatedUser = {
  id: "user_1",
  walletAddress: "GABC",
  walletHash: "hash",
  role: "ADMIN",
};

/** In-memory artifact store; records removals so cleanup can be asserted. */
class FakeStore implements ExportArtifactStore {
  files = new Map<string, Buffer>();
  removed: string[] = [];
  async write(jobId: string, content: Buffer) {
    const location = `mem://${jobId}`;
    this.files.set(location, content);
    return location;
  }
  async read(location: string) {
    const found = this.files.get(location);
    if (!found) throw new Error("missing");
    return found;
  }
  async remove(location: string) {
    this.files.delete(location);
    this.removed.push(location);
  }
}

/** Minimal in-memory OrganizationExportJob delegate. */
class FakeJobs {
  rows: any[] = [];
  private seq = 0;

  create = jest.fn(async ({ data }: any) => {
    const row = {
      id: `job_${this.seq++}`,
      status: OrganizationExportStatus.QUEUED,
      attemptCount: 0,
      artifactPath: null,
      archiveDigest: null,
      sizeBytes: null,
      errorCategory: null,
      downloadTokenHash: null,
      downloadExpiresAt: null,
      requestedAt: new Date(),
      startedAt: null,
      completedAt: null,
      ...data,
    };
    this.rows.push(row);
    return row;
  });

  findFirst = jest.fn(async ({ where }: any) =>
    this.rows.find(
      (row) =>
        row.id === where.id && row.organizationId === where.organizationId,
    ) ?? null,
  );

  findUnique = jest.fn(async ({ where }: any) =>
    this.rows.find((row) =>
      where.id
        ? row.id === where.id
        : row.downloadTokenHash === where.downloadTokenHash,
    ) ?? null,
  );

  findMany = jest.fn(async ({ where }: any) =>
    this.rows.filter((row) => row.organizationId === where.organizationId),
  );

  update = jest.fn(async ({ where, data }: any) => {
    const row = this.rows.find((r) => r.id === where.id);
    Object.assign(row, data);
    return row;
  });
}

function build(overrides: { visible?: boolean } = {}) {
  const jobs = new FakeJobs();
  const prisma = {
    organizationExportJob: jobs,
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  } as unknown as PrismaService;

  const organizations = {
    getOrganization: jest.fn(async () => {
      if (overrides.visible === false) {
        throw new NotFoundException("Organization not found");
      }
      return {};
    }),
  } as unknown as OrganizationsService;

  const config = {
    get: jest.fn((key: string) =>
      key === "organizations.export.jobTtlHours"
        ? 24
        : key === "organizations.export.downloadTtlMinutes"
          ? 10
          : undefined,
    ),
  } as unknown as ConfigService;

  const store = new FakeStore();
  const service = new OrganizationExportService(
    prisma,
    organizations,
    config,
    store,
  );
  return { service, jobs, store, prisma, organizations };
}

describe("OrganizationExportService", () => {
  describe("authorization", () => {
    it("refuses to create an export for an organization the user cannot see", async () => {
      const { service, organizations } = build({ visible: false });
      await expect(
        service.createExport(USER, "org_x", [
          OrganizationExportCategory.ISSUERS,
        ]),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(organizations.getOrganization).toHaveBeenCalledWith(USER, "org_x");
    });

    it("scopes status lookups to the tenant (a foreign job is 404)", async () => {
      const { service, jobs } = build();
      jobs.rows.push({ id: "job_foreign", organizationId: "other_org" });
      await expect(
        service.getExport(USER, "org_1", "job_foreign"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("createExport", () => {
    it("rejects an empty category list", async () => {
      const { service } = build();
      await expect(
        service.createExport(USER, "org_1", []),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("queues a job and audit-logs the request", async () => {
      const { service, jobs, prisma } = build();
      const view = await service.createExport(USER, "org_1", [
        OrganizationExportCategory.ISSUERS,
      ]);

      expect(view.status).toBe(OrganizationExportStatus.QUEUED);
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0].expiresAt).toBeInstanceOf(Date);
      expect((prisma.auditLog.create as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: "EXPORT_REQUESTED" }),
        }),
      );
    });
  });

  describe("cancelExport", () => {
    it("cancels a running job and removes its artifact", async () => {
      const { service, jobs, store } = build();
      jobs.rows.push({
        id: "job_r",
        organizationId: "org_1",
        status: OrganizationExportStatus.COMPLETED,
        artifactPath: "mem://job_r",
        archiveDigest: "d1",
      });
      store.files.set("mem://job_r", Buffer.from("x"));

      const view = await service.cancelExport(USER, "org_1", "job_r");

      expect(view.status).toBe(OrganizationExportStatus.CANCELLED);
      expect(store.removed).toContain("mem://job_r");
      expect(jobs.rows[0].artifactPath).toBeNull();
    });

    it("conflicts when cancelling an already-terminal job", async () => {
      const { service, jobs } = build();
      jobs.rows.push({
        id: "job_e",
        organizationId: "org_1",
        status: OrganizationExportStatus.EXPIRED,
      });
      await expect(
        service.cancelExport(USER, "org_1", "job_e"),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("download handoff", () => {
    function completedJob(jobs: FakeJobs) {
      jobs.rows.push({
        id: "job_c",
        organizationId: "org_1",
        status: OrganizationExportStatus.COMPLETED,
        artifactPath: "mem://job_c",
        archiveDigest: "digest",
        downloadTokenHash: null,
        downloadExpiresAt: null,
      });
    }

    it("issues a single-use token whose hash alone is stored", async () => {
      const { service, jobs } = build();
      completedJob(jobs);

      const { token } = await service.issueDownload(USER, "org_1", "job_c");
      expect(jobs.rows[0].downloadTokenHash).toBe(sha256(token));
      // The raw token is never persisted.
      expect(jobs.rows[0].downloadTokenHash).not.toBe(token);
    });

    it("refuses to issue a download for a job that is not completed", async () => {
      const { service, jobs } = build();
      jobs.rows.push({
        id: "job_q",
        organizationId: "org_1",
        status: OrganizationExportStatus.QUEUED,
      });
      await expect(
        service.issueDownload(USER, "org_1", "job_q"),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("redeems a valid token once, then rejects replay", async () => {
      const { service, jobs, store } = build();
      completedJob(jobs);
      store.files.set("mem://job_c", Buffer.from("archive-bytes"));

      const { token } = await service.issueDownload(USER, "org_1", "job_c");
      const archive = await service.consumeDownload(token);
      expect(archive.content.toString()).toBe("archive-bytes");
      expect(archive.digest).toBe("digest");

      // Spent: the second redemption is an opaque 404.
      await expect(service.consumeDownload(token)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("rejects an expired token", async () => {
      const { service, jobs } = build();
      completedJob(jobs);
      jobs.rows[0].downloadTokenHash = sha256("tok");
      jobs.rows[0].downloadExpiresAt = new Date(Date.now() - 1);

      await expect(service.consumeDownload("tok")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("rejects an unknown token", async () => {
      const { service } = build();
      await expect(service.consumeDownload("nope")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
