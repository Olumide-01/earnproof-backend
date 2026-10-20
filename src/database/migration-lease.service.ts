import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "./prisma.service";
import { hostname } from "os";

export type MigrationLeaseResult =
  | {
      acquired: true;
      ownerId: string;
      acquiredAt: Date;
      expiresAt: Date;
    }
  | {
      acquired: false;
      reason: "already_held" | "stale_recovery_failed" | "database_error";
      currentOwner?: string;
      acquiredAt?: Date;
      expiresAt?: Date;
    };

export type MigrationLeaseStatus = {
  held: boolean;
  ownerId?: string;
  acquiredAt?: Date;
  expiresAt?: Date;
  migrationState?: string;
  lastVersion?: string;
  isActive?: boolean;
  isStale?: boolean;
};

/**
 * Migration deployment lease service.
 * 
 * Prevents multiple application instances from racing database migration deployment.
 * Uses PostgreSQL advisory locks for mutual exclusion combined with persisted state
 * for observability and stale recovery.
 * 
 * Only one migration deployment may execute at a time.
 * Applications must not report ready against incompatible schema.
 */
@Injectable()
export class MigrationLeaseService {
  private readonly logger = new Logger(MigrationLeaseService.name);
  private readonly ownerId: string;
  private readonly leaseTimeoutMs: number;
  private readonly staleTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    // Use hostname + process info for owner identification
    this.ownerId = `${hostname()}-${process.pid}-${Date.now()}`;
    
    // Lease timeout: how long a deployment can hold the lock
    this.leaseTimeoutMs = configService.get<number>("migrationLease.timeoutMs") ?? 30 * 60 * 1000; // 30 minutes
    
