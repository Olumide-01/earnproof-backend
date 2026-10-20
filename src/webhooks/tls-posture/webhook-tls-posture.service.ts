import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { OrganizationMemberRole, WebhookTlsProbe, WebhookTlsProbeOutcome } from "@prisma/client";
import { AuthenticatedUser } from "../../auth/auth.types";
import { Clock, SystemClock } from "../../common/time/clock";
import { PrismaService } from "../../database/prisma.service";
import { probeTlsEndpoint, TlsProbeResult } from "./tls-probe";

/** Probe rows kept per webhook. Older rows are pruned after each probe. */
export const TLS_PROBE_HISTORY_LIMIT = 20;
/** A webhook is due for a scheduled probe once its latest probe is this old. */
export const TLS_PROBE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
/** Posture older than this is reported as stale. */
export const TLS_POSTURE_STALE_AFTER_MS = 2 * TLS_PROBE_INTERVAL_MS;
/** Minimum gap between probes of one webhook when probing on demand. */
export const TLS_ON_DEMAND_COOLDOWN_MS = 60 * 1_000;
/** Webhooks probed per scheduled run, and how many at once. */
export const TLS_PROBE_BATCH_SIZE = 25;
export const TLS_PROBE_CONCURRENCY = 5;
/** Webhooks listed per organization posture query. */
export const TLS_POSTURE_LIST_LIMIT = 100;

/** DI token for the probe function, so tests can replace the network. */
export const WEBHOOK_TLS_PROBER = "WEBHOOK_TLS_PROBER";
export type WebhookTlsProber = (url: string) => Promise<TlsProbeResult>;

const ROLE_RANK: Record<OrganizationMemberRole, number> = { OWNER: 4, ADMIN: 3, MEMBER: 2, VIEWER: 1 };

export type TlsPostureStatus = WebhookTlsProbeOutcome | "UNKNOWN";

export type TlsProbeView = Omit<WebhookTlsProbe, "id" | "webhookId">;

export interface WebhookTlsPostureView {
  webhookId: string;
  status: TlsPostureStatus;
  healthy: boolean;
  /** True when there is no probe, or the latest is older than the stale window. */
  stale: boolean;
  lastProbedAt: Date | null;
  latest: TlsProbeView | null;
}

export interface ScheduledProbeRun {
  skipped: boolean;
  probed: number;
  failed: number;
  alerts: number;
}

/**
 * Scheduled and on-demand TLS posture monitoring for webhook endpoints (#315).
 *
 * Authorization: reads need an ACTIVE organization membership (any role);
 * an on-demand probe needs ADMIN or OWNER. Platform ADMINs pass both. A
 * webhook in another organization is reported as not found.
 *
 * Alerts fire on transitions only: a probe raises one when its outcome is not
 * HEALTHY and differs from the previous probe's outcome, so a persistently
 * broken endpoint alerts once, not on every run.
 *
 * Ordering: `probedAt` is the probe's start time and "previous" means the
 * latest probe started before it. A slow probe finishing after a newer one
 * neither replaces the newer result as latest nor double-alerts against it.
 */
