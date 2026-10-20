import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  OrganizationExportCategory,
  OrganizationExportStatus,
  Prisma,
} from "@prisma/client";
import { randomBytes } from "crypto";
import { sha256 } from "../../common/crypto/hash";
import { PrismaService } from "../../database/prisma.service";
import { AuthenticatedUser } from "../../auth/auth.types";
import { OrganizationsService } from "../organizations.service";
import {
  EXPORT_ARTIFACT_STORE,
  ExportArtifactStore,
} from "./export-artifact-store";
import { SecretRetrievalReceiptService } from "../../audit/secret-retrieval-receipt.service";
import { SecretType, DeliveryChannel } from "../../audit/types/secret-retrieval-receipt.types";

/**
 * Orchestrates asynchronous organization data exports.
 *
 * This is the request/response half: it authorizes, creates, reports, cancels,
 * and hands off exports. The heavy lifting — collecting data and writing the
 * encrypted archive — happens out of band in {@link OrganizationExportWorkerService},
 * because an export can be large and holding an HTTP request open while it is
 * built is exactly the failure mode the job model exists to avoid.
 *
 * Every mutating operation is authorized against the tenant *and* audit-logged.
 * Authorization reuses {@link OrganizationsService.getOrganization}, so an export
 * is visible to precisely the users the organization itself is — there is no
 * second, weaker access rule for exports to drift out of sync.
 */
@Injectable()
export class OrganizationExportService {
  private readonly logger = new Logger(OrganizationExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
    private readonly config: ConfigService,
    @Inject(EXPORT_ARTIFACT_STORE)
    private readonly artifacts: ExportArtifactStore,
    private readonly secretRetrievalReceiptService: SecretRetrievalReceiptService,
  ) {}

  /**
   * Creates a scoped export job.
   *
   * The caller must be able to see the organization (enforced by
   * `getOrganization`, which 404s otherwise) and must name at least one valid
   * data category. The job is created QUEUED; the worker picks it up. Its
   * `expiresAt` is set from retention config now, so the whole lifecycle —
   * including cleanup of an abandoned job — is bounded from the moment it is
   * created.
   */
  async createExport(
    user: AuthenticatedUser,
    organizationId: string,
    categories: OrganizationExportCategory[],
  ): Promise<ExportStatusView> {
    await this.organizations.getOrganization(user, organizationId);

    const requested = this.validateCategories(categories);
    const expiresAt = new Date(Date.now() + this.jobTtlMs());

    const job = await this.prisma.organizationExportJob.create({
      data: {
        organizationId,
        requestedById: user.id,
        categories: requested,
        status: OrganizationExportStatus.QUEUED,
        expiresAt,
      },
    });

    await this.audit(user, "EXPORT_REQUESTED", organizationId, job.id, {
      categories: requested,
    });

    return this.toStatusView(job);
  }

  /** Reports a job's status, tenant-scoped. */
  async getExport(
    user: AuthenticatedUser,
    organizationId: string,
    exportId: string,
  ): Promise<ExportStatusView> {
    await this.organizations.getOrganization(user, organizationId);
    return this.toStatusView(await this.requireJob(organizationId, exportId));
  }

  /** Lists an organization's export jobs, newest first, bounded. */
  async listExports(
    user: AuthenticatedUser,
    organizationId: string,
  ): Promise<ExportStatusView[]> {
    await this.organizations.getOrganization(user, organizationId);

    const jobs = await this.prisma.organizationExportJob.findMany({
      where: { organizationId },
      orderBy: { requestedAt: "desc" },
      take: 50,
    });

    return jobs.map((job) => this.toStatusView(job));
  }

