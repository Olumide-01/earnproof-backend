import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { AnchoringOperation, AnchoringStatus, Prisma, ProofStatus } from "@prisma/client";
import { StructuredLogger } from "../common/logger";
import { MetricsRegistry } from "../common/observability/metrics.registry";
import { METRIC_NAMES } from "../common/observability/metrics.catalog";
import { PrismaService } from "../database/prisma.service";
import { WebhookDeadLetterService } from "../webhooks/webhook-dead-letter.service";
import { JobExecutionService } from "./execution/job-execution.service";
import { workerIdentity } from "./execution/worker-identity";

/** Job identity recorded in the execution history for this job. */
const RECONCILER_JOB_NAME = "revocation_propagation_reconciler";
const RECONCILER_JOB_VERSION = "1";

/** Maximum number of revoked proofs reconciled per cycle, to bound execution time. */
const RECONCILE_BATCH_SIZE = 20;

/** Operator identity recorded on a system-initiated webhook redrive. */
const SYSTEM_OPERATOR_ID = "system:revocation-propagation-reconciler";
const REDRIVE_REASON = "revocation propagation reconciliation";

export type PropagationState = "confirmed" | "pending" | "remediated";

interface ChannelResult {
  state: PropagationState;
  /** Seconds since revocation, only meaningful when state is not "confirmed". */
  lagSeconds?: number;
}

/**
 * RevocationPropagationReconcilerService (#212)
 *
 * A proof's revocation is a single local write, but two downstream channels
 * learn about it asynchronously: the on-chain REVOKE anchoring intent (if the
 * proof was ever anchored) and the `proof.revoked` webhook delivery to each
 * subscribed endpoint. Either can lag or fail independently of the other and
 * independently of local state.
 *
 * This job does not duplicate either channel's own retry logic — the
 * anchoring reconciler already re-enqueues a REVOKE intent on disagreement,
 * and webhook deliveries already retry on their own schedule. What is
 * missing, and what this job adds, is the cross-channel view: for each
 * revoked proof, has *every* channel confirmed, and if not, how long has it
 * been pending and does the webhook channel need a nudge (a dead-lettered
 * `proof.revoked` delivery does not retry on its own; redriving it is the one
 * action this job takes).
 *
 * Runs every 5 minutes, batched and oldest-first so a backlog drains instead
 * of starving recently revoked proofs. A proof is reconciled only while
 * `revocationPropagationConfirmedAt` is null; once every channel is confirmed
 * (or not applicable) that field is set and the proof is never revisited,
 * bounding the job's work to the genuinely outstanding backlog.
 *
 * "Retries cannot restore an active state": this job only ever reads
 * `Proof.status` to select candidates and never writes it — the only writes
 * are `revocationPropagationConfirmedAt` (monotonic, REVOKED proofs only) and
 * a webhook redrive (which cannot touch proof state at all).
 *
 * Secret safety: only proof IDs and channel/state labels appear in structured
 * logs and metrics; no payload, URL, or credential is ever logged.
 */
