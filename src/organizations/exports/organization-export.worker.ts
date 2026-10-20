import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { OrganizationExportStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { categorizeJobError } from "../../jobs/execution/job-error-category";
import { JobExecutionService } from "../../jobs/execution/job-execution.service";
import { workerIdentity } from "../../jobs/execution/worker-identity";
import {
  decodeArchiveKey,
  encryptArchive,
} from "./export-archive-crypto";
import {
  EXPORT_ARTIFACT_STORE,
  ExportArtifactStore,
} from "./export-artifact-store";
import { collectExport, serializeExport } from "./export-collectors";

/**
 * Builds queued export archives out of band.
 *
 * The worker mirrors the anchoring worker's discipline, because the failure
 * modes are the same: it claims a bounded batch of jobs atomically (so two
 * replicas never build the same archive), does the slow work outside any HTTP
 * request, and drains cleanly on shutdown. On top of that it owns the
 * lifecycle's destructive edges — a job cancelled mid-build, or expired past its
 * retention window — has its temporary artifact removed rather than left on disk.
 */
@Injectable()
export class OrganizationExportWorkerService implements OnApplicationShutdown {
  private readonly logger = new Logger(OrganizationExportWorkerService.name);

  /** Jobs claimed per tick. Small: each job reads and encrypts a whole dataset. */
  private static readonly BATCH_SIZE = 3;

  private draining = false;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(EXPORT_ARTIFACT_STORE)
    private readonly artifacts: ExportArtifactStore,
    @Optional() private readonly executions?: JobExecutionService,
  ) {}

  @Interval(15_000)
  async poll(): Promise<void> {
    if (this.draining || !this.encryptionKey()) return;

    const cycle = this.runCycle();
    this.inFlight = cycle;
    try {
      await cycle;
    } finally {
      if (this.inFlight === cycle) this.inFlight = null;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.draining = true;
    if (this.inFlight) await this.inFlight.catch(() => undefined);
  }

  private async runCycle(): Promise<void> {
    if (this.executions) {
      await this.executions.track(
        {
          jobName: "organization-export-worker",
          jobVersion: "1",
          leaseOwner: workerIdentity(),
        },
        () => this.processBatchAndExpiry(),
      );
      return;
    }
    await this.processBatchAndExpiry();
  }

  private async processBatchAndExpiry(): Promise<void> {
    await this.expireStaleJobs();
    await this.processBatch();
  }

  /**
   * Marks jobs past their retention window EXPIRED and removes their artifacts.
   *
   * Runs every tick, ahead of claiming, so an expired-but-completed archive is
   * never handed out and its bytes do not linger. Cancelled and failed jobs are
   * left alone — their artifacts were already removed at the point of
   * cancellation or never written.
   */
  private async expireStaleJobs(): Promise<void> {
    const now = new Date();
    const expiring = await this.prisma.organizationExportJob.findMany({
      where: {
        expiresAt: { lt: now },
        status: {
          in: [
            OrganizationExportStatus.QUEUED,
            OrganizationExportStatus.RUNNING,
            OrganizationExportStatus.COMPLETED,
          ],
        },
      },
      select: { id: true, artifactPath: true },
      take: 50,
    });

    for (const job of expiring) {
      if (job.artifactPath) await this.artifacts.remove(job.artifactPath);
      await this.prisma.organizationExportJob.update({
        where: { id: job.id },
        data: {
          status: OrganizationExportStatus.EXPIRED,
          artifactPath: null,
          downloadTokenHash: null,
          downloadExpiresAt: null,
        },
      });
    }
  }

  private async processBatch(): Promise<void> {
    const now = new Date();

    // Atomically claim QUEUED jobs, transitioning each to RUNNING. FOR UPDATE
    // SKIP LOCKED is what keeps two workers from claiming the same job.
    const claimed = await this.prisma.$queryRaw<Array<{ id: string }>>`
      WITH candidates AS (
        SELECT id
        FROM "OrganizationExportJob"
        WHERE status = ${OrganizationExportStatus.QUEUED}::"OrganizationExportStatus"
        ORDER BY "requestedAt" ASC
        LIMIT ${OrganizationExportWorkerService.BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "OrganizationExportJob" AS job
      SET status = ${OrganizationExportStatus.RUNNING}::"OrganizationExportStatus",
          "startedAt" = ${now},
          "attemptCount" = job."attemptCount" + 1
      FROM candidates
      WHERE job.id = candidates.id
      RETURNING job.id
    `;

    for (const { id } of claimed) {
      await this.buildArchive(id);
    }
  }

  /**
   * Collects, encrypts, and stores one job's archive.
   *
   * The completion write is guarded on the job still being RUNNING: if it was
   * cancelled while the archive was being built, the guard fails, the freshly
   * written artifact is removed, and the job is left CANCELLED. That is what
   * makes "cancelled jobs remove temporary artifacts" hold even for the narrow
   * window where cancellation races generation.
   */
  private async buildArchive(jobId: string): Promise<void> {
    const job = await this.prisma.organizationExportJob.findUnique({
      where: { id: jobId },
    });
    if (!job || job.status !== OrganizationExportStatus.RUNNING) return;

    try {
      const collected = await collectExport(
        this.prisma,
        job.organizationId,
        job.categories,
      );
      const encrypted = encryptArchive(
        serializeExport(collected),
        this.encryptionKey()!,
      );
      const location = await this.artifacts.write(jobId, encrypted.content);

      // Only complete a job that is still RUNNING. If it was cancelled mid-build
      // the update touches no rows and the artifact just written is orphaned —
      // remove it.
      const completed = await this.prisma.organizationExportJob.updateMany({
        where: { id: jobId, status: OrganizationExportStatus.RUNNING },
        data: {
          status: OrganizationExportStatus.COMPLETED,
          artifactPath: location,
          archiveDigest: encrypted.digest,
          sizeBytes: encrypted.sizeBytes,
          completedAt: new Date(),
        },
      });

      if (completed.count === 0) {
        await this.artifacts.remove(location);
        this.logger.log(
          `Export ${jobId} was cancelled during generation; artifact discarded`,
        );
        return;
      }

      // Every export is audit-logged with its integrity digest.
      await this.audit("EXPORT_COMPLETED", job.organizationId, jobId, {
        digest: encrypted.digest,
        sizeBytes: encrypted.sizeBytes,
        categories: job.categories,
      });

      this.logger.log(
        `Export ${jobId} completed: ${encrypted.sizeBytes} bytes, digest ${encrypted.digest}`,
      );
    } catch (error) {
      await this.failJob(jobId, job.organizationId, error);
    }
  }

  private async failJob(
    jobId: string,
    organizationId: string,
    error: unknown,
  ): Promise<void> {
    const category = categorizeJobError(error);

    await this.prisma.organizationExportJob.updateMany({
      where: { id: jobId, status: OrganizationExportStatus.RUNNING },
      data: {
        status: OrganizationExportStatus.FAILED,
        errorCategory: category,
      },
    });

    await this.audit("EXPORT_FAILED", organizationId, jobId, {
      errorCategory: category,
    });

    // Category only — never the raw error, which could carry a connection
    // string or row data.
    this.logger.warn(`Export ${jobId} failed: ${category}`);
  }

  private audit(
    action: string,
    organizationId: string,
    exportId: string,
    metadata: Prisma.InputJsonValue,
  ) {
    return this.prisma.auditLog.create({
      data: {
        actorType: "System",
        action,
        resourceType: "OrganizationExportJob",
        resourceId: exportId,
        metadata: { organizationId, ...(metadata as object) },
      },
    });
  }

  private encryptionKey(): Buffer | undefined {
    const material = this.config.get<string>(
      "organizations.export.encryptionKey",
    );
    if (!material) return undefined;
    try {
      return decodeArchiveKey(material);
    } catch (error) {
      this.logger.error(
        `Export encryption key is misconfigured: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      return undefined;
    }
  }
}