  /**
   * Cancels a job and removes any temporary artifact it produced.
   *
   * Only a non-terminal job can be cancelled; cancelling a finished job is a
   * conflict, not a silent no-op, so a caller is never misled into thinking it
   * stopped work that had already completed. A completed job's artifact is
   * removed here too — cancellation is also the operator's "delete this export
   * now" lever.
   */
  async cancelExport(
    user: AuthenticatedUser,
    organizationId: string,
    exportId: string,
  ): Promise<ExportStatusView> {
    await this.organizations.getOrganization(user, organizationId);
    const job = await this.requireJob(organizationId, exportId);

    if (
      job.status === OrganizationExportStatus.CANCELLED ||
      job.status === OrganizationExportStatus.EXPIRED ||
      job.status === OrganizationExportStatus.FAILED
    ) {
      throw new ConflictException(
        `Export ${exportId} is already ${job.status.toLowerCase()}`,
      );
    }

    if (job.artifactPath) {
      await this.artifacts.remove(job.artifactPath);
    }

    const updated = await this.prisma.organizationExportJob.update({
      where: { id: exportId },
      data: {
        status: OrganizationExportStatus.CANCELLED,
        artifactPath: null,
        downloadTokenHash: null,
        downloadExpiresAt: null,
      },
    });

    await this.audit(user, "EXPORT_CANCELLED", organizationId, exportId, {
      digest: job.archiveDigest ?? null,
    });

    return this.toStatusView(updated);
  }

  /**
   * Issues a short-lived, single-use download handoff for a completed export.
   *
   * The raw token is returned exactly once and never stored — only its hash is,
   * mirroring how session and API-key tokens are handled. Presenting the token
   * is the capability to download; it expires quickly, so a leaked handoff URL
   * is useful for minutes, not forever.
   */
  async issueDownload(
    user: AuthenticatedUser,
    organizationId: string,
    exportId: string,
  ): Promise<DownloadHandoff> {
    await this.organizations.getOrganization(user, organizationId);
    const job = await this.requireJob(organizationId, exportId);

    if (job.status !== OrganizationExportStatus.COMPLETED) {
      throw new ConflictException(
        `Export ${exportId} is not ready to download (status ${job.status})`,
      );
    }

    const token = randomBytes(32).toString("base64url");
    const downloadExpiresAt = new Date(Date.now() + this.downloadTtlMs());

    // Update job and create receipt atomically
    await this.prisma.$transaction(async (tx) => {
      await tx.organizationExportJob.update({
        where: { id: exportId },
        data: { downloadTokenHash: sha256(token), downloadExpiresAt },
      });

      // Create receipt: immutable evidence that export download token was issued
      const receipt = await this.secretRetrievalReceiptService.create(
        {
          organizationId,
          secretType: SecretType.EXPORT,
          resourceId: exportId,
          resourceReference: `export-${job.categories.join(",")}`,
          recipientId: user.id,
          deliveryChannel: DeliveryChannel.DOWNLOAD_URL,
          revealedAt: new Date(),
          expiresAt: downloadExpiresAt, // receipt expires when token expires
        },
        tx,
      );

      // Audit log: export download token issued
      await tx.auditLog.create({
        data: {
          actorType: "user",
          actorId: user.id,
          action: "export_download.issued",
          resourceType: "export",
          resourceId: exportId,
          organizationId,
          metadata: {
            digest: job.archiveDigest ?? null,
            receiptId: receipt.id,
          },
        },
      });
    });

    return { token, expiresAt: downloadExpiresAt };
  }

