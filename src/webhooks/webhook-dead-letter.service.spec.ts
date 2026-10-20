/* eslint-disable @typescript-eslint/no-unsafe-function-type */
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma, ResourceStatus, WebhookDeliveryStatus } from "@prisma/client";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { encryptProtectedAmount } from "../common/crypto/protected-amount";
import { RedriveDeadLetterDto, RedriveDeadLettersBatchDto } from "./dto/dead-letter.dto";
import { WebhookDeadLetterService, redriveKey } from "./webhook-dead-letter.service";
import { DeadLetterReason, WebhookDeliveryService } from "./webhook-delivery.service";
import { WebhookSigningService } from "./webhook-signing.service";
import { WebhooksController } from "./webhooks.controller";

// ---------------------------------------------------------------------------
// In-memory store: atomic conditional updates, a unique replayKey, and
// transactions that roll back every write when the callback throws.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string };
type Hook = { id: string; organizationId: string; status: ResourceStatus };

const ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const BODY = '{"specVersion":"1","id":"evt_1","event":"proof.created","schemaVersion":"1"}';

function cond(value: unknown, c: unknown): boolean {
  if (c === null) return value === null || value === undefined;
  if (c && typeof c === "object" && !(c instanceof Date)) {
    const o = c as Record<string, unknown>;
    if ("not" in o) return o.not === null ? value !== null && value !== undefined : value !== o.not;
    return false;
  }
  return value === c;
}

function buildStore(hooks: Hook[]) {
  let deliveries = new Map<string, Row>();
  let audit: Row[] = [];
  let seq = 0;
  const hookOf = (row: Row) => hooks.find((h) => h.id === row.webhookId)!;
  const whereMatch = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, c]) => {
      if (k === "webhook") {
        return (c as { organizationId: string }).organizationId === hookOf(row).organizationId;
      }
      return cond(row[k], c);
    });
  // Yield so concurrent callers genuinely interleave between statements.
  const tick = () => new Promise((r) => setImmediate(r));

  const webhookDelivery = {
    findUnique: jest.fn(async ({ where, include }: { where: { id?: string; replayKey?: string }; include?: unknown }) => {
      await tick();
      const row = where.id
        ? deliveries.get(where.id)
        : [...deliveries.values()].find((d) => d.replayKey === where.replayKey);
      if (!row) return null;
      return include ? { ...row, webhook: { ...hookOf(row) } } : { ...row };
    }),
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...deliveries.values()].find((d) => whereMatch(d, where)) ?? null),
    findMany: jest.fn(async ({ where, take, select }: { where: Record<string, unknown>; take?: number; select?: Record<string, unknown> }) => {
      const rows = [...deliveries.values()]
        .filter((d) => whereMatch(d, where))
        .map((d) => {
          const full: Record<string, unknown> = { ...d, webhook: { status: hookOf(d).status } };
          // Honour `select` so tests see exactly what the service projects.
          return select
            ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, full[k] ?? null]))
            : full;
        });
      return take ? rows.slice(0, take) : rows;
    }),
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      await tick();
      let count = 0;
      for (const row of deliveries.values()) {
        if (whereMatch(row, where)) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    }),
    create: jest.fn(async ({ data }: { data: Row }) => {
      await tick();
      if (data.replayKey && [...deliveries.values()].some((d) => d.replayKey === data.replayKey)) {
        throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });
      }
      const id = `new_${++seq}`;
      deliveries.set(id, { ...data, id, createdAt: new Date() });
      return { id };
    }),
  };

  const tx = {
    webhookDelivery,
    webhook: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const hook = hooks.find((h) => h.id === where.id);
        return hook ? { ...hook } : null;
      }),
    },
    auditLog: { create: jest.fn(async ({ data }: { data: Row }) => { audit.push(data); return data; }) },
  };

  const prisma = {
    ...tx,
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => {
      const snapshot = new Map([...deliveries].map(([k, v]) => [k, { ...v }]));
      const auditSnapshot = [...audit];
      try {
        return await fn(tx);
      } catch (error) {
        deliveries = snapshot;
        audit = auditSnapshot;
        throw error;
      }
    }),
  };

  return {
    prisma,
    hooks,
    get deliveries() { return deliveries; },
    get audit() { return audit; },
    add(row: Partial<Row> & { id: string }) {
      deliveries.set(row.id, {
        webhookId: "hook_a",
        eventType: "proof.created",
        eventId: "evt_1",
        payload: { id: "evt_1" },
        schemaVersion: "1",
        payloadBody: BODY,
        attempt: 5,
        status: WebhookDeliveryStatus.FAILED,
        deadLetteredAt: new Date("2026-09-01T00:00:00Z"),
        deadLetterReason: DeadLetterReason.MAX_ATTEMPTS_EXHAUSTED,
        redrivenAt: null,
        redrivenBy: null,
        replayKey: null,
        createdAt: new Date("2026-09-01T00:00:00Z"),
        ...row,
      });
    },
  };
}

