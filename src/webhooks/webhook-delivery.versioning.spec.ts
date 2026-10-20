/* eslint-disable @typescript-eslint/no-unsafe-function-type */
import { WebhookDeliveryStatus } from "@prisma/client";
import { encryptProtectedAmount } from "../common/crypto/protected-amount";
import {
  V1_FIXTURE_SOURCES,
} from "./fixtures/v1-sources";
import { WebhookDeliveryService } from "./webhook-delivery.service";
import { WEBHOOK_PAYLOAD_REGISTRY } from "./webhook-payload.serializers";
import { WebhookSigningService } from "./webhook-signing.service";

/**
 * Delivery-side guarantees for versioned payloads (#158):
 * - one stable event id per domain event, shared by every endpoint;
 * - each endpoint gets the version it is pinned to;
 * - the serialized bytes are persisted once and every retry sends them
 *   unchanged, with the original schema version.
 */

const ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

function makeConfig() {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === "paymentEncryptionKey") return ENCRYPTION_KEY;
      throw new Error(`Unexpected config key: ${key}`);
    }),
    get: jest.fn(() => undefined),
  };
}

type Row = Record<string, unknown>;

function buildHarness(
  webhooks: Array<{ id: string; events: string[]; payloadVersion: string }>,
) {
  const rows = new Map<string, Row>();
  let seq = 0;
  const secretEncrypted = encryptProtectedAmount("secret", ENCRYPTION_KEY);
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ organizations: [{ id: "org_1" }] }),
    },
    webhook: { findMany: jest.fn().mockResolvedValue(webhooks) },
    webhookDelivery: {
      create: jest.fn(({ data }: { data: Row }) => {
        const id = `d_${++seq}`;
        rows.set(id, { ...data, id });
        return Promise.resolve({ id });
      }),
      update: jest.fn(({ where, data }: { where: { id: string }; data: Row }) => {
        rows.set(where.id, { ...rows.get(where.id), ...data });
        return Promise.resolve(rows.get(where.id));
      }),
      findUnique: jest.fn(({ where }: { where: { id: string } }) => {
        const row = rows.get(where.id);
        return Promise.resolve(
          row
            ? {
                ...row,
                webhook: {
                  id: row.webhookId,
                  url: "https://example.com/hook",
                  secretEncrypted,
                  status: "ACTIVE",
                },
              }
            : null,
        );
      }),
    },
  };
  const service = new WebhookDeliveryService(
    prisma as never,
    new WebhookSigningService(),
    makeConfig() as never,
  );
  // Scheduling is exercised elsewhere; here we drive attempts explicitly.
  (service as unknown as { scheduleDelivery: () => void }).scheduleDelivery =
    jest.fn();
  return { service, rows, prisma };
}