  /**
   * Redeems a download token and returns the encrypted archive bytes.
   *
   * The token itself is the authorization: it is unguessable, short-lived, and
   * single-use — consumed on redemption so a captured token cannot be replayed.
   * The archive is returned still encrypted; the digest lets the caller verify
   * integrity. An expired, spent, or unknown token is an ordinary 404, never a
   * distinct "expired" signal that would let an attacker probe which tokens once
   * existed.
   */
  async consumeDownload(token: string): Promise<DownloadedArchive> {
    const job = await this.prisma.organizationExportJob.findUnique({
      where: { downloadTokenHash: sha256(token) },
    });

    const notFound = new NotFoundException("Download not available");

    if (
      !job ||
      job.status !== OrganizationExportStatus.COMPLETED ||
      !job.artifactPath ||
      !job.downloadExpiresAt ||
      job.downloadExpiresAt.getTime() <= Date.now()
    ) {
      throw notFound;
    }

    let content: Buffer;
    try {
      content = await this.artifacts.read(job.artifactPath);
    } catch {
      // The record says complete but the artifact is gone (expired sweep raced
      // the download, or the disk was wiped). Same opaque 404.
      throw notFound;
    }

    // Single use: spend the token so it cannot be replayed.
    // Also mark receipt as consumed/expired.
    await this.prisma.$transaction(async (tx) => {
      await tx.organizationExportJob.update({
        where: { id: job.id },
        data: { downloadTokenHash: null, downloadExpiresAt: null },
      });

      // Find and expire the receipt for this download token
      const receipts = await tx.secretRetrievalReceipt.findMany({
        where: {
          organizationId: job.organizationId,
          secretType: SecretType.EXPORT,
          resourceId: job.id,
        },
        orderBy: { revealedAt: "desc" },
        take: 1,
      });

      if (receipts.length > 0) {
        await tx.secretRetrievalReceipt.update({
          where: { id: receipts[0].id },
          data: {
            status: "EXPIRED",
            metadata: {
              ...receipts[0].metadata,
              consumedAt: new Date().toISOString(),
            },
          },
        });
      }
    });

    return {
      content,
      digest: job.archiveDigest ?? "",
      filename: `organization-export-${job.id}.enc`,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private validateCategories(
    categories: OrganizationExportCategory[],
  ): OrganizationExportCategory[] {
    const valid = new Set(Object.values(OrganizationExportCategory));
    const unique = [...new Set(categories)];

    if (unique.length === 0) {
      throw new BadRequestException("At least one export category is required");
    }
    const unknown = unique.filter((category) => !valid.has(category));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown export categor${unknown.length > 1 ? "ies" : "y"}: ${unknown.join(", ")}`,
      );
    }
    return unique;
  }

  private async requireJob(organizationId: string, exportId: string) {
    const job = await this.prisma.organizationExportJob.findFirst({
      where: { id: exportId, organizationId },
    });
    if (!job) throw new NotFoundException("Export not found");
    return job;
  }

  private toStatusView(job: {
    id: string;
    organizationId: string;
    categories: OrganizationExportCategory[];
    status: OrganizationExportStatus;
    archiveDigest: string | null;
    sizeBytes: number | null;
    errorCategory: string | null;
    expiresAt: Date;
    requestedAt: Date;
    completedAt: Date | null;
  }): ExportStatusView {
    return {
      id: job.id,
      organizationId: job.organizationId,
      categories: job.categories,
      status: job.status,
      // The digest is safe to expose — it reveals nothing about contents — and
      // is what a caller uses to verify a downloaded archive.
      archiveDigest: job.archiveDigest,
      sizeBytes: job.sizeBytes,
      errorCategory: job.errorCategory,
      expiresAt: job.expiresAt,
      requestedAt: job.requestedAt,
      completedAt: job.completedAt,
    };
  }

  private audit(
    user: AuthenticatedUser,
    action: string,
    organizationId: string,
    exportId: string,
    metadata: Prisma.InputJsonValue,
  ) {
    return this.prisma.auditLog.create({
      data: {
        actorType: "User",
        actorId: user.id,
        action,
        resourceType: "OrganizationExportJob",
        resourceId: exportId,
        metadata: { organizationId, ...(metadata as object) },
      },
    });
  }

  private jobTtlMs(): number {
    const hours = this.config.get<number>("organizations.export.jobTtlHours") ?? 24;
    return hours * 60 * 60 * 1000;
  }

  private downloadTtlMs(): number {
    const minutes =
      this.config.get<number>("organizations.export.downloadTtlMinutes") ?? 10;
    return minutes * 60 * 1000;
  }
}

export interface ExportStatusView {
  id: string;
  organizationId: string;
  categories: OrganizationExportCategory[];
  status: OrganizationExportStatus;
  archiveDigest: string | null;
  sizeBytes: number | null;
  errorCategory: string | null;
  expiresAt: Date;
  requestedAt: Date;
  completedAt: Date | null;
}

export interface DownloadHandoff {
  token: string;
  expiresAt: Date;
}

export interface DownloadedArchive {
  content: Buffer;
  digest: string;
  filename: string;
}