@Injectable()
export class WebhookTlsPostureService {
  private readonly logger = new Logger(WebhookTlsPostureService.name);
  private running = false;
  private readonly prober: WebhookTlsProber;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly clock: Clock = new SystemClock(),
    @Optional() @Inject(WEBHOOK_TLS_PROBER) prober?: WebhookTlsProber,
  ) {
    this.prober = prober ?? ((url) => probeTlsEndpoint(url, { now: () => this.clock.now() }));
  }

  /** Probes a batch of due ACTIVE webhooks. Overlapping runs are skipped. */
  async runScheduledProbes(): Promise<ScheduledProbeRun> {
    if (this.running) return { skipped: true, probed: 0, failed: 0, alerts: 0 };
    this.running = true;

    try {
      const dueBefore = new Date(this.clock.nowMs() - TLS_PROBE_INTERVAL_MS);
      const due = await this.prisma.webhook.findMany({
        // Due once the latest probe is at least one interval old (boundary inclusive).
        where: { status: "ACTIVE", tlsProbes: { none: { probedAt: { gt: dueBefore } } } },
        select: { id: true, url: true },
        orderBy: { id: "asc" },
        take: TLS_PROBE_BATCH_SIZE,
      });

      const run: ScheduledProbeRun = { skipped: false, probed: 0, failed: 0, alerts: 0 };
      for (let index = 0; index < due.length; index += TLS_PROBE_CONCURRENCY) {
        const slice = due.slice(index, index + TLS_PROBE_CONCURRENCY);
        const outcomes = await Promise.allSettled(slice.map((webhook) => this.probeAndRecord(webhook)));
        for (const outcome of outcomes) {
          if (outcome.status === "fulfilled") {
            run.probed += 1;
            if (outcome.value.alerted) run.alerts += 1;
          } else {
            // One endpoint failing to persist must not stop the batch.
            run.failed += 1;
          }
        }
      }
      return run;
    } finally {
      this.running = false;
    }
  }

  async probeNow(
    user: AuthenticatedUser,
    organizationId: string,
    webhookId: string,
  ): Promise<TlsProbeView> {
    await this.authorize(user, organizationId, "ADMIN");
    const webhook = await this.ownedWebhook(organizationId, webhookId);

    if (webhook.status !== "ACTIVE") {
      throw new ConflictException("Only ACTIVE webhooks can be probed.");
    }

    const latest = await this.latestProbe(webhookId);
    if (latest && this.clock.nowMs() - latest.probedAt.getTime() < TLS_ON_DEMAND_COOLDOWN_MS) {
      throw new HttpException(
        `This webhook was probed less than ${TLS_ON_DEMAND_COOLDOWN_MS / 1_000} seconds ago.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return toProbeView(await this.probeAndRecord(webhook));
  }

  async getPosture(
    user: AuthenticatedUser,
    organizationId: string,
    webhookId: string,
  ): Promise<WebhookTlsPostureView & { history: TlsProbeView[] }> {
    await this.authorize(user, organizationId, "VIEWER");
    await this.ownedWebhook(organizationId, webhookId);

    const probes = await this.prisma.webhookTlsProbe.findMany({
      where: { webhookId },
      orderBy: { probedAt: "desc" },
      take: TLS_PROBE_HISTORY_LIMIT,
    });

    return { ...this.posture(webhookId, probes[0] ?? null), history: probes.map(toProbeView) };
  }

  async listPosture(
    user: AuthenticatedUser,
    organizationId: string,
  ): Promise<{ items: WebhookTlsPostureView[]; truncated: boolean }> {
    await this.authorize(user, organizationId, "VIEWER");

    const webhooks = await this.prisma.webhook.findMany({
      where: { organizationId },
      select: { id: true, tlsProbes: { orderBy: { probedAt: "desc" }, take: 1 } },
      orderBy: { id: "asc" },
      take: TLS_POSTURE_LIST_LIMIT + 1,
    });

    return {
      items: webhooks
        .slice(0, TLS_POSTURE_LIST_LIMIT)
        .map((webhook) => this.posture(webhook.id, webhook.tlsProbes[0] ?? null)),
      truncated: webhooks.length > TLS_POSTURE_LIST_LIMIT,
    };
  }

  /** Probes one endpoint, stores the result, alerts on transition, prunes history. */
  private async probeAndRecord(webhook: { id: string; url: string }): Promise<WebhookTlsProbe> {
    const probedAt = this.clock.now();
    const result = await this.prober(webhook.url);

    const previous = await this.prisma.webhookTlsProbe.findFirst({
      where: { webhookId: webhook.id, probedAt: { lt: probedAt } },
      orderBy: { probedAt: "desc" },
      select: { outcome: true },
    });
    const alerted = result.outcome !== "HEALTHY" && previous?.outcome !== result.outcome;

    const probe = await this.prisma.webhookTlsProbe.create({
      data: { webhookId: webhook.id, ...result, alerted, probedAt },
    });

    if (alerted) {
      // Identifier and category only: never the URL, host or resolved address.
      this.logger.warn(`Webhook ${webhook.id} TLS posture is ${result.outcome}`);
    }

    const overflow = await this.prisma.webhookTlsProbe.findMany({
      where: { webhookId: webhook.id },
      orderBy: { probedAt: "desc" },
      skip: TLS_PROBE_HISTORY_LIMIT,
      select: { id: true },
    });
    if (overflow.length > 0) {
      await this.prisma.webhookTlsProbe.deleteMany({
        where: { id: { in: overflow.map((row) => row.id) } },
      });
    }

    return probe;
  }

  private posture(webhookId: string, latest: WebhookTlsProbe | null): WebhookTlsPostureView {
    return {
      webhookId,
      status: latest?.outcome ?? "UNKNOWN",
      healthy: latest?.outcome === "HEALTHY",
      stale: !latest || this.clock.nowMs() - latest.probedAt.getTime() > TLS_POSTURE_STALE_AFTER_MS,
      lastProbedAt: latest?.probedAt ?? null,
      latest: latest ? toProbeView(latest) : null,
    };
  }

  private latestProbe(webhookId: string) {
    return this.prisma.webhookTlsProbe.findFirst({
      where: { webhookId },
      orderBy: { probedAt: "desc" },
      select: { probedAt: true },
    });
  }

  private async ownedWebhook(organizationId: string, webhookId: string) {
    const webhook = await this.prisma.webhook.findUnique({
      where: { id: webhookId },
      select: { id: true, url: true, status: true, organizationId: true },
    });
    // Another organization's webhook is indistinguishable from a missing one.
    if (!webhook || webhook.organizationId !== organizationId) {
      throw new NotFoundException(`Webhook ${webhookId} not found`);
    }
    return webhook;
  }

  private async authorize(
    user: AuthenticatedUser,
    organizationId: string,
    minimum: OrganizationMemberRole,
  ): Promise<void> {
    if (user.role === "ADMIN") return;

    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: user.id } },
      select: { role: true, status: true },
    });

    if (!membership || membership.status !== "ACTIVE") {
      throw new ForbiddenException("You are not a member of this organization");
    }
    if (ROLE_RANK[membership.role] < ROLE_RANK[minimum]) {
      throw new ForbiddenException(`This action requires the ${minimum} organization role`);
    }
  }
}

function toProbeView(probe: WebhookTlsProbe): TlsProbeView {
  const { id, webhookId, ...view } = probe;
  void id;
  void webhookId;
  return view;
}
