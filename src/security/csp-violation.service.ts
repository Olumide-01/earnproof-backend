import { Injectable, Logger } from "@nestjs/common";
import { CspDirective, CspDisposition, CspRouteCategory } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import {
  CspReportClientContext,
  CspViolationAbuseService,
} from "./csp-violation-abuse.service";
import { ReportCspViolationDto } from "./dto/report-csp-violation.dto";

/**
 * Privacy-safe, aggregated CSP violation ingestion (#336).
 *
 * Stores bounded metadata only: directive, route category, release, and
 * disposition — never a document/blocked URI, DOM data, or user input (the
 * DTO does not even accept those fields, so there is nothing to redact).
 *
 * Concurrency safety:
 *   Increments use a single atomic SQL upsert (INSERT ... ON CONFLICT DO
 *   UPDATE ... SET count = count + 1), the same pattern
 *   ApiKeyUsageService.recordUsage() uses. Concurrent reports for the same
 *   (directive x routeCategory x release x disposition) bucket converge on
 *   one row with no lost updates.
 *
 * Abuse control:
 *   Every report is sampled through CspViolationAbuseService before it is
 *   counted. A report that is sampled out is silently dropped: the endpoint
 *   always responds identically either way (see the controller), so sampling
 *   cannot be probed from the outside.
 *
 * Fail-open:
 *   Ingestion catches and logs its own errors. A storage failure must never
 *   surface to the reporting browser as anything other than the endpoint's
 *   normal success response.
 */
@Injectable()
export class CspViolationService {
  private readonly logger = new Logger(CspViolationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly abuse: CspViolationAbuseService,
  ) {}

  async ingest(
    report: ReportCspViolationDto,
    client: CspReportClientContext,
  ): Promise<void> {
    const bucketKey = this.bucketKey(report);

    if (!this.abuse.shouldAccept(client, bucketKey)) {
      return;
    }

    try {
      const now = new Date();
      // Round down to the nearest minute, like ApiKeyUsageSummary.lastUsedAt,
      // so individual report timing cannot be reconstructed from storage.
      const lastSeenAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000);

      await this.prisma.$executeRaw`
        INSERT INTO "CspViolationSummary"
          ("id", "directive", "routeCategory", "release", "disposition", "count", "firstSeenAt", "lastSeenAt", "createdAt", "updatedAt")
        VALUES
          (gen_random_uuid()::text, ${report.directive}::"CspDirective", ${report.routeCategory}::"CspRouteCategory", ${report.release}, ${report.disposition}::"CspDisposition", 1, ${lastSeenAt}, ${lastSeenAt}, NOW(), NOW())
        ON CONFLICT ("directive", "routeCategory", "release", "disposition")
        DO UPDATE SET
          "count"      = "CspViolationSummary"."count" + 1,
          "lastSeenAt" = GREATEST("CspViolationSummary"."lastSeenAt", EXCLUDED."lastSeenAt"),
          "updatedAt"  = NOW()
      `;
    } catch (error) {
      this.logger.warn(
        `Failed to record CSP violation summary: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Return all summary buckets, newest-activity first. Safe to expose to an
   * operator — no raw URI, DOM data, or user input, ever.
   */
  async getSummary() {
    return this.prisma.cspViolationSummary.findMany({
      select: {
        directive: true,
        routeCategory: true,
        release: true,
        disposition: true,
        count: true,
        firstSeenAt: true,
        lastSeenAt: true,
      },
      orderBy: [{ lastSeenAt: "desc" }],
      take: 500,
    });
  }

  private bucketKey(report: {
    directive: CspDirective;
    routeCategory: CspRouteCategory;
    release: string;
    disposition: CspDisposition;
  }): string {
    return `${report.directive}:${report.routeCategory}:${report.release}:${report.disposition}`;
  }
}