function setup(hooks: Hook[] = [
  { id: "hook_a", organizationId: "org_a", status: ResourceStatus.ACTIVE },
  { id: "hook_b", organizationId: "org_b", status: ResourceStatus.ACTIVE },
], maxBatch = 25) {
  const store = buildStore(hooks);
  const delivery = { dispatch: jest.fn() };
  const service = new WebhookDeadLetterService(
    store.prisma as never,
    delivery as never,
    { get: jest.fn(() => maxBatch) } as never,
  );
  return { service, store, delivery };
}

describe("WebhookDeadLetterService", () => {
  describe("inspection", () => {
    it("lists only this organisation's pending dead letters, without payloads or URLs", async () => {
      const { service, store } = setup();
      store.add({ id: "dl_a" });
      store.add({ id: "dl_a_done", redrivenAt: new Date() });
      store.add({ id: "ok_a", deadLetteredAt: null, status: WebhookDeliveryStatus.SUCCESS });
      store.add({ id: "dl_b", webhookId: "hook_b" });

      const pending = await service.list("org_a", {});
      const all = await service.list("org_a", { state: "all" });

      expect(pending.data.map((d) => d.id)).toEqual(["dl_a"]);
      expect(pending.data[0]).toMatchObject({ redrivable: true, webhookStatus: "ACTIVE" });
      expect(all.data.map((d) => d.id).sort()).toEqual(["dl_a", "dl_a_done"]);
      expect(JSON.stringify(all)).not.toMatch(/payloadBody|specVersion|https?:/);
    });

    it("hides another organisation's dead letter as not found", async () => {
      const { service, store } = setup();
      store.add({ id: "dl_b", webhookId: "hook_b" });

      await expect(service.get("org_a", "dl_b")).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.get("org_b", "dl_b")).resolves.toMatchObject({ id: "dl_b" });
    });

    it("returns the event's attempt history in order", async () => {
      const { service, store } = setup();
      store.add({ id: "try_1", attempt: 1, deadLetteredAt: null, createdAt: new Date("2026-08-31T00:00:00Z") });
      store.add({ id: "dl_a", attempt: 2 });

      const detail = await service.get("org_a", "dl_a");

      expect(detail.history.map((h) => h.id)).toEqual(["try_1", "dl_a"]);
      expect(detail.redrive).toBeNull();
    });
  });

  describe("redrive", () => {
    it("creates a new delivery with the original event identity and bytes, preserving history", async () => {
      const { service, store, delivery } = setup();
      store.add({ id: "dl_a" });
      const before = { ...store.deliveries.get("dl_a")! };

      const result = await service.redrive("org_a", "dl_a", "op_1", "endpoint restored after outage");

      expect(result.outcome).toBe("redriven");
      const created = store.deliveries.get(result.redriveDeliveryId!)!;
      expect(created).toMatchObject({
        eventId: "evt_1",
        payloadBody: BODY,
        schemaVersion: "1",
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: "dl_a",
        replayedBy: "op_1",
        replayKey: redriveKey("dl_a"),
        redriveReason: "endpoint restored after outage",
      });
      // The dead letter keeps its attempt record; only redrive metadata is added.
      const after = store.deliveries.get("dl_a")!;
      expect({ ...after, redrivenAt: null, redrivenBy: null }).toEqual(before);
      expect(after.redrivenBy).toBe("op_1");
      expect(store.audit).toEqual([
        expect.objectContaining({
          action: "webhook.delivery.redriven",
          actorId: "op_1",
          metadata: expect.objectContaining({ reason: "endpoint restored after outage", eventId: "evt_1" }),
        }),
      ]);
      expect(delivery.dispatch).toHaveBeenCalledWith(result.redriveDeliveryId, "hook_a");
    });

    it("is idempotent: a repeat returns the same redrive delivery", async () => {
      const { service, store, delivery } = setup();
      store.add({ id: "dl_a" });

      const first = await service.redrive("org_a", "dl_a", "op_1", "first redrive reason");
      const second = await service.redrive("org_a", "dl_a", "op_2", "second redrive reason");

      expect(second).toEqual({ deliveryId: "dl_a", outcome: "already_redriven", redriveDeliveryId: first.redriveDeliveryId });
      expect(delivery.dispatch).toHaveBeenCalledTimes(1);
    });

    it("produces exactly one delivery under concurrent redrives", async () => {
      const { service, store, delivery } = setup();
      store.add({ id: "dl_a" });

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => service.redrive("org_a", "dl_a", `op_${i}`, "concurrent operator redrive")),
      );

      const winners = results.filter((r) => r.outcome === "redriven");
      expect(winners).toHaveLength(1);
      expect(results.filter((r) => r.outcome === "already_redriven")).toHaveLength(7);
      expect(new Set(results.map((r) => r.redriveDeliveryId))).toEqual(new Set([winners[0].redriveDeliveryId]));
      expect([...store.deliveries.values()].filter((d) => d.replayOf === "dl_a")).toHaveLength(1);
      expect(delivery.dispatch).toHaveBeenCalledTimes(1);
    });

    it.each([
      [ResourceStatus.SUSPENDED, "webhook_disabled"],
      [ResourceStatus.DELETED, "webhook_deleted"],
    ])("refuses a %s endpoint without changing anything", async (status, outcome) => {
      const { service, store, delivery } = setup([{ id: "hook_a", organizationId: "org_a", status }]);
      store.add({ id: "dl_a" });

      const result = await service.redrive("org_a", "dl_a", "op_1", "attempted while endpoint off");

      expect(result.outcome).toBe(outcome);
      expect(store.deliveries.size).toBe(1);
      expect(store.deliveries.get("dl_a")!.redrivenAt).toBeNull();
      expect(delivery.dispatch).not.toHaveBeenCalled();
    });

    it("rolls back the claim when the endpoint is disabled mid-redrive", async () => {
      const { service, store, delivery } = setup();
      store.add({ id: "dl_a" });
      store.prisma.webhook.findUnique.mockImplementationOnce(async () => ({ id: "hook_a", organizationId: "org_a", status: ResourceStatus.SUSPENDED }));

      const result = await service.redrive("org_a", "dl_a", "op_1", "race with disable");

      expect(result.outcome).toBe("webhook_disabled");
      expect(store.deliveries.get("dl_a")!.redrivenAt).toBeNull();
      expect(store.deliveries.size).toBe(1);
      expect(store.audit).toHaveLength(0);
      expect(delivery.dispatch).not.toHaveBeenCalled();
      // Re-enabled later, the same dead letter can still be redriven.
      await expect(service.redrive("org_a", "dl_a", "op_1", "retry after re-enable")).resolves.toMatchObject({ outcome: "redriven" });
    });

    it("cannot redrive another organisation's dead letter", async () => {
      const { service, store } = setup();
      store.add({ id: "dl_b", webhookId: "hook_b" });

      await expect(service.redrive("org_a", "dl_b", "op_1", "cross-tenant attempt")).resolves.toEqual({ deliveryId: "dl_b", outcome: "not_found" });
      expect(store.deliveries.get("dl_b")!.redrivenAt).toBeNull();
      expect(store.deliveries.size).toBe(1);
    });

    it("refuses a delivery that was never dead-lettered", async () => {
      const { service, store } = setup();
      store.add({ id: "ok_a", deadLetteredAt: null, status: WebhookDeliveryStatus.SUCCESS });

      await expect(service.redrive("org_a", "ok_a", "op_1", "not a dead letter")).resolves.toMatchObject({ outcome: "not_dead_lettered" });
      expect(store.deliveries.size).toBe(1);
    });
  });

  describe("batch redrive", () => {
    it("redrives each item independently and de-duplicates ids", async () => {
      const { service, store } = setup();
      store.add({ id: "dl_1", eventId: "evt_1" });
      store.add({ id: "dl_2", eventId: "evt_2" });
      store.add({ id: "dl_b", webhookId: "hook_b" });

      const result = await service.redriveBatch("org_a", ["dl_1", "dl_2", "dl_1", "dl_b", "missing"], "op_1", "batch after outage");

      expect(result.requested).toBe(4);
      expect(result.redriven).toBe(2);
      expect(result.results.map((r) => [r.deliveryId, r.outcome])).toEqual([
        ["dl_1", "redriven"],
        ["dl_2", "redriven"],
        ["dl_b", "not_found"],
        ["missing", "not_found"],
      ]);
    });

    it("enforces the configured batch bound at the boundary", async () => {
      const { service, store } = setup(undefined, 2);
      store.add({ id: "dl_1" });
      store.add({ id: "dl_2", eventId: "evt_2" });
      store.add({ id: "dl_3", eventId: "evt_3" });

      await expect(service.redriveBatch("org_a", ["dl_1", "dl_2"], "op_1", "exactly at the bound")).resolves.toMatchObject({ redriven: 2 });
      await expect(service.redriveBatch("org_a", ["dl_1", "dl_2", "dl_3"], "op_1", "one over the bound")).rejects.toBeInstanceOf(BadRequestException);
      expect(store.deliveries.get("dl_3")!.redrivenAt).toBeNull();
    });
  });
});

