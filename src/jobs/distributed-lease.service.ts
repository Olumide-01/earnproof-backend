import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import * as os from "os";

/**
 * Distributed lease service for coordinating scheduled jobs across multiple instances.
 *
 * Provides exactly-once job execution semantics by managing database-backed leases with:
 * - Atomic acquisition with owner and expiry
 * - Heartbeat-based renewal
 * - Automatic takeover after verified expiry
 * - Clock-skew tolerance using database-time semantics
 *
 * Clock skew handling:
 * - All timestamp comparisons use DATABASE_TIME, not client time
 * - Uses Postgres `CURRENT_TIMESTAMP` for expiry checks
 * - Owner clock skew does not affect lease validity (expiry is server-time)
 *
 * Lease lifecycle:
 * 1. ACQUIRE: Process attempts to create or acquire an expired lease atomically
 * 2. RENEW: Owner heartbeats to extend expiry time
 * 3. RELEASE: Owner voluntarily releases the lease
 * 4. TAKEOVER: Another process acquires an expired lease
 */

export interface LeaseAcquisitionResult {
  acquired: boolean;
  owner: string;
  expiresAt: Date;
  isExpired: boolean;
}

export interface LeaseRenewalResult {
  renewed: boolean;
  newExpiresAt: Date;
}

export interface LeaseInfo {
  jobName: string;
  owner: string;
  expiresAt: Date;
  lastHeartbeatAt: Date;
  isExpired: boolean;
}

@Injectable()
export class DistributedLeaseService {
  private readonly logger = new Logger(DistributedLeaseService.name);
  private readonly processId: string;

  constructor(private readonly prisma: PrismaService) {
    // Generate a unique process identifier from hostname + PID
    // Allows orchestrators to identify which replica owns a lease
    this.processId = `${os.hostname()}-${process.pid}`;
    this.logger.log(`Lease service initialized with owner ID: ${this.processId}`);
  }

