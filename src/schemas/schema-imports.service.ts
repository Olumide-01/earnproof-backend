import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, SchemaImportJob, SchemaImportStatus } from "@prisma/client";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../database/prisma.service";
import { UploadSchemaImportDto } from "./dto/upload-schema-import.dto";
import { ReviewSchemaImportDto } from "./dto/review-schema-import.dto";

/** Hard bound on rows per import — defense in depth alongside the DTO's own limit. */
const MAX_IMPORT_ROWS = 2000;

type NormalizedRow = {
  rowIndex: number;
  schemaKey: string;
  version: string;
  definition: Record<string, unknown>;
  normalizedHash: string;
  conflict: boolean;
  errors: string[];
};

@Injectable()
export class SchemaImportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upload + dry-run in one step: parses, normalizes, and conflict-checks
   * every row, persisting the row-level results. Never writes to
   * `SchemaDefinition` — that table is only touched by {@link apply}.
   */
  async uploadAndDryRun(
    user: AuthenticatedUser,
    organizationId: string,
    dto: UploadSchemaImportDto,
  ): Promise<SchemaImportJob> {
    if (dto.rows.length === 0) {
      throw new BadRequestException("Import must contain at least one row");
    }
    if (dto.rows.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException(
        `Import exceeds the ${MAX_IMPORT_ROWS}-row bound (received ${dto.rows.length})`,
      );
    }

    const job = await this.prisma.schemaImportJob.create({
      data: {
        organizationId,
        status: SchemaImportStatus.DRY_RUN_RUNNING,
        rowCount: dto.rows.length,
        uploadedById: user.id,
      },
    });

    const normalized = await this.normalizeAndDetectConflicts(dto.rows);

    await this.prisma.schemaImportRow.createMany({
      data: normalized.map((row) => ({
        jobId: job.id,
        rowIndex: row.rowIndex,
        schemaKey: row.schemaKey,
        version: row.version,
        definition: row.definition as Prisma.InputJsonValue,
        normalizedHash: row.normalizedHash,
        conflict: row.conflict,
        errors: row.errors.length > 0 ? (row.errors as Prisma.InputJsonValue) : undefined,
      })),
    });

    const canonicalHash = this.computeCanonicalHash(normalized);
    const conflictCount = normalized.filter((r) => r.conflict).length;
    const errorCount = normalized.filter((r) => r.errors.length > 0).length;

    const updated = await this.prisma.schemaImportJob.update({
      where: { id: job.id },
      data: {
        status: SchemaImportStatus.DRY_RUN_COMPLETE,
        canonicalHash,
        conflictCount,
        errorCount,
      },
    });

    await this.audit(user, "schema_import.dry_run.completed", job.id, {
      organizationId,
      rowCount: dto.rows.length,
      conflictCount,
      errorCount,
      canonicalHash,
    });

    return updated;
  }

  async get(id: string): Promise<SchemaImportJob> {
    const job = await this.prisma.schemaImportJob.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException(`Schema import job ${id} not found`);
    }
    return job;
  }

  listRows(jobId: string) {
    return this.prisma.schemaImportRow.findMany({
      where: { jobId },
      orderBy: { rowIndex: "asc" },
    });
  }

  /** Approve a completed dry run. Requires the exact reviewed hash. */
  async approve(
    user: AuthenticatedUser,
    id: string,
    dto: ReviewSchemaImportDto,
  ): Promise<SchemaImportJob> {
    const job = await this.get(id);

    if (job.status !== SchemaImportStatus.DRY_RUN_COMPLETE) {
      throw new ConflictException(
        `Job must be in DRY_RUN_COMPLETE to approve (currently ${job.status})`,
      );
    }
    if (job.canonicalHash !== dto.reviewedHash) {
      throw new ConflictException(
        "reviewedHash does not match the job's current canonicalHash — the dry-run result changed, re-review before approving",
      );
    }

    await this.prisma.schemaImportJob.update({
      where: { id },
      data: { status: SchemaImportStatus.APPROVED, approvedById: user.id, approvedAt: new Date() },
    });

    await this.audit(user, "schema_import.approved", id, { reviewedHash: dto.reviewedHash });

    return this.get(id);
  }

  /**
   * Apply an approved import. Idempotency / concurrency: the APPROVED ->
   * APPLYING transition is a single conditional `updateMany`, so only one
   * concurrent caller can begin applying a given job.
   */
  async apply(
    user: AuthenticatedUser,
    id: string,
    dto: ReviewSchemaImportDto,
  ): Promise<SchemaImportJob> {
    const job = await this.get(id);

    if (job.canonicalHash !== dto.reviewedHash) {
      throw new ConflictException(
        "reviewedHash does not match the job's canonicalHash — refusing to apply a different result than was reviewed",
      );
    }

    const claim = await this.prisma.schemaImportJob.updateMany({
      where: { id, status: SchemaImportStatus.APPROVED },
      data: { status: SchemaImportStatus.APPLYING },
    });

    if (claim.count === 0) {
      const current = await this.get(id);
      if (current.status === SchemaImportStatus.APPLIED) {
        // Already applied by a previous (or concurrent) caller — idempotent no-op.
        return current;
      }
      throw new ConflictException(
        `Job must be APPROVED to apply (currently ${current.status})`,
      );
    }

    try {
      const rows = await this.prisma.schemaImportRow.findMany({
        where: { jobId: id, conflict: false },
      });
      const applicableRows = rows.filter((row) => !row.errors);

      await this.prisma.$transaction(
        applicableRows.map((row) =>
          this.prisma.schemaDefinition.upsert({
            where: { schemaKey_version: { schemaKey: row.schemaKey, version: row.version } },
            create: {
              schemaKey: row.schemaKey,
              version: row.version,
              definition: row.definition as Prisma.InputJsonValue,
              importJobId: id,
            },
            update: {
              definition: row.definition as Prisma.InputJsonValue,
              importJobId: id,
            },
          }),
        ),
      );

      const applied = await this.prisma.schemaImportJob.update({
        where: { id },
        data: { status: SchemaImportStatus.APPLIED, appliedAt: new Date() },
      });

      await this.audit(user, "schema_import.applied", id, {
        appliedRowCount: applicableRows.length,
      });

      return applied;
    } catch (err) {
      await this.prisma.schemaImportJob.update({
        where: { id },
        data: {
          status: SchemaImportStatus.FAILED,
          failureReason: err instanceof Error ? err.message : "apply failed",
        },
      });
      throw err;
    }
  }

  private async normalizeAndDetectConflicts(
    rows: UploadSchemaImportDto["rows"],
  ): Promise<NormalizedRow[]> {
    const seenInBatch = new Map<string, number>();
    const result: NormalizedRow[] = [];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const raw = rows[rowIndex];
      const errors: string[] = [];

      if (!raw.schemaKey || !raw.version) {
        errors.push("schemaKey and version are required");
      }
      if (!raw.definition || typeof raw.definition !== "object") {
        errors.push("definition must be an object");
      }

      const normalizedHash = sha256(canonicalize(raw.definition ?? {}));
      const batchKey = `${raw.schemaKey}@${raw.version}`;

      let conflict = false;
      if (seenInBatch.has(batchKey)) {
        conflict = true;
        errors.push(`duplicate schemaKey/version within this import: ${batchKey}`);
      } else {
        seenInBatch.set(batchKey, rowIndex);
      }

      if (errors.length === 0) {
        const existing = await this.prisma.schemaDefinition.findUnique({
          where: { schemaKey_version: { schemaKey: raw.schemaKey, version: raw.version } },
        });
        if (existing && sha256(canonicalize(existing.definition)) !== normalizedHash) {
          conflict = true;
          errors.push(
            `${batchKey} already exists with different content — would silently overwrite`,
          );
        }
      }

      result.push({
        rowIndex,
        schemaKey: raw.schemaKey,
        version: raw.version,
        definition: raw.definition,
        normalizedHash,
        conflict,
        errors,
      });
    }

    return result;
  }

  private computeCanonicalHash(rows: NormalizedRow[]): string {
    const summary = rows
      .map((r) => ({
        rowIndex: r.rowIndex,
        schemaKey: r.schemaKey,
        version: r.version,
        normalizedHash: r.normalizedHash,
        conflict: r.conflict,
        hasErrors: r.errors.length > 0,
      }))
      .sort((a, b) => a.rowIndex - b.rowIndex);

    return sha256(canonicalize(summary));
  }

  private audit(
    user: AuthenticatedUser,
    action: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ) {
    return this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorType: "User",
        action,
        resourceType: "SchemaImportJob",
        resourceId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}
