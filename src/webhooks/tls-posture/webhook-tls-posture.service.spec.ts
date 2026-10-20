import { ConflictException, ForbiddenException, HttpException, NotFoundException } from "@nestjs/common";
import { WebhookTlsProbe, WebhookTlsProbeOutcome } from "@prisma/client";
import { AuthenticatedUser } from "../../auth/auth.types";
import { Clock } from "../../common/time/clock";
import { PrismaService } from "../../database/prisma.service";
import { TlsProbeResult } from "./tls-probe";
import {
  TLS_ON_DEMAND_COOLDOWN_MS,
  TLS_POSTURE_STALE_AFTER_MS,
  TLS_PROBE_BATCH_SIZE,
  TLS_PROBE_HISTORY_LIMIT,
  TLS_PROBE_INTERVAL_MS,
  WebhookTlsPostureService,
} from "./webhook-tls-posture.service";

const T0 = new Date("2026-10-17T00:00:00.000Z");

class TestClock extends Clock {
  constructor(public current: Date) {
    super();
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const user = (id: string, role: "ADMIN" | "WORKER" = "WORKER") =>
  ({ id, role, walletAddress: `G-${id}`, walletHash: `h-${id}` }) as AuthenticatedUser;
const platformAdmin = user("platform", "ADMIN");
const orgAdmin = user("org-admin");
const viewer = user("viewer");
const outsider = user("outsider");

interface FakeWebhook {
  id: string;
  url: string;
  status: string;
  organizationId: string;
}

function result(outcome: WebhookTlsProbeOutcome): TlsProbeResult {
  return {
    outcome,
    protocol: "TLSv1.3",
    certificateNotBefore: null,
    certificateNotAfter: null,
    certificateFingerprint: null,
    durationMs: 12,
  };
}

function setup(webhooks: FakeWebhook[] = [
  { id: "wh-1", url: "https://hooks.example.com/a", status: "ACTIVE", organizationId: "org-1" },
]) {
  const clock = new TestClock(T0);
  const probes: WebhookTlsProbe[] = [];
  let nextId = 1;
  const memberships: Record<string, { role: string; status: string }> = {
    "org-admin": { role: "ADMIN", status: "ACTIVE" },
    viewer: { role: "VIEWER", status: "ACTIVE" },
  };
  const byWebhook = (webhookId: string) =>
    probes
      .filter((probe) => probe.webhookId === webhookId)
      .sort((a, b) => b.probedAt.getTime() - a.probedAt.getTime());

  const prisma = {
    organizationMember: {
      findUnique: jest.fn(async ({ where }: { where: { organizationId_userId: { userId: string } } }) =>
        memberships[where.organizationId_userId.userId] ?? null,
      ),
    },
    webhook: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => webhooks.find((w) => w.id === where.id) ?? null),
      findMany: jest.fn(async (args: { where: Record<string, unknown>; take: number }) => {
        if ("tlsProbes" in args.where) {
          const dueBefore = (args.where.tlsProbes as { none: { probedAt: { gt: Date } } }).none.probedAt.gt;
          return webhooks
            .filter((w) => w.status === "ACTIVE")
            .filter((w) => !byWebhook(w.id).some((probe) => probe.probedAt > dueBefore))
            .slice(0, args.take)
            .map(({ id, url }) => ({ id, url }));
        }
        return webhooks
          .filter((w) => w.organizationId === args.where.organizationId)
          .slice(0, args.take)
          .map((w) => ({ id: w.id, tlsProbes: byWebhook(w.id).slice(0, 1) }));
      }),
    },
    webhookTlsProbe: {
      findFirst: jest.fn(async ({ where }: { where: { webhookId: string; probedAt?: { lt: Date } } }) =>
        byWebhook(where.webhookId).find((probe) => !where.probedAt || probe.probedAt < where.probedAt.lt) ?? null,
      ),
      findMany: jest.fn(async ({ where, take, skip = 0 }: { where: { webhookId: string }; take?: number; skip?: number }) =>
        byWebhook(where.webhookId).slice(skip, take === undefined ? undefined : skip + take),
      ),
      create: jest.fn(async ({ data }: { data: Omit<WebhookTlsProbe, "id"> }) => {
        const probe = { ...data, id: `probe-${nextId++}` } as WebhookTlsProbe;
        probes.push(probe);
        return probe;
      }),
      deleteMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        const before = probes.length;
        for (const id of where.id.in) probes.splice(probes.findIndex((probe) => probe.id === id), 1);
        return { count: before - probes.length };
      }),
    },
  };

  const outcomes: WebhookTlsProbeOutcome[] = [];
  const prober = jest.fn(async () => result(outcomes.shift() ?? "HEALTHY"));
  const service = new WebhookTlsPostureService(prisma as unknown as PrismaService, clock, prober);
  return { service, clock, probes, prisma, prober, outcomes };
}

