/* eslint-disable @typescript-eslint/no-unsafe-function-type */
import { WebhookDeliveryStatus } from "@prisma/client";
import { encryptProtectedAmount } from "../common/crypto/protected-amount";
import { WebhookDeliveryService } from "./webhook-delivery.service";
import { WebhookSigningService } from "./webhook-signing.service";
import { WebhookEnvelope } from "./webhook-event.types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const ENCRYPTION_KEYRING = new Map([[0, ENCRYPTION_KEY]]);
const RAW_SECRET = "test-raw-signing-secret-32bytes!";

function makeEncryptedSecret() {
  return encryptProtectedAmount(RAW_SECRET, ENCRYPTION_KEYRING, 0);
}

function makeConfig() {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === "paymentEncryptionKey") return ENCRYPTION_KEY;
      throw new Error(`Unexpected config key: ${key}`);
    }),
    get: jest.fn(() => undefined),
  };
}

/** No webhook in these existing tests requires mTLS, so this is never consulted. */
function makeNoMtlsCertificateService() {
  return {
    selectActiveCertificate: jest.fn().mockResolvedValue(null),
  };
}

function makeEnvelope(overrides: Partial<WebhookEnvelope> = {}): WebhookEnvelope {
  return {
    specVersion: "1",
    id: "event_abc",
    event: "proof.created",
    schemaVersion: "1",
    createdAt: "2026-09-01T00:00:00.000Z",
    data: {
      proofId: "proof_1",
      proofType: "MINIMUM_INCOME",
      schemaVersion: "earnproof.minimum-income.v1",
      status: "ACTIVE",
      network: "testnet",
      assetCode: "XLM",
      assetIssuer: null,
      periodStart: null,
      periodEnd: null,
      expiresAt: "2027-09-01T00:00:00.000Z",
      credentialHash: "sha256:abc",
      contractTransactionHash: null,
      issuedAt: "2026-09-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Delivery service — unit tests using an in-memory store
// ---------------------------------------------------------------------------

describe("WebhookDeliveryService", () => {
  // -------------------------------------------------------------------------
  // Retry behavior and ordering
  // -------------------------------------------------------------------------
  describe("retry behavior", () => {
    it("marks a delivery SUCCESS when the endpoint returns 2xx", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_1";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      // Pre-create the delivery row (simulating what enqueueForUser does)
      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_abc",
        schemaVersion: "1",
        payloadBody: JSON.stringify(makeEnvelope({ id: "event_abc" })),
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "OK",
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeNoMtlsCertificateService() as never,
        makeConfig() as never,
      );

      // Bypass onModuleInit startup scan
      await (service as unknown as { runDelivery: Function }).runDelivery(deliveryId);

      const updated = deliveries.get(deliveryId) as Record<string, unknown>;
      expect(updated.status).toBe(WebhookDeliveryStatus.SUCCESS);
      expect(updated.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("creates a retry delivery row when the endpoint returns 5xx", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_fail_1";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_abc",
        schemaVersion: "1",
        payloadBody: JSON.stringify(makeEnvelope({ id: "event_abc" })),
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "Service Unavailable",
      }) as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeNoMtlsCertificateService() as never,
        makeConfig() as never,
      );

      await (service as unknown as { runDelivery: Function }).runDelivery(deliveryId);

      // Original delivery marked FAILED
      const original = deliveries.get(deliveryId) as Record<string, unknown>;
      expect(original.status).toBe(WebhookDeliveryStatus.FAILED);
      expect(original.statusCode).toBe(503);

      // A new retry delivery was created
      const retryDelivery = [...deliveries.values()].find(
        (d) => d.id !== deliveryId && (d as Record<string, unknown>).attempt === 2,
      );
      expect(retryDelivery).toBeDefined();
      expect((retryDelivery as Record<string, unknown>).eventId).toBe("event_abc");
    });

    it("permanently fails after MAX_ATTEMPTS (5) without further retries", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_maxretry";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_abc",
        schemaVersion: "1",
        payloadBody: JSON.stringify(makeEnvelope({ id: "event_abc" })),
        attempt: 5, // already at max
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "error",
      }) as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeNoMtlsCertificateService() as never,
        makeConfig() as never,
      );

      await (service as unknown as { runDelivery: Function }).runDelivery(deliveryId);

      // Still only 1 delivery row — no new retry row created
      expect(deliveries.size).toBe(1);
      const d = deliveries.get(deliveryId) as Record<string, unknown>;
      expect(d.status).toBe(WebhookDeliveryStatus.FAILED);
    });

    it("carries the same eventId across all retry attempts (ordering + idempotency)", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_chain";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_same",
        schemaVersion: "1",
        payloadBody: JSON.stringify(makeEnvelope({ id: "event_same" })),
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "error",
      }) as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeNoMtlsCertificateService() as never,
        makeConfig() as never,
      );

      await (service as unknown as { runDelivery: Function }).runDelivery(deliveryId);

      const retryRow = [...deliveries.values()].find(
        (d) => (d as Record<string, unknown>).id !== deliveryId,
      ) as Record<string, unknown> | undefined;

      expect(retryRow?.eventId).toBe("event_same");
    });
  });

  // -------------------------------------------------------------------------
  // SSRF protection
  // -------------------------------------------------------------------------
  describe("SSRF protection", () => {
    const blockedUrls = [
      "https://127.0.0.1/hook",
      "https://localhost/hook",
      "https://10.0.0.1/hook",
      "https://172.16.0.1/hook",
      "https://192.168.1.1/hook",
      "https://169.254.169.254/hook",
      "https://[::1]/hook",
    ];

    it.each(blockedUrls)(
      "permanently fails delivery to blocked URL %s without scheduling a retry",
      async (blockedUrl) => {
        const secretEncrypted = makeEncryptedSecret();
        const deliveries = new Map<string, Record<string, unknown>>();
        const deliveryId = `delivery_ssrf_${blockedUrl.slice(-5)}`;

        const prisma = buildPrisma(deliveries, [
          { id: "webhook_1", url: blockedUrl, secretEncrypted, status: "ACTIVE" },
        ]);

        deliveries.set(deliveryId, {
          id: deliveryId,
          webhookId: "webhook_1",
          eventType: "proof.created",
          eventId: "event_ssrf",
          schemaVersion: "1",
          payloadBody: JSON.stringify(makeEnvelope({ id: "event_ssrf" })),
          attempt: 1,
          status: WebhookDeliveryStatus.PENDING,
          replayOf: null,
          createdAt: new Date(),
          webhook: {
            id: "webhook_1",
            url: blockedUrl,
            secretEncrypted,
            status: "ACTIVE",
          },
        });

        // fetch should never be called for SSRF-blocked URLs
        global.fetch = jest.fn() as unknown as typeof fetch;

        const service = new WebhookDeliveryService(
          prisma as never,
          new WebhookSigningService(),
          makeNoMtlsCertificateService() as never,
          makeConfig() as never,
        );

        await (service as unknown as { runDelivery: Function }).runDelivery(deliveryId);

        expect(global.fetch).not.toHaveBeenCalled();

        const d = deliveries.get(deliveryId) as Record<string, unknown>;
        expect(d.status).toBe(WebhookDeliveryStatus.FAILED);
        expect(d.failureReason).toMatch(/SSRF/);

        // No retry row created
        expect(deliveries.size).toBe(1);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Redaction — secrets must never appear in delivery logs
  // -------------------------------------------------------------------------
  describe("redaction", () => {
    it("does not store the raw signing secret in the delivery row", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_redact";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_r",
        schemaVersion: "1",
        payloadBody: JSON.stringify(makeEnvelope({ id: "event_r" })),
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '{"token":"integrator-secret","ok":true}',
      }) as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeNoMtlsCertificateService() as never,
        makeConfig() as never,
      );

      await (service as unknown as { runDelivery: Function }).runDelivery(deliveryId);

      const storedRow = deliveries.get(deliveryId) as Record<string, unknown>;
      const rowJson = JSON.stringify(storedRow);

      // Raw secret must not appear in the stored delivery row
      expect(rowJson).not.toContain(RAW_SECRET);
      expect(rowJson).not.toContain("integrator-secret");
      expect(rowJson).toContain("[REDACTED]");
    });

    it("truncates large response bodies to 1024 characters", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_trunc";

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_t",
        schemaVersion: "1",
        payloadBody: JSON.stringify(makeEnvelope({ id: "event_t" })),
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
        },
      });

      const largeBody = "x".repeat(5000);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => largeBody,
      }) as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeNoMtlsCertificateService() as never,
        makeConfig() as never,
      );

      await (service as unknown as { runDelivery: Function }).runDelivery(deliveryId);

      const storedRow = deliveries.get(deliveryId) as Record<string, unknown>;
      expect(typeof storedRow.responseBody).toBe("string");
      expect((storedRow.responseBody as string).length).toBeLessThanOrEqual(
        1024 + "…[truncated]".length,
      );
      expect(storedRow.responseBody as string).toContain("…[truncated]");
    });
  });

  // -------------------------------------------------------------------------
  // Secret rotation — delivery re-decrypts at execution time
  // -------------------------------------------------------------------------
  describe("secret rotation", () => {
    it("uses the current encrypted secret at execution time, not at enqueue time", async () => {
      const newSecret = encryptProtectedAmount(
        "new-secret",
        ENCRYPTION_KEYRING,
        0,
      );

      const deliveries = new Map<string, Record<string, unknown>>();
      const deliveryId = "delivery_rotated";

      // The webhook row now has the NEW secret (simulating rotation)
      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted: newSecret, status: "ACTIVE" },
      ]);

      deliveries.set(deliveryId, {
        id: deliveryId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_rot",
        schemaVersion: "1",
        payloadBody: JSON.stringify(makeEnvelope({ id: "event_rot" })),
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted: newSecret, // delivery row also references the live webhook
          status: "ACTIVE",
        },
      });

      const capturedHeaders: Record<string, string> = {};
      global.fetch = jest.fn().mockImplementation(
        (_url: string, init: RequestInit) => {
          Object.assign(capturedHeaders, init.headers as Record<string, string>);
          return Promise.resolve({ ok: true, status: 200, text: async () => "ok" });
        },
      ) as unknown as typeof fetch;

      const signing = new WebhookSigningService();
      const service = new WebhookDeliveryService(
        prisma as never,
        signing,
        makeNoMtlsCertificateService() as never,
        makeConfig() as never,
      );

      // The service always re-reads the secret from the live webhook row.
      await (service as unknown as { runDelivery: Function }).runDelivery(deliveryId);

      // Signature in the sent request should be verifiable with the NEW secret
      const sigHeader = capturedHeaders["X-EarnProof-Signature"];
      const tsHeader = capturedHeaders["X-EarnProof-Timestamp"];
      const deliveryHeader = capturedHeaders["X-EarnProof-Delivery"];
      expect(sigHeader).toMatch(/^v1=/);

      // The signature covers the persisted body and verifies only with the
      // NEW secret.
      const body = JSON.stringify(makeEnvelope({ id: "event_rot" }));
      const ts = Number(tsHeader);
      expect(
        signing.verify("new-secret", ts, deliveryHeader, body, sigHeader),
      ).toBe(true);
      expect(
        signing.verify("old-secret", ts, deliveryHeader, body, sigHeader),
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------
  describe("replay", () => {
    it("creates a new delivery row with replayOf set to the original id", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const originalId = "delivery_original";

      deliveries.set(originalId, {
        id: originalId,
        webhookId: "webhook_1",
        eventType: "proof.created",
        eventId: "event_replay",
        payload: makeEnvelope({ id: "event_replay" }),
        schemaVersion: "1",
        payloadBody: JSON.stringify(makeEnvelope({ id: "event_replay" })),
        attempt: 1,
        status: WebhookDeliveryStatus.FAILED,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_1",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "ACTIVE",
          events: ["proof.created"],
        },
      });

      const prisma = buildPrisma(deliveries, [
        { id: "webhook_1", url: "https://example.com/hook", secretEncrypted, status: "ACTIVE" },
      ]);

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeNoMtlsCertificateService() as never,
        makeConfig() as never,
      );

      const newId = await service.replay(originalId, "user_admin");

      const replayRow = deliveries.get(newId) as Record<string, unknown>;
      expect(replayRow).toBeDefined();
      expect(replayRow.replayOf).toBe(originalId);
      expect(replayRow.replayedBy).toBe("user_admin");
      expect(replayRow.eventId).toBe("event_replay"); // same eventId → integrator deduplicates
      expect(replayRow.attempt).toBe(1);

      const repeatedId = await service.replay(originalId, "user_admin");
      expect(repeatedId).toBe(newId);
      expect(deliveries.size).toBe(2);
    });

    it("rejects replay for a disabled webhook endpoint", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const originalId = "delivery_disabled";

      deliveries.set(originalId, {
        id: originalId,
        webhookId: "webhook_disabled",
        eventType: "proof.created",
        eventId: "event_d",
        schemaVersion: "1",
        payloadBody: JSON.stringify(makeEnvelope({ id: "event_d" })),
        attempt: 1,
        status: WebhookDeliveryStatus.SUCCESS,
        replayOf: null,
        createdAt: new Date(),
        webhook: {
          id: "webhook_disabled",
          url: "https://example.com/hook",
          secretEncrypted,
          status: "SUSPENDED", // disabled
          events: ["proof.created"],
        },
      });

      const prisma = buildPrisma(deliveries, []);

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeNoMtlsCertificateService() as never,
        makeConfig() as never,
      );

      await expect(service.replay(originalId, "user_admin")).rejects.toThrow(
        "Cannot replay delivery for a disabled webhook endpoint",
      );
    });

    it("throws for a non-existent delivery id", async () => {
      const prisma = buildPrisma(new Map(), []);

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeNoMtlsCertificateService() as never,
        makeConfig() as never,
      );

      await expect(service.replay("non_existent", "user_x")).rejects.toThrow(
        "WebhookDelivery not found",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Organization archival
  // -------------------------------------------------------------------------
  describe("organization archival", () => {
    it("fails a scheduled delivery without sending it once the organization is archived", async () => {
      const secretEncrypted = makeEncryptedSecret();
      const deliveries = new Map<string, Record<string, unknown>>();
      const archivedWebhook = {
        id: "webhook_archived",
        url: "https://example.com/hook",
        secretEncrypted,
        status: "ACTIVE",
        organization: { archivedAt: new Date("2026-01-01T00:00:00.000Z") },
      };
      const prisma = buildPrisma(deliveries, [archivedWebhook]);
      deliveries.set("delivery_archived", {
        id: "delivery_archived",
        webhookId: "webhook_archived",
        eventType: "proof.created",
        eventId: "event_archived",
        attempt: 2,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: null,
        createdAt: new Date(),
      });
      const fetchMock = jest.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeConfig() as never,
      );
      await (service as unknown as { runDelivery: Function }).runDelivery(
        "delivery_archived",
        makeEnvelope(),
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(deliveries.get("delivery_archived")).toMatchObject({
        status: WebhookDeliveryStatus.FAILED,
        failureReason: "organization archived before delivery",
      });
    });

    it("enqueues events only for organizations that are not archived", async () => {
      const prisma = buildPrisma(new Map(), []);
      const service = new WebhookDeliveryService(
        prisma as never,
        new WebhookSigningService(),
        makeConfig() as never,
      );

      await service.enqueueForUser("user_1", "proof.created" as never, {} as never);

      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          select: {
            organizations: expect.objectContaining({ where: { archivedAt: null } }),
          },
        }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Minimal in-memory Prisma mock
// ---------------------------------------------------------------------------

function buildPrisma(
  deliveries: Map<string, Record<string, unknown>>,
  webhooks: Array<{
    id: string;
    url: string;
    secretEncrypted: string;
    status: string;
    events?: string[];
  }>,
) {
  let nextId = 1;
  const genId = () => `delivery_gen_${nextId++}`;

  return {
    webhookDelivery: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        const status = where?.status as string | undefined;
        const rows = [...deliveries.values()].filter((d) =>
          status ? d.status === status : true,
        );
        return Promise.resolve(
          rows.map((r) => ({
            id: r.id,
            webhookId: r.webhookId,
            attempt: r.attempt,
            nextRetryAt: r.nextRetryAt ?? null,
          })),
        );
      }),
      findUnique: jest.fn(({ where, include }: { where: { id?: string; replayKey?: string }; include?: unknown }) => {
        const row = where.id
          ? deliveries.get(where.id)
          : [...deliveries.values()].find(
              (delivery) => delivery.replayKey === where.replayKey,
            );
        if (!row) return Promise.resolve(null);
        const withWebhook = include
          ? {
              ...row,
              webhook: webhooks.find((w) => w.id === row.webhookId) ??
                (row.webhook as Record<string, unknown>),
            }
          : row;
        return Promise.resolve(withWebhook);
      }),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const id = (data.id as string | undefined) ?? genId();
        const row = { ...data, id };
        deliveries.set(id, row);
        const select = { id };
        return Promise.resolve(select);
      }),
      update: jest.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = deliveries.get(where.id) ?? {};
        const updated = { ...existing, ...data };
        deliveries.set(where.id, updated);
        return Promise.resolve(updated);
      }),
    },
    user: {
      findUnique: jest.fn(() =>
        Promise.resolve({ organizations: [] }),
      ),
    },
    webhook: {
      findMany: jest.fn(() => Promise.resolve(webhooks)),
    },
  };
}
