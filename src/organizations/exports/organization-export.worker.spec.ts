import { ConfigService } from "@nestjs/config";
import {
  OrganizationExportCategory,
  OrganizationExportStatus,
} from "@prisma/client";
import { randomBytes } from "crypto";
import { PrismaService } from "../../database/prisma.service";
import { decryptArchive } from "./export-archive-crypto";
import { ExportArtifactStore } from "./export-artifact-store";
import { OrganizationExportWorkerService } from "./organization-export.worker";

const KEY_HEX = randomBytes(32).toString("hex");

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

function makeConfig(withKey = true) {
  return {
    get: jest.fn((key: string) =>
      key === "organizations.export.encryptionKey" && withKey
        ? KEY_HEX
        : undefined,
    ),
  } as unknown as ConfigService;
}

/**
 * Prisma double covering the worker's claim query, the collectors, and the
 * completion writes. `claimIds` and `completeCount` are the two knobs the tests
 * turn to script a happy build, a cancellation race, and a collection failure.
 */
function makePrisma(options: {
  job?: any;
  claimIds?: string[];
  completeCount?: number;
  expiring?: any[];
  collectThrows?: boolean;
}) {
  const auditCreate = jest.fn().mockResolvedValue({});
  const jobUpdate = jest.fn().mockResolvedValue({});
  const jobUpdateMany = jest
    .fn()
    .mockResolvedValue({ count: options.completeCount ?? 1 });

  const prisma = {
    organizationExportJob: {
      findMany: jest.fn().mockResolvedValue(options.expiring ?? []),
      findUnique: jest.fn().mockResolvedValue(options.job ?? null),
      update: jobUpdate,
      updateMany: jobUpdateMany,
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ id: "org_1", name: "Acme" }),
    },
    issuer: {
      findMany: options.collectThrows
        ? jest.fn().mockRejectedValue(new Error("db down"))
        : jest.fn().mockResolvedValue([{ id: "iss_1" }]),
    },
    apiKey: { findMany: jest.fn().mockResolvedValue([]) },
    webhook: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: auditCreate },
    $queryRaw: jest
      .fn()
      .mockResolvedValue((options.claimIds ?? []).map((id) => ({ id }))),
  } as unknown as PrismaService;

  return { prisma, auditCreate, jobUpdate, jobUpdateMany };
}

const RUNNING_JOB = {
  id: "job_1",
  organizationId: "org_1",
  status: OrganizationExportStatus.RUNNING,
  categories: [OrganizationExportCategory.ORGANIZATION_PROFILE],
};

describe("OrganizationExportWorkerService", () => {
  it("stays idle when no encryption key is configured", async () => {
    const { prisma } = makePrisma({ claimIds: ["job_1"] });
    const worker = new OrganizationExportWorkerService(
      prisma,
      makeConfig(false),
      new FakeStore(),
    );

    await worker.poll();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("builds, encrypts, completes, and audit-logs with a digest", async () => {
    const store = new FakeStore();
    const { prisma, auditCreate, jobUpdateMany } = makePrisma({
      job: RUNNING_JOB,
      claimIds: ["job_1"],
      completeCount: 1,
    });
    const worker = new OrganizationExportWorkerService(
      prisma,
      makeConfig(),
      store,
    );

    await worker.poll();

    // Completed with an artifact, digest, and size.
    const completeCall = jobUpdateMany.mock.calls.find(
      (call) => call[0].data.status === OrganizationExportStatus.COMPLETED,
    );
    expect(completeCall).toBeDefined();
    expect(completeCall![0].data.archiveDigest).toEqual(expect.any(String));
    expect(completeCall![0].data.sizeBytes).toBeGreaterThan(0);

    // The archive is real ciphertext that decrypts back to the collected data.
    const [location] = [...store.files.keys()];
    const plaintext = decryptArchive(
      store.files.get(location)!,
      Buffer.from(KEY_HEX, "hex"),
    );
    expect(JSON.parse(plaintext.toString()).organizationId).toBe("org_1");

    // Audit-logged with the digest.
    const audit = auditCreate.mock.calls.find(
      (call) => call[0].data.action === "EXPORT_COMPLETED",
    );
    expect(audit![0].data.metadata.digest).toBe(
      completeCall![0].data.archiveDigest,
    );
  });

  it("discards the artifact when the job was cancelled during generation", async () => {
    const store = new FakeStore();
    const { prisma } = makePrisma({
      job: RUNNING_JOB,
      claimIds: ["job_1"],
      completeCount: 0, // the RUNNING-guarded update matched nothing: cancelled
    });
    const worker = new OrganizationExportWorkerService(
      prisma,
      makeConfig(),
      store,
    );

    await worker.poll();

    // The just-written artifact is removed; nothing is left on disk.
    expect(store.removed).toHaveLength(1);
    expect(store.files.size).toBe(0);
  });

  it("marks the job FAILED with a bounded category on a collection error", async () => {
    const store = new FakeStore();
    const { prisma, jobUpdateMany, auditCreate } = makePrisma({
      job: {
        ...RUNNING_JOB,
        categories: [OrganizationExportCategory.ISSUERS],
      },
      claimIds: ["job_1"],
      collectThrows: true,
    });
    const worker = new OrganizationExportWorkerService(
      prisma,
      makeConfig(),
      store,
    );

    await worker.poll();

    const failCall = jobUpdateMany.mock.calls.find(
      (call) => call[0].data.status === OrganizationExportStatus.FAILED,
    );
    expect(failCall).toBeDefined();
    expect(failCall![0].data.errorCategory).toBe("unknown");
    expect(
      auditCreate.mock.calls.some(
        (call) => call[0].data.action === "EXPORT_FAILED",
      ),
    ).toBe(true);
  });

  it("expires stale jobs and removes their artifacts", async () => {
    const store = new FakeStore();
    store.files.set("mem://old", Buffer.from("x"));
    const { prisma, jobUpdate } = makePrisma({
      expiring: [{ id: "old", artifactPath: "mem://old" }],
      claimIds: [],
    });
    const worker = new OrganizationExportWorkerService(
      prisma,
      makeConfig(),
      store,
    );

    await worker.poll();

    expect(store.removed).toContain("mem://old");
    const expireCall = jobUpdate.mock.calls.find(
      (call) => call[0].data.status === OrganizationExportStatus.EXPIRED,
    );
    expect(expireCall).toBeDefined();
    expect(expireCall![0].data.artifactPath).toBeNull();
  });
});