@Injectable()
export class RevocationPropagationReconcilerService {
  private readonly logger = new StructuredLogger(
    RevocationPropagationReconcilerService.name,
  );
  private readonly anchoringEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly deadLetters: WebhookDeadLetterService,
    private readonly metrics: MetricsRegistry,
    config: ConfigService,
    @Optional() private readonly executions?: JobExecutionService,
  ) {
    this.anchoringEnabled =
      config.get<boolean>("contractAnchoring.enabled") ?? false;
  }

  @Interval(5 * 60_000)
  async reconcile(): Promise<void> {
    if (this.executions) {
      await this.executions.track(
        {
          jobName: RECONCILER_JOB_NAME,
          jobVersion: RECONCILER_JOB_VERSION,
          leaseOwner: workerIdentity(),
        },
        () => this.runReconcile(),
      );
      return;
    }

    await this.runReconcile();
  }

  private async runReconcile(): Promise<void> {
    const proofs = await this.prisma.proof.findMany({
      where: {
        status: ProofStatus.REVOKED,
        revocationPropagationConfirmedAt: null,
      },
      select: {
        id: true,
        userId: true,
        revokedAt: true,
        contractTransactionHash: true,
      },
      take: RECONCILE_BATCH_SIZE,
      orderBy: { revokedAt: "asc" },
    });

    for (const proof of proofs) {
      await this.reconcileProof(proof);
    }
  }

  /** Exposed for testing — reconciles a single proof by its persisted row. */
  async reconcileProof(proof: {
    id: string;
    userId: string;
    revokedAt: Date | null;
    contractTransactionHash: string | null;
  }): Promise<void> {
    const revokedAt = proof.revokedAt ?? new Date();

    const anchoring = await this.checkAnchoringChannel(proof);
    const webhook = await this.checkWebhookChannel(proof.id, revokedAt);

    this.recordChannel("anchoring", anchoring, revokedAt);
    this.recordChannel("webhook", webhook, revokedAt);

    if (anchoring.state === "confirmed" && webhook.state === "confirmed") {
      await this.prisma.proof.update({
        where: { id: proof.id },
        data: { revocationPropagationConfirmedAt: new Date() },
      });
      this.logger.log("Revocation propagation confirmed for proof", {
        proofId: proof.id,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Channel checks
  // ---------------------------------------------------------------------------

  private async checkAnchoringChannel(proof: {
    id: string;
    contractTransactionHash: string | null;
  }): Promise<ChannelResult> {
    if (!this.anchoringEnabled || !proof.contractTransactionHash) {
      // Never anchored (or anchoring disabled) — nothing to propagate here.
      return { state: "confirmed" };
    }

    const intent = await this.prisma.anchoringIntent.findUnique({
      where: {
        proofId_operation: {
          proofId: proof.id,
          operation: AnchoringOperation.REVOKE,
        },
      },
      select: { status: true },
    });

    if (intent?.status === AnchoringStatus.CONFIRMED) {
      return { state: "confirmed" };
    }

    // Missing, PENDING, PROCESSING, FAILED, or QUARANTINED: the anchoring
    // reconciler (and worker) own retrying this; we only observe and report.
    return { state: "pending" };
  }

  private async checkWebhookChannel(
    proofId: string,
    revokedAt: Date,
  ): Promise<ChannelResult> {
    const deliveries = await this.prisma.webhookDelivery.findMany({
      where: {
        eventType: "proof.revoked",
        payload: {
          path: ["data", "proofId"],
          equals: proofId,
        } as Prisma.JsonFilter<"WebhookDelivery">,
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        webhookId: true,
        status: true,
        deadLetteredAt: true,
        redrivenAt: true,
        createdAt: true,
        webhook: { select: { organizationId: true } },
      },
    });

    if (deliveries.length === 0) {
      // No endpoint was subscribed when this revocation fired — nothing to
      // propagate on this channel.
      return { state: "confirmed" };
    }

    // Latest row per webhook is the chain's current state: retries and
    // redrives share the same eventId but each lands its own row, newest
    // createdAt last within this ascending query.
    const latestByWebhook = new Map<string, (typeof deliveries)[number]>();
    for (const delivery of deliveries) {
      latestByWebhook.set(delivery.webhookId, delivery);
    }

    let remediated = false;
    let allConfirmed = true;

    for (const delivery of latestByWebhook.values()) {
      if (delivery.status === "SUCCESS") {
        continue;
      }

      allConfirmed = false;

      if (delivery.deadLetteredAt && !delivery.redrivenAt) {
        const result = await this.deadLetters.redrive(
          delivery.webhook.organizationId,
          delivery.id,
          SYSTEM_OPERATOR_ID,
          REDRIVE_REASON,
        );
        if (result.outcome === "redriven") {
          remediated = true;
          this.logger.warn(
            "Revocation propagation reconciler redrove a dead-lettered proof.revoked delivery",
            { proofId, outcome: "redriven" },
          );
        }
      }
      // Else: still PENDING or retrying on its own schedule — leave it.
    }

    if (allConfirmed) return { state: "confirmed" };
    return { state: remediated ? "remediated" : "pending", lagSeconds: this.lagSeconds(revokedAt) };
  }

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------

  private recordChannel(
    channel: "anchoring" | "webhook",
    result: ChannelResult,
    revokedAt: Date,
  ): void {
    this.metrics.increment(METRIC_NAMES.revocationPropagationChecksTotal, {
      channel,
      propagation_state: result.state,
    });

    if (result.state !== "confirmed") {
      this.metrics.observe(
        METRIC_NAMES.revocationPropagationLagSeconds,
        result.lagSeconds ?? this.lagSeconds(revokedAt),
        { channel },
      );
    }
  }

  private lagSeconds(revokedAt: Date): number {
    return Math.max(0, Math.floor((Date.now() - revokedAt.getTime()) / 1000));
  }
}