describe("versioned webhook delivery", () => {
  afterEach(() => jest.restoreAllMocks());

  it("gives every subscribed endpoint the same stable event id and persists exact bytes", async () => {
    const { service, rows } = buildHarness([
      { id: "hook_a", events: ["proof.revoked"], payloadVersion: "1" },
      { id: "hook_b", events: ["proof.revoked"], payloadVersion: "1" },
      { id: "hook_c", events: ["proof.created"], payloadVersion: "1" },
    ]);

    await service.enqueueForUser("user_1", {
      event: "proof.revoked",
      source: V1_FIXTURE_SOURCES["proof.revoked"],
    });

    const created = [...rows.values()];
    expect(created).toHaveLength(2); // hook_c is not subscribed
    const [a, b] = created;
    expect(a.eventId).toBe(b.eventId);
    for (const row of created) {
      expect(row.schemaVersion).toBe("1");
      const parsed = JSON.parse(row.payloadBody as string);
      expect(parsed.id).toBe(row.eventId);
      expect(parsed.schemaVersion).toBe("1");
      expect(parsed.data).toEqual({
        proofId: V1_FIXTURE_SOURCES["proof.revoked"].proofId,
        status: "REVOKED",
        revokedAt: "2026-09-02T08:30:00.000Z",
      });
    }
  });

  it("skips (fails closed) an endpoint pinned to an unsupported version", async () => {
    const { service, rows } = buildHarness([
      { id: "hook_old", events: ["proof.verified"], payloadVersion: "0" },
      { id: "hook_ok", events: ["proof.verified"], payloadVersion: "1" },
    ]);

    await service.enqueueForUser("user_1", {
      event: "proof.verified",
      source: V1_FIXTURE_SOURCES["proof.verified"],
    });

    expect([...rows.values()].map((r) => r.webhookId)).toEqual(["hook_ok"]);
  });

  it("sends identical bytes and schema version on every retry attempt", async () => {
    const { service, rows } = buildHarness([
      { id: "hook_a", events: ["proof.created"], payloadVersion: "1" },
    ]);
    await service.enqueueForUser("user_1", {
      event: "proof.created",
      source: V1_FIXTURE_SOURCES["proof.created"],
    });
    const [firstId] = [...rows.keys()];
    const originalBody = rows.get(firstId)!.payloadBody;

    const sent: Array<{ body: string; headers: Record<string, string> }> = [];
    global.fetch = jest.fn((_url: string, init: RequestInit) => {
      sent.push({
        body: init.body as string,
        headers: init.headers as Record<string, string>,
      });
      return Promise.resolve({ ok: false, status: 503, text: async () => "" });
    }) as unknown as typeof fetch;

    const run = (id: string) =>
      (service as unknown as { runDelivery: Function }).runDelivery(id);

    // Attempt 1 fails → retry row 2; attempt 2 fails → retry row 3.
    await run(firstId);
    const retry1 = [...rows.values()].find((r) => r.attempt === 2)!;
    // Mutating the JSONB copy must not affect what is sent.
    rows.set(retry1.id as string, { ...retry1, payload: { tampered: true } });
    await run(retry1.id as string);

    expect(sent).toHaveLength(2);
    for (const attempt of sent) {
      expect(attempt.body).toBe(originalBody);
      expect(attempt.headers["X-EarnProof-Schema-Version"]).toBe("1");
      expect(attempt.headers["Deprecation"]).toBeUndefined();
    }
    const retry2 = [...rows.values()].find((r) => r.attempt === 3)!;
    expect(retry2.payloadBody).toBe(originalBody);
    expect(retry2.schemaVersion).toBe("1");
    expect(retry2.eventId).toBe(rows.get(firstId)!.eventId);
  });

  it("announces a deprecated version in headers, never in the body", async () => {
    const schema = WEBHOOK_PAYLOAD_REGISTRY["1"]["proof.verified"];
    schema.deprecation = { sunsetAt: "2027-03-01T00:00:00.000Z" };
    try {
      const { service, rows } = buildHarness([
        { id: "hook_a", events: ["proof.verified"], payloadVersion: "1" },
      ]);
      await service.enqueueForUser("user_1", {
        event: "proof.verified",
        source: V1_FIXTURE_SOURCES["proof.verified"],
      });
      const [id] = [...rows.keys()];
      let headers: Record<string, string> = {};
      let body = "";
      global.fetch = jest.fn((_url: string, init: RequestInit) => {
        headers = init.headers as Record<string, string>;
        body = init.body as string;
        return Promise.resolve({ ok: true, status: 200, text: async () => "" });
      }) as unknown as typeof fetch;

      await (service as unknown as { runDelivery: Function }).runDelivery(id);

      expect(headers["Deprecation"]).toBe("true");
      expect(headers["Sunset"]).toBe("Mon, 01 Mar 2027 00:00:00 GMT");
      expect(body).not.toMatch(/deprecat|sunset/i);
      expect(rows.get(id)!.status).toBe(WebhookDeliveryStatus.SUCCESS);
    } finally {
      delete schema.deprecation;
    }
  });
});
