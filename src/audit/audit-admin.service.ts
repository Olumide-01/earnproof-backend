import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { ExportAuditLogsDto } from "./dto/export-audit-logs.dto";
import { ListAuditLogsDto } from "./dto/list-audit-logs.dto";

/** Maximum span a single export request may cover. Documented, bounded date
 * ranges keep an export from becoming an unbounded table scan / dump. */
export const MAX_EXPORT_RANGE_DAYS = 90;

/** Hard safety cap on the number of records a single export can return, on
 * top of the date-range bound, in case a bounded range still matches an
 * unexpectedly large volume of records. */
export const MAX_EXPORT_RECORDS = 50_000;

export interface AuditLogListItem {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: unknown;
  organizationId: string | null;
  sequence: string;
  hashVersion: number;
  prevHash: string | null;
  hash: string;
  createdAt: Date;
}

export interface AuditLogListResult {
  data: AuditLogListItem[];
  pageInfo: {
    hasMore: boolean;
    nextCursor: string | null;
  };
}

export interface AuditLogExportResult {
  records: AuditLogListItem[];
  truncated: boolean;
}

/**
 * Administrator query/export path for AuditLog. Every query is required to
 * name an `organizationId` -- there is no cross-org listing or export here --
 * and exports additionally enforce a bounded date range (MAX_EXPORT_RANGE_DAYS)
 * plus a hard record-count safety net (MAX_EXPORT_RECORDS).
 */
@Injectable()
export class AuditAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListAuditLogsDto): Promise<AuditLogListResult> {
    const limit = query.limit ?? 20;
    const createdFrom = query.createdFrom
      ? new Date(query.createdFrom)
      : undefined;
    const createdTo = query.createdTo ? new Date(query.createdTo) : undefined;

    if (createdFrom && createdTo && createdFrom > createdTo) {
      throw new BadRequestException("createdFrom must be before createdTo");
    }

    if (query.cursor) {
      const cursorRecord = await this.prisma.auditLog.findFirst({
        where: { id: query.cursor, organizationId: query.organizationId },
        select: { id: true },
      });
      if (!cursorRecord) {
        throw new BadRequestException("Invalid audit log cursor");
      }
    }

    const where: Prisma.AuditLogWhereInput = {
      organizationId: query.organizationId,
      actorType: query.actorType,
      action: query.action,
      resourceType: query.resourceType,
      createdAt:
        createdFrom || createdTo
          ? { gte: createdFrom, lte: createdTo }
          : undefined,
    };

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : undefined),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: page.map(toListItem),
      pageInfo: {
        hasMore,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      },
    };
  }

  async export(query: ExportAuditLogsDto): Promise<AuditLogExportResult> {
    const createdFrom = new Date(query.createdFrom);
    const createdTo = new Date(query.createdTo);

    if (Number.isNaN(createdFrom.getTime()) || Number.isNaN(createdTo.getTime())) {
      throw new BadRequestException("createdFrom/createdTo must be valid dates");
    }

    if (createdFrom > createdTo) {
      throw new BadRequestException("createdFrom must be before createdTo");
    }

    const rangeMs = createdTo.getTime() - createdFrom.getTime();
    const maxRangeMs = MAX_EXPORT_RANGE_DAYS * 24 * 60 * 60 * 1000;
    if (rangeMs > maxRangeMs) {
      throw new BadRequestException(
        `Export date range must not exceed ${MAX_EXPORT_RANGE_DAYS} days`,
      );
    }

    const where: Prisma.AuditLogWhereInput = {
      organizationId: query.organizationId,
      actorType: query.actorType,
      action: query.action,
      resourceType: query.resourceType,
      createdAt: { gte: createdFrom, lte: createdTo },
    };

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_EXPORT_RECORDS + 1,
    });

    const truncated = rows.length > MAX_EXPORT_RECORDS;
    const records = truncated ? rows.slice(0, MAX_EXPORT_RECORDS) : rows;

    return {
      records: records.map(toListItem),
      truncated,
    };
  }
}

function toListItem(row: {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: unknown;
  organizationId: string | null;
  sequence: bigint;
  hashVersion: number;
  prevHash: string | null;
  hash: string;
  createdAt: Date;
}): AuditLogListItem {
  return {
    id: row.id,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    metadata: row.metadata,
    organizationId: row.organizationId,
    sequence: row.sequence.toString(),
    hashVersion: row.hashVersion,
    prevHash: row.prevHash,
    hash: row.hash,
    createdAt: row.createdAt,
  };
}
