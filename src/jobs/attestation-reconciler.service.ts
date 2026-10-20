import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { ResourceStatus } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import {
  DEFAULT_ATTESTATION_CLOCK_SKEW_MS,
  computeEffectiveAttestationStatus,
} from "../issuers/attestation-status";
import { WebhookDeliveryService } from "../webhooks/webhook-delivery.service";

/** Attestations reconciled per cycle, to bound execution time. */
const RECONCILE_BATCH_SIZE = 100;

/**
 * AttestationReconcilerService (#207)
 *
 * Issuer attestations expire with the passage of time, not by an explicit
 * action, so their stored `status` can lag reality. This job reconciles that on
 * a schedule: it finds ACTIVE attestations whose expiry has passed (beyond a
 * clock-skew tolerance) and moves them to EXPIRED, records when each was
 * evaluated, and emits an audit log and a webhook for the transition.
 *
 * Design guarantees:
 *  - Historical evidence is never mutated. The signed payload and `expiresAt`
 *    are left exactly as issued; only the derived `status` and `reconciledAt`
 *    move. The effective status is always computable from the untouched fields
 *    via {@link computeEffectiveAttestationStatus}.
 *  - Idempotent and restartable. Only ACTIVE-and-past-expiry rows are selected,
 *    and each is moved to EXPIRED once; a re-run (or a crash mid-cycle) finds
 *    only the rows not yet transitioned, so no duplicate events are emitted for
 *    an attestation already reconciled.
 *  - Deterministic clock-skew boundary. Expiry uses the same strict, one-sided
 *    comparison as the effective-status function, so the job and the API agree.
 */
@Injectable()
export class AttestationReconcilerService {
  private readonly logger = new Logger(AttestationReconcilerService.name);
  private readonly clockSkewMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional()
    private readonly webhookDeliveryService?: WebhookDeliveryService,
  ) {
    this.clockSkewMs = this.config.get<number>(
      "attestation.clockSkewMs",
      DEFAULT_ATTESTATION_CLOCK_SKEW_MS,
    );
  }

  @Interval(5 * 60_000)
  async reconcile(now: Date = new Date()): Promise<number> {
    // The skew tolerance is folded into the query bound so the database returns
    // only rows that are genuinely past expiry, keeping the scan on the
    // (status, expiresAt) index and the effective-status verdict consistent.
    const cutoff = new Date(now.getTime() - this.clockSkewMs);

    const due = await this.prisma.attestation.findMany({
      where: {
        status: ResourceStatus.ACTIVE,
        expiresAt: { not: null, lt: cutoff },
      },
      select: {
        id: true,
        issuerId: true,
        subjectWalletHash: true,
        status: true,
        expiresAt: true,
        revokedAt: true,
        issuer: { select: { organizationId: true } },
      },
      take: RECONCILE_BATCH_SIZE,
      orderBy: { expiresAt: "asc" },
    });

    let transitioned = 0;
    for (const attestation of due) {
      const applied = await this.expire(attestation, now);
      if (applied) transitioned += 1;
    }
    return transitioned;
  }

  private async expire(
    attestation: {
      id: string;
      issuerId: string;
      subjectWalletHash: string;
      status: ResourceStatus;
      expiresAt: Date | null;
      revokedAt: Date | null;
      issuer: { organizationId: string };
    },
    now: Date,
  ): Promise<boolean> {
    const effective = computeEffectiveAttestationStatus(
      { status: attestation.status, expiresAt: attestation.expiresAt, revokedAt: attestation.revokedAt },
      now,
      this.clockSkewMs,
    );
    // Defensive: the query already selects only expired-ACTIVE rows, but a row
    // that raced into another state between the read and here is left alone.
    if (effective !== "EXPIRED") return false;

    // Move to EXPIRED only from ACTIVE, in one conditional update. If a
    // concurrent worker or a restart already moved it, `count` is 0 and no
    // duplicate audit or webhook is emitted — this is what makes the job
    // idempotent and restartable.
    const reconciledAt = now;
    const result = await this.prisma.attestation.updateMany({
      where: { id: attestation.id, status: ResourceStatus.ACTIVE },
      data: {
        status: ResourceStatus.EXPIRED,
        reconciledAt,
      },
    });
    if (result.count === 0) return false;

    await this.prisma.auditLog.create({
      data: {
        actorType: "system",
        actorId: "attestation-reconciler",
        action: "attestation.expired",
        resourceType: "attestation",
        resourceId: attestation.id,
        metadata: {
          issuerId: attestation.issuerId,
          previousStatus: attestation.status,
          effectiveStatus: "EXPIRED",
          expiresAt: attestation.expiresAt?.toISOString() ?? null,
          reconciledAt: reconciledAt.toISOString(),
        },
      },
    });

    this.emitExpired(attestation.issuer.organizationId, {
      attestationId: attestation.id,
      issuerId: attestation.issuerId,
      subjectWalletHash: attestation.subjectWalletHash,
      previousStatus: attestation.status,
      effectiveStatus: "EXPIRED",
      expiresAt: attestation.expiresAt?.toISOString() ?? "",
      reconciledAt: reconciledAt.toISOString(),
    });

    this.logger.log(
      `Attestation ${attestation.id} reconciled to EXPIRED (issuer ${attestation.issuerId})`,
    );
    return true;
  }

  private emitExpired(
    organizationId: string,
    data: Record<string, unknown>,
  ): void {
    this.webhookDeliveryService
      ?.enqueueForOrganization(organizationId, "attestation.expired", {
        event: "attestation.expired",
        data,
      } as never)
      .catch(() => undefined);
  }
}