    // Stale timeout: when a lease can be recovered
    this.staleTimeoutMs = configService.get<number>("migrationLease.staleTimeoutMs") ?? 45 * 60 * 1000; // 45 minutes
  }

  /**
   * Attempt to acquire the migration deployment lease.
   * 
   * Uses PostgreSQL advisory lock 123456789 for atomic acquisition.
   * If successful, creates/updates the persisted lease record.
   * 
   * @param migrationState Current migration state being processed
   * @returns Lease acquisition result
   */
  async acquireLease(migrationState?: string): Promise<MigrationLeaseResult> {
    const advisoryLockId = 123456789; // Stable migration lock ID
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.leaseTimeoutMs);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Try to acquire PostgreSQL advisory lock
        const lockResult = await tx.$queryRaw<Array<{ pg_try_advisory_lock: boolean }>>`
          SELECT pg_try_advisory_lock(${advisoryLockId}) as pg_try_advisory_lock
        `;

        if (!lockResult[0]?.pg_try_advisory_lock) {
          // Lock held by another session - check if lease is stale
          const existing = await tx.migrationLease.findUnique({
            where: { id: "migration_deployment" },
          });

          if (existing && this.isStale(existing.expiresAt)) {
            // Try to recover stale lock
            try {
              // Force release the advisory lock and retry acquisition
              await tx.$queryRaw`SELECT pg_advisory_unlock_all()`;
              
              const retryResult = await tx.$queryRaw<Array<{ pg_try_advisory_lock: boolean }>>`
                SELECT pg_try_advisory_lock(${advisoryLockId}) as pg_try_advisory_lock
              `;

              if (!retryResult[0]?.pg_try_advisory_lock) {
                return {
                  acquired: false,
                  reason: "stale_recovery_failed" as const,
                  currentOwner: existing.ownerId,
                  acquiredAt: existing.acquiredAt,
                  expiresAt: existing.expiresAt,
                };
              }
              
              // Successfully recovered - update lease record
              const updated = await tx.migrationLease.upsert({
                where: { id: "migration_deployment" },
                create: {
                  id: "migration_deployment",
                  ownerId: this.ownerId,
                  acquiredAt: now,
                  expiresAt,
                  migrationState: migrationState ?? null,
                  isActive: true,
                  ownerMetadata: { hostname: hostname(), pid: process.pid },
                },
                update: {
                  ownerId: this.ownerId,
                  acquiredAt: now,
                  expiresAt,
                  migrationState: migrationState ?? null,
                  isActive: true,
                  ownerMetadata: { hostname: hostname(), pid: process.pid },
                },
              });

              this.logger.log(`Migration lease acquired after stale recovery`, {
                ownerId: this.ownerId,
                previousOwner: existing.ownerId,
                expiresAt: expiresAt.toISOString(),
                migrationState,
              });

              return {
                acquired: true,
                ownerId: updated.ownerId,
                acquiredAt: updated.acquiredAt,
                expiresAt: updated.expiresAt,
              };
            } catch (recoveryError) {
              this.logger.warn(`Stale lease recovery failed`, {
                error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
                existingOwner: existing.ownerId,
              });
              
              return {
                acquired: false,
                reason: "stale_recovery_failed" as const,
                currentOwner: existing.ownerId,
                acquiredAt: existing.acquiredAt,
                expiresAt: existing.expiresAt,
              };
            }
          }

          return {
            acquired: false,
            reason: "already_held" as const,
            currentOwner: existing?.ownerId,
            acquiredAt: existing?.acquiredAt,
            expiresAt: existing?.expiresAt,
          };
        }

        // Successfully acquired advisory lock - create/update lease record
        const lease = await tx.migrationLease.upsert({
          where: { id: "migration_deployment" },
          create: {
            id: "migration_deployment",
            ownerId: this.ownerId,
            acquiredAt: now,
            expiresAt,
            migrationState: migrationState ?? null,
            isActive: true,
            ownerMetadata: { hostname: hostname(), pid: process.pid },
          },
          update: {
            ownerId: this.ownerId,
            acquiredAt: now,
            expiresAt,
            migrationState: migrationState ?? null,
            isActive: true,
            ownerMetadata: { hostname: hostname(), pid: process.pid },
          },
        });

        this.logger.log(`Migration lease acquired`, {
          ownerId: this.ownerId,
          expiresAt: expiresAt.toISOString(),
          migrationState,
        });

        return {
          acquired: true,
          ownerId: lease.ownerId,
          acquiredAt: lease.acquiredAt,
          expiresAt: lease.expiresAt,
        };
      });
    } catch (error) {
      this.logger.error(`Failed to acquire migration lease`, {
        error: error instanceof Error ? error.message : String(error),
        ownerId: this.ownerId,
      });

      return {
        acquired: false,
        reason: "database_error" as const,
      };
    }
  }

  /**
   * Release the migration deployment lease if held by this owner.
   * 
   * @param migrationState Final migration state/version completed
   * @returns True if successfully released, false if not held by this owner
   */
  async releaseLease(migrationState?: string): Promise<boolean> {
    const advisoryLockId = 123456789;

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Check if we hold the lease
        const existing = await tx.migrationLease.findUnique({
          where: { id: "migration_deployment" },
        });

        if (!existing || existing.ownerId !== this.ownerId) {
          this.logger.warn(`Cannot release lease not held by this owner`, {
            ownerId: this.ownerId,
            currentOwner: existing?.ownerId,
          });
          return false;
        }

        // Update lease record to inactive
        await tx.migrationLease.update({
          where: { id: "migration_deployment" },
          data: {
            isActive: false,
            migrationState: migrationState ?? existing.migrationState,
            lastVersion: migrationState ?? existing.lastVersion,
          },
        });

        // Release the advisory lock
        await tx.$queryRaw`SELECT pg_advisory_unlock(${advisoryLockId})`;

        this.logger.log(`Migration lease released`, {
          ownerId: this.ownerId,
          migrationState,
        });

        return true;
      });
    } catch (error) {
      this.logger.error(`Failed to release migration lease`, {
        error: error instanceof Error ? error.message : String(error),
        ownerId: this.ownerId,
      });
      return false;
    }
  }

  /**
   * Get current migration lease status for observability.
   * 
   * @returns Current lease status
   */
  async getLeaseStatus(): Promise<MigrationLeaseStatus> {
    try {
      const lease = await this.prisma.migrationLease.findUnique({
        where: { id: "migration_deployment" },
      });

      if (!lease || !lease.isActive) {
        return { held: false };
      }

      return {
        held: true,
        ownerId: lease.ownerId,
        acquiredAt: lease.acquiredAt,
        expiresAt: lease.expiresAt,
        migrationState: lease.migrationState ?? undefined,
        lastVersion: lease.lastVersion ?? undefined,
        isActive: lease.isActive,
        isStale: this.isStale(lease.expiresAt),
      };
    } catch (error) {
      this.logger.error(`Failed to get lease status`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return { held: false };
    }
  }

  /**
   * Update migration state/progress for observability.
   * Only the lease holder can update state.
   * 
   * @param migrationState Current migration state
   * @returns True if successfully updated
   */
  async updateMigrationState(migrationState: string): Promise<boolean> {
    try {
      const result = await this.prisma.migrationLease.updateMany({
        where: {
          id: "migration_deployment",
          ownerId: this.ownerId,
          isActive: true,
        },
        data: {
          migrationState,
        },
      });

      return result.count > 0;
    } catch (error) {
      this.logger.error(`Failed to update migration state`, {
        error: error instanceof Error ? error.message : String(error),
        ownerId: this.ownerId,
        migrationState,
      });
      return false;
    }
  }

  /**
   * Check if a lease expiration time indicates staleness.
   */
  private isStale(expiresAt: Date): boolean {
    return Date.now() > expiresAt.getTime() + this.staleTimeoutMs;
  }

  /**
   * Get owner identifier for this service instance.
   */
  getOwnerId(): string {
    return this.ownerId;
  }
}