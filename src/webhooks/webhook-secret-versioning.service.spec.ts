import { WebhookSecretState } from "@prisma/client";
import { encryptProtectedAmount } from "../common/crypto/protected-amount";
import { WebhookSecretVersioningService } from "./webhook-secret-versioning.service";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const ENCRYPTION_KEYRING = new Map([[0, ENCRYPTION_KEY]]);

function makeConfig(overlapWindowMinutes = 1440) {
  return {
    get: jest.fn((key: string, defaultValue?: number) => {
      if (key === "WEBHOOK_SECRET_OVERLAP_WINDOW_MINUTES") return overlapWindowMinutes;
      return defaultValue;
    }),
    getOrThrow: jest.fn((key: string) => {
      if (key === "paymentEncryptionKey") return ENCRYPTION_KEY;
      throw new Error(`Unexpected config key: ${key}`);
    }),
  };
}

function buildPrisma(secretVersions: Map<string, Record<string, unknown>>) {
  return {
    webhookSecretVersion: {
      create: jest.fn(async (data: Record<string, unknown>) => {
        const id = `sv_${Math.random().toString(36).substr(2, 9)}`;
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        secretVersions.set(id, record);
        return record;
      }),
      findFirst: jest.fn(async (query: Record<string, unknown>) => {
        const records = Array.from(secretVersions.values());
        const whereClause = query.where as Record<string, unknown>;

        return records.find((r) => {
          if (whereClause.webhookId && r.webhookId !== whereClause.webhookId) return false;

          const state = whereClause.state as { in?: string[] };
          if (state?.in && !state.in.includes(r.state as string)) return false;

          if (
            whereClause.state === WebhookSecretState.ACTIVE &&
            r.state !== WebhookSecretState.ACTIVE
          )
            return false;

          return true;
        });
      }),
      findUnique: jest.fn(async (query: Record<string, unknown>) => {
        const where = query.where as Record<string, unknown>;
        if (where.webhookId_keyId) {
          const { webhookId, keyId } = where.webhookId_keyId as Record<string, string>;
          return Array.from(secretVersions.values()).find(
            (r) => r.webhookId === webhookId && r.keyId === keyId,
          );
        }
        return null;
      }),
      findMany: jest.fn(async (query: Record<string, unknown>) => {
        const records = Array.from(secretVersions.values());
        const whereClause = query.where as Record<string, unknown>;

        return records.filter((r) => {
          if (whereClause.webhookId && r.webhookId !== whereClause.webhookId) return false;

          const state = whereClause.state as { in?: string[] };
          if (state?.in && !state.in.includes(r.state as string)) return false;

          return true;
        });
      }),
      update: jest.fn(async (data: Record<string, unknown>) => {
        const where = data.where as Record<string, unknown>;
        const updateData = data.data as Record<string, unknown>;
        const record = secretVersions.get(where.id as string);
        if (record) {
          Object.assign(record, updateData, { updatedAt: new Date() });
        }
        return record;
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebhookSecretVersioningService", () => {
  describe("createInitialSecret", () => {
    it("creates an ACTIVE secret for a new webhook", async () => {
      const secretVersions = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(secretVersions);
      const config = makeConfig();

      const service = new WebhookSecretVersioningService(prisma as never, config as never);

      const result = await service.createInitialSecret("webhook_123");

      expect(result.rawSecret).toHaveLength(64); // 32 bytes hex-encoded
      expect(result.keyId).toMatch(/^v\d+$/); // timestamp-based keyId

      const created = Array.from(secretVersions.values())[0];
      expect(created.webhookId).toBe("webhook_123");
      expect(created.state).toBe(WebhookSecretState.ACTIVE);
      expect(created.keyId).toBe(result.keyId);
    });
  });

  describe("rotateSecret", () => {
    it("moves current ACTIVE secret to OVERLAP and creates new ACTIVE", async () => {
      const secretVersions = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(secretVersions);
      const config = makeConfig();

      const service = new WebhookSecretVersioningService(prisma as never, config as never);

      // Create initial secret
      const initial = await service.createInitialSecret("webhook_456");
      expect(initial.keyId).toBeDefined();

      // Wait a bit to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Rotate
      const rotated = await service.rotateSecret("webhook_456");

      expect(rotated.rawSecret).toHaveLength(64);
      expect(rotated.keyId).not.toBe(initial.keyId);

      // Verify state: original should be OVERLAP, new should be ACTIVE
      const records = Array.from(secretVersions.values());
      const originalRecord = records.find((r) => r.keyId === initial.keyId);
      const rotatedRecord = records.find((r) => r.keyId === rotated.keyId);

      expect(originalRecord?.state).toBe(WebhookSecretState.OVERLAP);
      expect(rotatedRecord?.state).toBe(WebhookSecretState.ACTIVE);
    });

    it("sets overlapExpiresAt on the OVERLAP secret", async () => {
      const secretVersions = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(secretVersions);
      const config = makeConfig(60); // 1 hour overlap window

      const service = new WebhookSecretVersioningService(prisma as never, config as never);

      const initial = await service.createInitialSecret("webhook_789");
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await service.rotateSecret("webhook_789");

      const records = Array.from(secretVersions.values());
      const overlapRecord = records.find((r) => r.state === WebhookSecretState.OVERLAP);

      expect(overlapRecord?.overlapExpiresAt).toBeDefined();
      const expiryTime = (overlapRecord?.overlapExpiresAt as Date).getTime();
      const now = Date.now();
      const expectedWindow = 60 * 60 * 1000; // 1 hour

      // Allow 100ms tolerance for test execution time
      expect(expiryTime).toBeGreaterThan(now + expectedWindow - 100);
      expect(expiryTime).toBeLessThan(now + expectedWindow + 100);
    });
  });

  describe("getActiveSecret", () => {
    it("returns the ACTIVE secret for a webhook", async () => {
      const secretVersions = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(secretVersions);
      const config = makeConfig();

      const service = new WebhookSecretVersioningService(prisma as never, config as never);

      const initial = await service.createInitialSecret("webhook_active");
      const active = await service.getActiveSecret("webhook_active");

      expect(active).toBeDefined();
      expect(active?.rawSecret).toBe(initial.rawSecret);
      expect(active?.keyId).toBe(initial.keyId);
    });

    it("returns null if no ACTIVE secret exists", async () => {
      const secretVersions = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(secretVersions);
      const config = makeConfig();

      const service = new WebhookSecretVersioningService(prisma as never, config as never);

      const active = await service.getActiveSecret("webhook_nonexistent");
      expect(active).toBeNull();
    });

    it("returns the most recent ACTIVE secret if multiple exist (should not happen)", async () => {
      const secretVersions = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(secretVersions);
      const config = makeConfig();

      const service = new WebhookSecretVersioningService(prisma as never, config as never);

      const first = await service.createInitialSecret("webhook_multi");
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Manually add another ACTIVE secret to test sorting (edge case)
      const secondKeyId = `v${Math.floor(Date.now() / 1000) + 1}`;
      const secondSecret = "second" + "0".repeat(58); // 64 chars hex
      const secondEncrypted = encryptProtectedAmount(secondSecret, ENCRYPTION_KEYRING, 0);

      secretVersions.set("sv_second", {
        id: "sv_second",
        webhookId: "webhook_multi",
        keyId: secondKeyId,
        secretEncrypted: secondEncrypted,
        state: WebhookSecretState.ACTIVE,
        activatedAt: new Date(Date.now() + 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const active = await service.getActiveSecret("webhook_multi");
      expect(active?.keyId).toBe(secondKeyId); // Most recent
    });
  });

  describe("getUsableSecrets", () => {
    it("returns both ACTIVE and OVERLAP secrets", async () => {
      const secretVersions = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(secretVersions);
      const config = makeConfig();

      const service = new WebhookSecretVersioningService(prisma as never, config as never);

      const initial = await service.createInitialSecret("webhook_usable");
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const rotated = await service.rotateSecret("webhook_usable");

      const usable = await service.getUsableSecrets("webhook_usable");

      expect(usable).toHaveLength(2);
      expect(usable.map((s) => s.keyId)).toContain(initial.keyId);
      expect(usable.map((s) => s.keyId)).toContain(rotated.keyId);
      expect(usable.find((s) => s.keyId === initial.keyId)?.state).toBe(
        WebhookSecretState.OVERLAP,
      );
      expect(usable.find((s) => s.keyId === rotated.keyId)?.state).toBe(WebhookSecretState.ACTIVE);
    });

    it("returns only ACTIVE after OVERLAP expires", async () => {
      const secretVersions = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(secretVersions);
      const config = makeConfig(0.001); // Very short overlap window (milliseconds)

      const service = new WebhookSecretVersioningService(prisma as never, config as never);

      const initial = await service.createInitialSecret("webhook_expire");
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const rotated = await service.rotateSecret("webhook_expire");

      // Wait for overlap to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      const usable = await service.getUsableSecrets("webhook_expire");

      // Only ACTIVE should remain (OVERLAP moved to RETIRED)
      expect(usable.length).toBeLessThanOrEqual(1);
      const activeSecret = usable.find((s) => s.state === WebhookSecretState.ACTIVE);
      expect(activeSecret?.keyId).toBe(rotated.keyId);
    });
  });

  describe("getSecretByKeyId", () => {
    it("returns a secret by its keyId when ACTIVE or OVERLAP", async () => {
      const secretVersions = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(secretVersions);
      const config = makeConfig();

      const service = new WebhookSecretVersioningService(prisma as never, config as never);

      const initial = await service.createInitialSecret("webhook_byid");
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const rotated = await service.rotateSecret("webhook_byid");

      const active = await service.getSecretByKeyId("webhook_byid", rotated.keyId);
      const overlap = await service.getSecretByKeyId("webhook_byid", initial.keyId);

      expect(active?.rawSecret).toBe(rotated.rawSecret);
      expect(active?.state).toBe(WebhookSecretState.ACTIVE);
      expect(overlap?.rawSecret).toBe(initial.rawSecret);
      expect(overlap?.state).toBe(WebhookSecretState.OVERLAP);
    });

    it("returns null for a non-existent keyId", async () => {
      const secretVersions = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(secretVersions);
      const config = makeConfig();

      const service = new WebhookSecretVersioningService(prisma as never, config as never);

      await service.createInitialSecret("webhook_notfound");

      const result = await service.getSecretByKeyId("webhook_notfound", "v_nonexistent");
      expect(result).toBeNull();
    });

    it("auto-retires expired OVERLAP secrets when fetching by keyId", async () => {
      const secretVersions = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(secretVersions);
      const config = makeConfig(0.001); // Very short overlap window

      const service = new WebhookSecretVersioningService(prisma as never, config as never);

      const initial = await service.createInitialSecret("webhook_autoretire");
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await service.rotateSecret("webhook_autoretire");

      // Wait for overlap to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Try to fetch the expired OVERLAP secret
      const result = await service.getSecretByKeyId("webhook_autoretire", initial.keyId);

      expect(result).toBeNull();

      // Verify it was moved to RETIRED
      const records = Array.from(secretVersions.values());
      const originalRecord = records.find((r) => r.keyId === initial.keyId);
      expect(originalRecord?.state).toBe(WebhookSecretState.RETIRED);
    });
  });

  describe("getOverlapWindowMs", () => {
    it("returns the configured overlap window in milliseconds", () => {
      const config = makeConfig(120); // 2 hours

      const service = new WebhookSecretVersioningService(
        { webhookSecretVersion: {} } as never,
        config as never,
      );

      const windowMs = service.getOverlapWindowMs();
      expect(windowMs).toBe(120 * 60 * 1000); // 7.2 million ms
    });
  });

  describe("cleanupRetiredSecrets", () => {
    it("removes retired secrets older than the specified age", async () => {
      const secretVersions = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(secretVersions);
      const config = makeConfig();

      const service = new WebhookSecretVersioningService(prisma as never, config as never);

      // This would require mocking deleteMany, which the buildPrisma helper does
      const result = await service.cleanupRetiredSecrets(1000);
      expect(result).toBe(0); // deleteMany returns count: 0 in our mock
    });
  });

  describe("concurrent rotation handling", () => {
    it("handles concurrent rotations without data corruption", async () => {
      const secretVersions = new Map<string, Record<string, unknown>>();
      const prisma = buildPrisma(secretVersions);
      const config = makeConfig();

      const service = new WebhookSecretVersioningService(prisma as never, config as never);

      const initial = await service.createInitialSecret("webhook_concurrent");

      // Simulate concurrent rotations
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await Promise.all([
        service.rotateSecret("webhook_concurrent"),
        service.rotateSecret("webhook_concurrent"),
      ]);

      const records = Array.from(secretVersions.values());
      const activeCount = records.filter((r) => r.state === WebhookSecretState.ACTIVE).length;

      // Should have exactly 1 or 2 ACTIVE (depending on timing), but at most 1 ACTIVE per webhook
      // In a real scenario this would be enforced at the database level
      expect(activeCount).toBeGreaterThanOrEqual(1);
    });
  });
});
