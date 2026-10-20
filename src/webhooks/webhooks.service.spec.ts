import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ResourceStatus } from "@prisma/client";
import { encryptProtectedAmount } from "../common/crypto/protected-amount";
import { WebhookDeliveryService } from "./webhook-delivery.service";
import { WebhookVerificationService } from "./webhook-verification.service";
import { WebhooksService } from "./webhooks.service";
import { unlimitedQuotas } from "../testing/quotas";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const ENCRYPTION_KEYRING = new Map([[0, ENCRYPTION_KEY]]);

function makeConfig() {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === "paymentEncryptionKey") return ENCRYPTION_KEY;
      throw new Error(`Unexpected config key: ${key}`);
    }),
  };
}

function makeDeliveryService(): jest.Mocked<WebhookDeliveryService> {
  return {
    enqueueForUser: jest.fn().mockResolvedValue(undefined),
    replay: jest.fn().mockResolvedValue("replay_delivery_1"),
    onModuleInit: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<WebhookDeliveryService>;
}

function makeVerificationService(): jest.Mocked<WebhookVerificationService> {
  return {
    issueChallenge: jest
      .fn()
      .mockResolvedValue({ challengeId: "challenge_1", expiresAt: new Date() }),
    verifyChallenge: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<WebhookVerificationService>;
}

function makeCircuitBreaker() {
  return {
    initializeCircuit: jest.fn().mockResolvedValue(undefined),
    deleteCircuitState: jest.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebhooksService", () => {
  describe("create", () => {
    it("returns a one-time signingSecret that decrypts to the stored secret", async () => {
      let storedEncrypted = "";

      const prisma = {
        webhook: {
          create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            storedEncrypted = data.secretEncrypted as string;
            return Promise.resolve({
              id: "webhook_1",
              url: data.url,
              events: data.events,
              status: data.status,
              createdAt: new Date(),
            });
          }),
        },
      };
      Object.assign(prisma, {
        $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      });

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeCircuitBreaker() as never,
        makeVerificationService(),
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      const result = await service.create("org_1", {
        url: "https://example.com/hook",
        events: ["proof.created"],
      });

      expect(result.signingSecret).toBeTruthy();
      expect(typeof result.signingSecret).toBe("string");
      expect(result.signingSecret.length).toBeGreaterThan(0);

      // The stored encrypted value should decrypt to the returned secret
      const decrypted = service.revealSecret(storedEncrypted);
      expect(decrypted).toBe(result.signingSecret);
    });

    it("de-duplicates the events array", async () => {
      let storedEvents: unknown;

      const prisma = {
        webhook: {
          create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            storedEvents = data.events;
            return Promise.resolve({
              id: "webhook_1",
              url: data.url,
              events: data.events,
              status: data.status,
              createdAt: new Date(),
            });
          }),
        },
      };
      Object.assign(prisma, {
        $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      });

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeCircuitBreaker() as never,
        makeVerificationService(),
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      await service.create("org_1", {
        url: "https://example.com/hook",
        events: ["proof.created", "proof.created", "proof.verified"],
      });

      expect(storedEvents).toEqual(["proof.created", "proof.verified"]);
    });
  });

  describe("rotateSecret", () => {
    it("stores a new encrypted secret and returns the raw value once", async () => {
      let latestEncrypted = encryptProtectedAmount(
        "original-secret",
        ENCRYPTION_KEYRING,
        0,
      );

      const prisma = {
        webhook: {
          findUnique: jest.fn().mockResolvedValue({
            id: "webhook_1",
            organizationId: "org_1",
            status: ResourceStatus.ACTIVE,
          }),
          update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            latestEncrypted = data.secretEncrypted as string;
            return Promise.resolve({});
          }),
        },
      };

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeCircuitBreaker() as never,
        makeVerificationService(),
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      const result = await service.rotateSecret("org_1", "webhook_1");

      expect(result.signingSecret).toBeTruthy();
      // New decrypted secret must differ from the original
      const originalDecrypted = "original-secret";
      expect(result.signingSecret).not.toBe(originalDecrypted);
      // But the newly stored encrypted value must decrypt to the new secret
      expect(service.revealSecret(latestEncrypted)).toBe(result.signingSecret);
    });

    it("throws ForbiddenException if the webhook belongs to a different org", async () => {
      const prisma = {
        webhook: {
          findUnique: jest.fn().mockResolvedValue({
            id: "webhook_1",
            organizationId: "org_other",
            status: ResourceStatus.ACTIVE,
          }),
        },
      };

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeCircuitBreaker() as never,
        makeVerificationService(),
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      await expect(service.rotateSecret("org_mine", "webhook_1")).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe("disable / enable", () => {
    it("sets status to SUSPENDED when disabled", async () => {
      let storedStatus: unknown;
      const prisma = {
        webhook: {
          findUnique: jest.fn().mockResolvedValue({
            id: "webhook_1",
            organizationId: "org_1",
            status: ResourceStatus.ACTIVE,
          }),
          update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            storedStatus = data.status;
            return Promise.resolve({ id: "webhook_1", status: data.status, updatedAt: new Date() });
          }),
        },
      };

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeCircuitBreaker() as never,
        makeVerificationService(),
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      await service.disable("org_1", "webhook_1");
      expect(storedStatus).toBe(ResourceStatus.SUSPENDED);
    });

    it("sets status to ACTIVE when re-enabled", async () => {
      let storedStatus: unknown;
      const prisma = {
        webhook: {
          findUnique: jest.fn().mockResolvedValue({
            id: "webhook_1",
            organizationId: "org_1",
            status: ResourceStatus.SUSPENDED,
          }),
          update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            storedStatus = data.status;
            return Promise.resolve({ id: "webhook_1", status: data.status, updatedAt: new Date() });
          }),
        },
      };

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeCircuitBreaker() as never,
        makeVerificationService(),
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      await service.enable("org_1", "webhook_1");
      expect(storedStatus).toBe(ResourceStatus.ACTIVE);
    });
  });

  describe("replayDelivery", () => {
    it("creates an AuditLog entry and delegates to delivery service", async () => {
      const auditLogs: unknown[] = [];
      const deliveryService = makeDeliveryService();

      const prisma = {
        webhookDelivery: {
          findUnique: jest.fn().mockResolvedValue({
            id: "delivery_1",
            webhookId: "webhook_1",
            eventType: "proof.created",
            eventId: "event_abc",
            attempt: 1,
            webhook: { organizationId: "org_1" },
          }),
        },
        auditLog: {
          create: jest.fn().mockImplementation(({ data }: { data: unknown }) => {
            auditLogs.push(data);
            return Promise.resolve({ id: "audit_1" });
          }),
        },
      };

      const service = new WebhooksService(
        prisma as never,
        deliveryService,
        makeCircuitBreaker() as never,
        makeVerificationService(),
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      const result = await service.replayDelivery("org_1", "delivery_1", "user_admin");

      expect(result.replayDeliveryId).toBe("replay_delivery_1");
      expect(result.originalDeliveryId).toBe("delivery_1");
      expect(result.eventId).toBe("event_abc");

      expect(auditLogs).toHaveLength(1);
      const log = auditLogs[0] as Record<string, unknown>;
      expect(log.action).toBe("webhook.delivery.replayed");
      expect(log.actorId).toBe("user_admin");
      expect(log.resourceId).toBe("delivery_1");
    });

    it("throws NotFoundException for unknown delivery", async () => {
      const prisma = {
        webhookDelivery: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      };

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeCircuitBreaker() as never,
        makeVerificationService(),
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      await expect(
        service.replayDelivery("org_1", "non_existent", "user_admin"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException when delivery belongs to different org", async () => {
      const prisma = {
        webhookDelivery: {
          findUnique: jest.fn().mockResolvedValue({
            id: "delivery_1",
            webhookId: "webhook_1",
            eventType: "proof.created",
            eventId: "event_abc",
            attempt: 1,
            webhook: { organizationId: "org_other" },
          }),
        },
      };

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeCircuitBreaker() as never,
        makeVerificationService(),
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      await expect(
        service.replayDelivery("org_mine", "delivery_1", "user_admin"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("records who replayed what in the audit log", async () => {
      const auditLogs: unknown[] = [];
      const deliveryService = makeDeliveryService();

      const prisma = {
        webhookDelivery: {
          findUnique: jest.fn().mockResolvedValue({
            id: "delivery_audit",
            webhookId: "webhook_1",
            eventType: "proof.verified",
            eventId: "event_v",
            attempt: 3,
            webhook: { organizationId: "org_1" },
          }),
        },
        auditLog: {
          create: jest.fn().mockImplementation(({ data }: { data: unknown }) => {
            auditLogs.push(data);
            return Promise.resolve({ id: "audit_2" });
          }),
        },
      };

      const service = new WebhooksService(
        prisma as never,
        deliveryService,
        makeCircuitBreaker() as never,
        makeVerificationService(),
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      await service.replayDelivery("org_1", "delivery_audit", "user_developer");

      const log = auditLogs[0] as Record<string, unknown>;
      const metadata = log.metadata as Record<string, unknown>;
      expect(log.actorId).toBe("user_developer");
      expect(metadata.eventType).toBe("proof.verified");
      expect(metadata.originalAttempt).toBe(3);
    });
  });

  describe("listDeliveries", () => {
    it("returns delivery records for an owned webhook", async () => {
      const prisma = {
        webhook: {
          findUnique: jest.fn().mockResolvedValue({
            id: "webhook_1",
            organizationId: "org_1",
            status: ResourceStatus.ACTIVE,
          }),
        },
        webhookDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: "d1",
              eventType: "proof.created",
              status: "SUCCESS",
              createdAt: new Date("2026-08-24T12:30:00.000Z"),
            },
          ]),
        },
      };

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeCircuitBreaker() as never,
        makeVerificationService(),
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      const result = await service.listDeliveries("org_1", "webhook_1");
      expect(result.data).toHaveLength(1);
      expect(result.pageInfo).toEqual({ hasMore: false, nextCursor: null });
      // Secrets must not be present
      const resultJson = JSON.stringify(result);
      expect(resultJson).not.toContain("secretEncrypted");
      expect(resultJson).not.toContain("secretHash");
    });

    it("rejects a malformed cursor without querying the database", async () => {
      const prisma = {
        webhook: {
          findUnique: jest.fn().mockResolvedValue({
            id: "webhook_1",
            organizationId: "org_1",
            status: ResourceStatus.ACTIVE,
          }),
        },
        webhookDelivery: { findMany: jest.fn() },
      };

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeConfig() as never,
      );

      await expect(
        service.listDeliveries("org_1", "webhook_1", { cursor: "garbage" }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.webhookDelivery.findMany).not.toHaveBeenCalled();
    });
  });

  describe("listForOrg", () => {
    it("returns a deterministic page of webhooks for the organisation", async () => {
      const prisma = {
        webhook: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: "wh_1",
              url: "https://example.com/hook",
              events: ["proof.created"],
              status: ResourceStatus.ACTIVE,
              createdAt: new Date("2026-08-24T12:00:00.000Z"),
              updatedAt: new Date("2026-08-24T12:00:00.000Z"),
            },
          ]),
        },
      };

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeConfig() as never,
      );

      const result = await service.listForOrg("org_1");

      expect(result.data).toHaveLength(1);
      expect(result.pageInfo).toEqual({ hasMore: false, nextCursor: null });
      expect(prisma.webhook.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: "org_1" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
      );
    });
  });

  describe("create — verification gating", () => {
    it("creates the webhook PENDING and issues a challenge for the new destination", async () => {
      const prisma = {
        webhook: {
          create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({
              id: "webhook_1",
              url: data.url,
              events: data.events,
              status: data.status,
              createdAt: new Date(),
            }),
          ),
        },
      };
      Object.assign(prisma, {
        $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      });
      const verificationService = makeVerificationService();

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeCircuitBreaker() as never,
        verificationService,
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      const result = await service.create("org_1", {
        url: "https://example.com/hook",
        events: ["proof.created"],
      });

      expect(result.status).toBe(ResourceStatus.PENDING);
      expect(verificationService.issueChallenge).toHaveBeenCalledWith(
        "webhook_1",
        "https://example.com/hook",
        result.signingSecret,
      );
    });
  });

  describe("updateUrl", () => {
    it("reverts status to PENDING and issues a challenge for the new URL", async () => {
      const secretEncrypted = encryptProtectedAmount(
        "current-secret",
        ENCRYPTION_KEYRING,
        0,
      );
      let updateData: Record<string, unknown> = {};

      const prisma = {
        webhook: {
          findUnique: jest.fn().mockResolvedValue({
            id: "webhook_1",
            organizationId: "org_1",
            url: "https://old.example.com/hook",
            secretEncrypted,
            status: ResourceStatus.ACTIVE,
          }),
          update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            updateData = data;
            return Promise.resolve({
              id: "webhook_1",
              url: data.url,
              events: ["proof.created"],
              status: data.status,
              updatedAt: new Date(),
            });
          }),
        },
      };
      const verificationService = makeVerificationService();

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeCircuitBreaker() as never,
        verificationService,
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      const result = await service.updateUrl("org_1", "webhook_1", {
        url: "https://new.example.com/hook",
      });

      expect(updateData.status).toBe(ResourceStatus.PENDING);
      expect(result.status).toBe(ResourceStatus.PENDING);
      expect(verificationService.issueChallenge).toHaveBeenCalledWith(
        "webhook_1",
        "https://new.example.com/hook",
        "current-secret",
      );
    });

    it("throws ForbiddenException if the webhook belongs to a different org", async () => {
      const prisma = {
        webhook: {
          findUnique: jest.fn().mockResolvedValue({
            id: "webhook_1",
            organizationId: "org_other",
            url: "https://example.com/hook",
            secretEncrypted: "irrelevant",
            status: ResourceStatus.ACTIVE,
          }),
        },
      };

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeCircuitBreaker() as never,
        makeVerificationService(),
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      await expect(
        service.updateUrl("org_mine", "webhook_1", { url: "https://new.example.com/hook" }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("resendVerification", () => {
    it("re-issues a challenge for a PENDING webhook", async () => {
      const secretEncrypted = encryptProtectedAmount(
        "current-secret",
        ENCRYPTION_KEYRING,
        0,
      );
      const prisma = {
        webhook: {
          findUnique: jest.fn().mockResolvedValue({
            id: "webhook_1",
            organizationId: "org_1",
            url: "https://example.com/hook",
            secretEncrypted,
            status: ResourceStatus.PENDING,
          }),
        },
      };
      const verificationService = makeVerificationService();

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeCircuitBreaker() as never,
        verificationService,
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      const result = await service.resendVerification("org_1", "webhook_1");

      expect(result.status).toBe(ResourceStatus.PENDING);
      expect(verificationService.issueChallenge).toHaveBeenCalledWith(
        "webhook_1",
        "https://example.com/hook",
        "current-secret",
      );
    });

    it("rejects re-sending verification for an already-ACTIVE webhook", async () => {
      const prisma = {
        webhook: {
          findUnique: jest.fn().mockResolvedValue({
            id: "webhook_1",
            organizationId: "org_1",
            url: "https://example.com/hook",
            secretEncrypted: "irrelevant",
            status: ResourceStatus.ACTIVE,
          }),
        },
      };

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeCircuitBreaker() as never,
        makeVerificationService(),
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      await expect(
        service.resendVerification("org_1", "webhook_1"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("verify", () => {
    it("activates the webhook once the verification service confirms the token", async () => {
      const prisma = {
        webhook: {
          findUnique: jest.fn().mockResolvedValue({
            id: "webhook_1",
            organizationId: "org_1",
            status: ResourceStatus.PENDING,
          }),
          update: jest.fn().mockResolvedValue({
            id: "webhook_1",
            status: ResourceStatus.ACTIVE,
            updatedAt: new Date(),
          }),
        },
      };
      const verificationService = makeVerificationService();

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeCircuitBreaker() as never,
        verificationService,
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      const result = await service.verify("org_1", "webhook_1", { token: "the-token" });

      expect(verificationService.verifyChallenge).toHaveBeenCalledWith(
        "webhook_1",
        "the-token",
      );
      expect(result.status).toBe(ResourceStatus.ACTIVE);
    });

    it("propagates rejection for an invalid or replayed token without activating", async () => {
      const prisma = {
        webhook: {
          findUnique: jest.fn().mockResolvedValue({
            id: "webhook_1",
            organizationId: "org_1",
            status: ResourceStatus.PENDING,
          }),
          update: jest.fn(),
        },
      };
      const verificationService = makeVerificationService();
      verificationService.verifyChallenge.mockRejectedValue(
        new BadRequestException("Invalid or expired verification token"),
      );

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeCircuitBreaker() as never,
        verificationService,
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      await expect(
        service.verify("org_1", "webhook_1", { token: "bad-token" }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.webhook.update).not.toHaveBeenCalled();
    });

    it("throws ForbiddenException if the webhook belongs to a different org", async () => {
      const prisma = {
        webhook: {
          findUnique: jest.fn().mockResolvedValue({
            id: "webhook_1",
            organizationId: "org_other",
            status: ResourceStatus.PENDING,
          }),
        },
      };

      const service = new WebhooksService(
        prisma as never,
        makeDeliveryService(),
        makeCircuitBreaker() as never,
        makeVerificationService(),
        makeConfig() as never,
        unlimitedQuotas() as never,
      );

      await expect(
        service.verify("org_mine", "webhook_1", { token: "x" }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