describe("WebhookTlsPostureService", () => {
  beforeEach(() => jest.spyOn(console, "warn").mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  describe("scheduled probes", () => {
    it("probes due ACTIVE webhooks and skips them until the interval passes", async () => {
      const { service, clock, prober } = setup([
        { id: "wh-1", url: "https://a.example.com/", status: "ACTIVE", organizationId: "org-1" },
        { id: "wh-2", url: "https://b.example.com/", status: "DISABLED", organizationId: "org-1" },
      ]);

      await expect(service.runScheduledProbes()).resolves.toMatchObject({ probed: 1, failed: 0 });
      expect(prober).toHaveBeenCalledWith("https://a.example.com/");

      clock.advance(TLS_PROBE_INTERVAL_MS - 1);
      await expect(service.runScheduledProbes()).resolves.toMatchObject({ probed: 0 });

      clock.advance(1);
      await expect(service.runScheduledProbes()).resolves.toMatchObject({ probed: 1 });
    });

    it("bounds each run to one batch", async () => {
      const many = Array.from({ length: TLS_PROBE_BATCH_SIZE + 5 }, (_, index) => ({
        id: `wh-${String(index).padStart(3, "0")}`,
        url: `https://h${index}.example.com/`,
        status: "ACTIVE",
        organizationId: "org-1",
      }));
      const { service, prober } = setup(many);

      await expect(service.runScheduledProbes()).resolves.toMatchObject({ probed: TLS_PROBE_BATCH_SIZE });
      expect(prober).toHaveBeenCalledTimes(TLS_PROBE_BATCH_SIZE);
    });

    it("skips a run that overlaps one in progress", async () => {
      const { service, prober } = setup();
      let release!: () => void;
      prober.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve(result("HEALTHY")))),
      );

      const first = service.runScheduledProbes();
      await new Promise((resolve) => setImmediate(resolve));
      await expect(service.runScheduledProbes()).resolves.toEqual({ skipped: true, probed: 0, failed: 0, alerts: 0 });
      release();
      await expect(first).resolves.toMatchObject({ skipped: false, probed: 1 });
    });

    it("isolates a failing endpoint from the rest of the batch", async () => {
      const { service, prober } = setup([
        { id: "wh-1", url: "https://a.example.com/", status: "ACTIVE", organizationId: "org-1" },
        { id: "wh-2", url: "https://b.example.com/", status: "ACTIVE", organizationId: "org-1" },
      ]);
      prober.mockRejectedValueOnce(new Error("boom"));

      await expect(service.runScheduledProbes()).resolves.toMatchObject({ probed: 1, failed: 1 });
    });
  });

  describe("alerts", () => {
    it("alerts once per transition into a non-healthy outcome", async () => {
      const { service, clock, probes, outcomes } = setup();
      outcomes.push("HEALTHY", "EXPIRING_SOON", "EXPIRING_SOON", "EXPIRED", "HEALTHY", "UNTRUSTED");

      for (let run = 0; run < 6; run += 1) {
        await service.runScheduledProbes();
        clock.advance(TLS_PROBE_INTERVAL_MS);
      }

      const chronological = [...probes].sort((a, b) => a.probedAt.getTime() - b.probedAt.getTime());
      expect(chronological.map((probe) => [probe.outcome, probe.alerted])).toEqual([
        ["HEALTHY", false],
        ["EXPIRING_SOON", true],
        ["EXPIRING_SOON", false],
        ["EXPIRED", true],
        ["HEALTHY", false],
        ["UNTRUSTED", true],
      ]);
    });

    it("alerts on the first probe when the endpoint is already unhealthy", async () => {
      const { service, probes, outcomes } = setup();
      outcomes.push("HOSTNAME_MISMATCH");

      await service.runScheduledProbes();
      expect(probes[0]).toMatchObject({ outcome: "HOSTNAME_MISMATCH", alerted: true });
    });
  });

  it("keeps a bounded probe history per webhook", async () => {
    const { service, clock, probes } = setup();

    for (let run = 0; run < TLS_PROBE_HISTORY_LIMIT + 3; run += 1) {
      await service.runScheduledProbes();
      clock.advance(TLS_PROBE_INTERVAL_MS);
    }

    expect(probes).toHaveLength(TLS_PROBE_HISTORY_LIMIT);
    expect(Math.min(...probes.map((probe) => probe.probedAt.getTime()))).toBe(
      T0.getTime() + 3 * TLS_PROBE_INTERVAL_MS,
    );
  });

  describe("on-demand probe", () => {
    it("requires the organization ADMIN role", async () => {
      const { service } = setup();

      await expect(service.probeNow(viewer, "org-1", "wh-1")).rejects.toThrow(ForbiddenException);
      await expect(service.probeNow(outsider, "org-1", "wh-1")).rejects.toThrow(ForbiddenException);
      await expect(service.probeNow(orgAdmin, "org-1", "wh-1")).resolves.toMatchObject({ outcome: "HEALTHY" });
    });

    it("does not reveal another organization's webhook", async () => {
      const { service } = setup();
      await expect(service.probeNow(platformAdmin, "org-2", "wh-1")).rejects.toThrow(NotFoundException);
    });

    it("refuses an inactive webhook", async () => {
      const { service } = setup([
        { id: "wh-1", url: "https://a.example.com/", status: "DISABLED", organizationId: "org-1" },
      ]);
      await expect(service.probeNow(orgAdmin, "org-1", "wh-1")).rejects.toThrow(ConflictException);
    });

    it("enforces the cooldown up to its exact boundary", async () => {
      const { service, clock } = setup();
      await service.probeNow(orgAdmin, "org-1", "wh-1");

      clock.advance(TLS_ON_DEMAND_COOLDOWN_MS - 1);
      const error = await service.probeNow(orgAdmin, "org-1", "wh-1").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);

      clock.advance(1);
      await expect(service.probeNow(orgAdmin, "org-1", "wh-1")).resolves.toMatchObject({ outcome: "HEALTHY" });
    });

    it("never exposes probe or webhook row identifiers in the result", async () => {
      const { service } = setup();
      const probe = await service.probeNow(orgAdmin, "org-1", "wh-1");
      expect(probe).not.toHaveProperty("id");
      expect(probe).not.toHaveProperty("webhookId");
    });
  });

  describe("posture queries", () => {
    it("reports UNKNOWN and stale before any probe", async () => {
      const { service } = setup();

      await expect(service.getPosture(viewer, "org-1", "wh-1")).resolves.toMatchObject({
        status: "UNKNOWN",
        healthy: false,
        stale: true,
        latest: null,
        history: [],
      });
    });

    it("marks posture stale strictly after the stale window", async () => {
      const { service, clock } = setup();
      await service.runScheduledProbes();

      clock.advance(TLS_POSTURE_STALE_AFTER_MS);
      await expect(service.getPosture(viewer, "org-1", "wh-1")).resolves.toMatchObject({
        status: "HEALTHY",
        stale: false,
      });

      clock.advance(1);
      await expect(service.getPosture(viewer, "org-1", "wh-1")).resolves.toMatchObject({ stale: true });
    });

    it("lists the latest posture for each organization webhook", async () => {
      const { service, outcomes } = setup([
        { id: "wh-1", url: "https://a.example.com/", status: "ACTIVE", organizationId: "org-1" },
        { id: "wh-2", url: "https://b.example.com/", status: "ACTIVE", organizationId: "org-1" },
        { id: "wh-3", url: "https://c.example.com/", status: "ACTIVE", organizationId: "org-2" },
      ]);
      outcomes.push("HEALTHY", "EXPIRED");
      await service.runScheduledProbes();

      const listed = await service.listPosture(viewer, "org-1");
      expect(listed.truncated).toBe(false);
      expect(listed.items.map((item) => [item.webhookId, item.status])).toEqual([
        ["wh-1", "HEALTHY"],
        ["wh-2", "EXPIRED"],
      ]);
    });

    it("requires organization membership to read", async () => {
      const { service } = setup();
      await expect(service.listPosture(outsider, "org-1")).rejects.toThrow(ForbiddenException);
      await expect(service.getPosture(outsider, "org-1", "wh-1")).rejects.toThrow(ForbiddenException);
    });
  });
});