describe("redrive request validation", () => {
  it.each(["", "          ", "too short"])("rejects reason %j", async (reason) => {
    const dto = plainToInstance(RedriveDeadLetterDto, { reason });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it("accepts a real reason and trims it", async () => {
    const dto = plainToInstance(RedriveDeadLetterDto, { reason: "  customer endpoint restored  " });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.reason).toBe("customer endpoint restored");
  });

  it("rejects an empty or oversized batch", async () => {
    for (const deliveryIds of [[], Array.from({ length: 101 }, (_, i) => `d${i}`)]) {
      const dto = plainToInstance(RedriveDeadLettersBatchDto, { deliveryIds, reason: "valid operator reason" });
      expect(await validate(dto)).not.toHaveLength(0);
    }
  });
});

describe("dead-letter endpoints authorization", () => {
  function controller(role: string) {
    const deadLetters = {
      list: jest.fn().mockResolvedValue({ data: [] }),
      get: jest.fn(),
      redrive: jest.fn().mockResolvedValue({ deliveryId: "x", outcome: "not_found" }),
      redriveBatch: jest.fn(),
    };
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue({ organizations: [{ id: "org_a" }] }) } };
    const ctrl = new WebhooksController({} as never, deadLetters as never, prisma as never);
    const user = { id: "u1", walletAddress: "G", walletHash: "h", role };
    return { ctrl, deadLetters, user };
  }

  it("refuses non-operator roles for inspection and redrive", async () => {
    const { ctrl, deadLetters, user } = controller("WORKER");
    await expect(ctrl.listDeadLetters(user, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctrl.getDeadLetter(user, "x")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctrl.redriveDeadLetter(user, "x", { reason: "valid operator reason" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctrl.redriveDeadLetters(user, { deliveryIds: ["x"], reason: "valid operator reason" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(deadLetters.list).not.toHaveBeenCalled();
    expect(deadLetters.redrive).not.toHaveBeenCalled();
  });

  it("scopes operators to their own organisation and maps not_found to 404", async () => {
    const { ctrl, deadLetters, user } = controller("DEVELOPER");
    await ctrl.listDeadLetters(user, {});
    expect(deadLetters.list).toHaveBeenCalledWith("org_a", {});
    await expect(ctrl.redriveDeadLetter(user, "x", { reason: "valid operator reason" })).rejects.toBeInstanceOf(NotFoundException);
    expect(deadLetters.redrive).toHaveBeenCalledWith("org_a", "x", "u1", "valid operator reason");
  });

  it("declares dead-letter routes before the :id routes (route shadowing regression)", () => {
    const names = Object.getOwnPropertyNames(WebhooksController.prototype);
    expect(names.indexOf("listDeadLetters")).toBeLessThan(names.indexOf("get"));
    expect(names.indexOf("getDeadLetter")).toBeLessThan(names.indexOf("get"));
  });
});

// ---------------------------------------------------------------------------
// Dead-lettering in the delivery worker
// ---------------------------------------------------------------------------

describe("WebhookDeliveryService dead-lettering", () => {
  function worker(opts: { maxAttempts?: number; hookStatus?: string; url?: string } = {}) {
    const rows = new Map<string, Row>();
    const secretEncrypted = encryptProtectedAmount("secret", ENCRYPTION_KEY);
    const prisma = {
      webhookDelivery: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
          const row = rows.get(where.id);
          return row ? { ...row, webhook: { id: "hook_a", url: opts.url ?? "https://example.com/hook", secretEncrypted, status: opts.hookStatus ?? "ACTIVE" } } : null;
        }),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
          rows.set(where.id, { ...rows.get(where.id)!, ...data });
          return rows.get(where.id);
        }),
        create: jest.fn(async ({ data }: { data: Row }) => {
          const id = `retry_${rows.size}`;
          rows.set(id, { ...data, id });
          return { id };
        }),
      },
    };
    const config = {
      getOrThrow: () => ENCRYPTION_KEY,
      get: (key: string) => (key === "webhooks.maxDeliveryAttempts" ? opts.maxAttempts : undefined),
    };
    const service = new WebhookDeliveryService(prisma as never, new WebhookSigningService(), config as never);
    (service as unknown as { scheduleDelivery: () => void }).scheduleDelivery = jest.fn();
    const run = (id: string) => (service as unknown as { runDelivery: Function }).runDelivery(id);
    const add = (id: string, attempt: number, status: WebhookDeliveryStatus = WebhookDeliveryStatus.PENDING) =>
      rows.set(id, { id, webhookId: "hook_a", eventType: "proof.created", eventId: "evt_1", payload: {}, schemaVersion: "1", payloadBody: BODY, attempt, status, replayOf: null });
    return { rows, run, add, service };
  }

  const failingFetch = () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  };

  it("uses the default threshold of 5 attempts", () => {
    expect(worker().service.maxDeliveryAttempts).toBe(5);
  });

  it("retries below the configured threshold and dead-letters at it", async () => {
    const { rows, run, add } = worker({ maxAttempts: 3 });
    failingFetch();
    add("d2", 2);
    add("d3", 3);

    await run("d2");
    await run("d3");

    expect(rows.get("d2")!.deadLetteredAt).toBeUndefined();
    expect([...rows.values()].some((r) => r.attempt === 3 && r.id !== "d3")).toBe(true);
    expect(rows.get("d3")).toMatchObject({
      status: WebhookDeliveryStatus.FAILED,
      deadLetterReason: DeadLetterReason.MAX_ATTEMPTS_EXHAUSTED,
      statusCode: 500,
    });
    expect(rows.get("d3")!.deadLetteredAt).toBeInstanceOf(Date);
    expect([...rows.values()].some((r) => r.attempt === 4)).toBe(false);
  });

  it("never dispatches a row already beyond the threshold", async () => {
    const { rows, run, add } = worker({ maxAttempts: 3 });
    const fetchMock = failingFetch();
    add("d5", 5);

    await run("d5");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows.get("d5")!.deadLetterReason).toBe(DeadLetterReason.MAX_ATTEMPTS_EXHAUSTED);
  });

  it.each([
    [{ hookStatus: "SUSPENDED" }, DeadLetterReason.ENDPOINT_DISABLED],
    [{ hookStatus: "DELETED" }, DeadLetterReason.ENDPOINT_DISABLED],
    [{ url: "https://127.0.0.1/hook" }, DeadLetterReason.DESTINATION_BLOCKED],
  ])("dead-letters terminal failures (%j)", async (opts, reason) => {
    const { rows, run, add } = worker(opts);
    const fetchMock = failingFetch();
    add("d1", 1);

    await run("d1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows.get("d1")!.deadLetterReason).toBe(reason);
    expect(rows.size).toBe(1);
  });

  it("does not re-send a row that is no longer PENDING", async () => {
    const { rows, run, add } = worker();
    const fetchMock = failingFetch();
    add("d1", 1, WebhookDeliveryStatus.SUCCESS);

    await run("d1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows.get("d1")!.status).toBe(WebhookDeliveryStatus.SUCCESS);
  });
});