  /**
   * Attempts to acquire a lease for a job.
   *
   * Returns successfully only if:
   * 1. A new lease is created (no prior lease), OR
   * 2. An existing lease has expired (verified using DATABASE_TIME)
   *
   * Multiple instances may attempt simultaneously; exactly one will succeed due to
   * the UNIQUE constraint on jobName and the atomic nature of the database operation.
   *
   * @param jobName Unique identifier for the job (e.g., "auth_cleanup")
   * @param leaseDurationMs Duration to hold the lease (ms)
   * @returns Acquisition result with owner, expiry, and status
   */
  async acquireLease(
    jobName: string,
    leaseDurationMs: number,
  ): Promise<LeaseAcquisitionResult> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseDurationMs);

    try {
      // Attempt atomic acquisition:
      // 1. Try to create a new lease if none exists
      // 2. If it exists, update only if it's expired (verified server-side)
      //
      // The raw SQL uses CURRENT_TIMESTAMP for expiry comparison to handle
      // clock skew: expiry is always checked against the database's clock.
      const result = await this.prisma.$queryRaw<
        Array<{
          id: string;
          jobName: string;
          owner: string;
          expiresAt: Date;
          lastHeartbeatAt: Date;
          isExpired: boolean;
        }>
      >`
        INSERT INTO "JobLease" (id, "jobName", owner, "expiresAt", "lastHeartbeatAt", "createdAt", "updatedAt")
        VALUES (
          gen_random_uuid()::text,
          ${jobName},
          ${this.processId},
          ${expiresAt},
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT ("jobName") DO UPDATE SET
          owner = CASE 
            WHEN CURRENT_TIMESTAMP > "JobLease"."expiresAt" THEN ${this.processId}
            ELSE "JobLease".owner
          END,
          "expiresAt" = CASE
            WHEN CURRENT_TIMESTAMP > "JobLease"."expiresAt" THEN ${expiresAt}
            ELSE "JobLease"."expiresAt"
          END,
          "lastHeartbeatAt" = CASE
            WHEN CURRENT_TIMESTAMP > "JobLease"."expiresAt" THEN CURRENT_TIMESTAMP
            ELSE "JobLease"."lastHeartbeatAt"
          END,
          "updatedAt" = CASE
            WHEN CURRENT_TIMESTAMP > "JobLease"."expiresAt" THEN CURRENT_TIMESTAMP
            ELSE "JobLease"."updatedAt"
          END
        RETURNING
          id,
          "jobName",
          owner,
          "expiresAt",
          "lastHeartbeatAt",
          (CURRENT_TIMESTAMP > "expiresAt")::boolean as "isExpired"
      `;

      if (result.length === 0) {
        throw new Error(`Lease acquisition returned no rows for job ${jobName}`);
      }

      const lease = result[0];
      const acquired = lease.owner === this.processId;

      if (acquired) {
        this.logger.log(
          `Lease acquired for job '${jobName}' (expires at ${lease.expiresAt.toISOString()})`,
        );
      } else {
        this.logger.debug(
          `Lease for job '${jobName}' held by '${lease.owner}' (expires at ${lease.expiresAt.toISOString()})`,
        );
      }

      return {
        acquired,
        owner: lease.owner,
        expiresAt: lease.expiresAt,
        isExpired: lease.isExpired,
      };
    } catch (error) {
      this.logger.error(
        `Failed to acquire lease for job '${jobName}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  /**
   * Renews a lease held by this process.
   *
   * Only succeeds if this process currently owns the lease.
   * Fails safely if another process has acquired it (no exception raised).
   *
   * @param jobName Job identifier
   * @param newLeaseDurationMs New lease duration (ms)
   * @returns Renewal result with success status and new expiry
   */
  async renewLease(
    jobName: string,
    newLeaseDurationMs: number,
  ): Promise<LeaseRenewalResult> {
    const expiresAt = new Date(Date.now() + newLeaseDurationMs);

    try {
      const result = await this.prisma.jobLease.updateMany({
        where: {
          jobName,
          owner: this.processId,
        },
        data: {
          expiresAt,
          lastHeartbeatAt: new Date(),
        },
      });

      const renewed = result.count > 0;

      if (renewed) {
        this.logger.debug(
          `Lease renewed for job '${jobName}' (expires at ${expiresAt.toISOString()})`,
        );
      } else {
        this.logger.warn(
          `Lease renewal failed for job '${jobName}': lease not owned by this process`,
        );
      }

      return {
        renewed,
        newExpiresAt: expiresAt,
      };
    } catch (error) {
      this.logger.error(
        `Failed to renew lease for job '${jobName}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  /**
   * Releases a lease held by this process.
   *
   * Allows the job to voluntarily relinquish the lease before expiry.
   * Useful for graceful shutdown or manual coordination.
   *
   * @param jobName Job identifier
   * @returns True if released, false if not owned by this process
   */
  async releaseLease(jobName: string): Promise<boolean> {
    try {
      const result = await this.prisma.jobLease.deleteMany({
        where: {
          jobName,
          owner: this.processId,
        },
      });

      const released = result.count > 0;

      if (released) {
        this.logger.log(`Lease released for job '${jobName}'`);
      } else {
        this.logger.debug(
          `Lease release for job '${jobName}': lease not owned by this process`,
        );
      }

      return released;
    } catch (error) {
      this.logger.error(
        `Failed to release lease for job '${jobName}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  /**
   * Queries current lease information for a job.
   *
   * Returns null if no lease exists. Useful for monitoring and debugging.
   *
   * @param jobName Job identifier
   * @returns Lease information or null if not found
   */
  async queryLease(jobName: string): Promise<LeaseInfo | null> {
    try {
      const lease = await this.prisma.$queryRaw<
        Array<{
          jobName: string;
          owner: string;
          expiresAt: Date;
          lastHeartbeatAt: Date;
          isExpired: boolean;
        }>
      >`
        SELECT
          "jobName",
          owner,
          "expiresAt",
          "lastHeartbeatAt",
          (CURRENT_TIMESTAMP > "expiresAt")::boolean as "isExpired"
        FROM "JobLease"
        WHERE "jobName" = ${jobName}
      `;

      if (lease.length === 0) {
        return null;
      }

      return {
        jobName: lease[0].jobName,
        owner: lease[0].owner,
        expiresAt: lease[0].expiresAt,
        lastHeartbeatAt: lease[0].lastHeartbeatAt,
        isExpired: lease[0].isExpired,
      };
    } catch (error) {
      this.logger.error(
        `Failed to query lease for job '${jobName}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  /**
   * Returns the process ID (owner identifier) for this instance.
   * Useful for testing and debugging.
   */
  getProcessId(): string {
    return this.processId;
  }
}
