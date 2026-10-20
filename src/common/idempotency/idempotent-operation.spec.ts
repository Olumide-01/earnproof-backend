import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IdempotencyStatus } from "@prisma/client";
import { IdempotencyService } from "../services/idempotency.service";
import { IdempotentOperationController } from "./idempotent-operation.controller";

describe("IdempotentOperation", () => {
  let service: IdempotencyService;
  let controller: IdempotentOperationController;
  let mockPrisma: any;
  let store: Map<string, any>;

  beforeEach(() => {
    store = new Map();

    mockPrisma = {
      idempotencyRecord: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.organizationId_idempotencyKey) {
            const key = `${where.organizationId_idempotencyKey.organizationId}:${where.organizationId_idempotencyKey.idempotencyKey}`;
            return store.get(key) || null;
          }
          if (where.id) {
            for (const v of store.values()) {
              if (v.id === where.id) return v;
            }
          }
          return null;
        }),
        create: jest.fn(async ({ data }: any) => {
          const key = `${data.organizationId}:${data.idempotencyKey}`;
          if (store.has(key)) {
            const err: any = new Error("Unique constraint failed");
            err.code = "P2002";
            throw err;
          }
          const record = {
            id: `idemp_${Date.now()}_${Math.random()}`,
            ...data,
            attemptCount: data.attemptCount ?? 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          store.set(key, record);
          return record;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          let foundKey = "";
          let found: any = null;
          for (const [k, v] of store.entries()) {
            if (v.id === where.id) {
              found = v;
              foundKey = k;
              break;
            }
          }
          if (!found) throw new Error("Record not found");
          const updated = { ...found, ...data, updatedAt: new Date() };
          store.set(foundKey, updated);
          return updated;
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const [k, v] of store.entries()) {
            if (
              v.organizationId === where.organizationId &&
              v.idempotencyKey === where.idempotencyKey
            ) {
              store.set(k, { ...v, ...data, updatedAt: new Date() });
              count++;
            }
          }
          return { count };
        }),
      },
      organizationMember: {
        findFirst: jest.fn(async ({ where }: any) => {
          if (where.organizationId === "org-unauthorized") {
            return null;
          }
          if (where.organizationId) {
            return { organizationId: where.organizationId, role: "MEMBER" };
          }
          return { organizationId: "org-1", role: "MEMBER" };
        }),
      },
    };

    const mockConfig = {
      get: jest.fn((key: string, def?: string) => def ?? "24"),
    } as unknown as ConfigService;

    service = new IdempotencyService(mockPrisma, mockConfig);
    controller = new IdempotentOperationController(service, mockPrisma);
  });

  const orgId = "org-1";
  const user = {
    id: "user-1",
    walletAddress: "GABC",
    walletHash: "hash",
    role: "MEMBER",
  };

  describe("Service: reserve and replay integrity", () => {
    it("reserves new key with typed operation and resource references", async () => {
      const key = "req-1";
      const fp = service.computeFingerprint("POST", "/proofs", { amount: 100 });

      await service.reserve(orgId, key, fp, {
        operationType: "PROOF_CREATE",
        resourceType: "proof",
        resourceId: "proof-temp",
      });

      const check = await service.check(orgId, key, fp);
      expect(check.isNew).toBe(false);
      expect(check.record?.status).toBe(IdempotencyStatus.PENDING);
      expect(check.record?.resourceType).toBe("proof");
    });

    it("rejects payload mismatch on replay with 409 ConflictException", async () => {
      const key = "req-2";
      const fpOriginal = service.computeFingerprint("POST", "/proofs", {
        amount: 100,
      });
      const fpModified = service.computeFingerprint("POST", "/proofs", {
        amount: 200,
      });

      await service.reserve(orgId, key, fpOriginal);

      await expect(service.check(orgId, key, fpModified)).rejects.toThrow(
        ConflictException,
      );
    });

    it("handles concurrency on reserve and increments attemptCount on identical replay", async () => {
      const key = "req-concurrent";
      const fp = service.computeFingerprint("POST", "/proofs", {});

      await service.reserve(orgId, key, fp);
      // Concurrent second reserve with matching fingerprint
      await service.reserve(orgId, key, fp);

      const status = await service.getOperationStatus(orgId, key);
      expect(status.attemptCount).toBe(2);
    });

    it("stores stripped response body and consistency token on success", async () => {
      const key = "req-success";
      const fp = service.computeFingerprint("POST", "/proofs", {});

      await service.reserve(orgId, key, fp, { operationType: "PROOF_CREATE" });
      await service.success(
        orgId,
        key,
        {
          id: "proof-999",
          status: "ISSUED",
          secretApiKey: "SECRET_VALUE_MUST_BE_STRIPPED",
        },
        201,
        {
          resourceType: "proof",
          resourceId: "proof-999",
          consistencyToken: "token-abc.xyz",
        },
      );

      const status = await service.getOperationStatus(orgId, key);
      expect(status.status).toBe("COMPLETED");
      expect(status.resourceId).toBe("proof-999");
      expect(status.consistencyToken).toBe("token-abc.xyz");
      expect(status.responseBody.secretApiKey).toBeUndefined();
      expect(status.terminal).toBe(true);
      expect(status.retryable).toBe(false);
    });

    it("marks failed operations as terminal and retryable", async () => {
      const key = "req-fail";
      const fp = service.computeFingerprint("POST", "/proofs", {});

      await service.reserve(orgId, key, fp);
      await service.failure(orgId, key);

      const status = await service.getOperationStatus(orgId, key);
      expect(status.status).toBe("FAILED");
      expect(status.terminal).toBe(true);
      expect(status.retryable).toBe(true);
    });

    it("cancels a pending operation with reason", async () => {
      const key = "req-cancel";
      const fp = service.computeFingerprint("POST", "/proofs", {});

      await service.reserve(orgId, key, fp);
      await service.cancel(orgId, key, "User aborted operation");

      const status = await service.getOperationStatus(orgId, key);
      expect(status.status).toBe("CANCELLED");
      expect(status.cancellationReason).toBe("User aborted operation");
      expect(status.terminal).toBe(true);
      expect(status.retryable).toBe(true);
    });

    it("prevents cancelling already completed operations", async () => {
      const key = "req-done";
      const fp = service.computeFingerprint("POST", "/proofs", {});

      await service.reserve(orgId, key, fp);
      await service.success(orgId, key, { success: true }, 200);

      await expect(service.cancel(orgId, key)).rejects.toThrow(ConflictException);
    });

    it("detects expired operations beyond retention bounds", async () => {
      const key = "req-expired";
      const fp = service.computeFingerprint("POST", "/proofs", {});

      await service.reserve(orgId, key, fp);

      // Force expiration in store
      const stored = store.get(`${orgId}:${key}`);
      stored.expiresAt = new Date(Date.now() - 1000);

      const status = await service.getOperationStatus(orgId, key);
      expect(status.status).toBe("EXPIRED");
      expect(status.terminal).toBe(true);
      expect(status.retryable).toBe(true);
    });

    it("fails closed on unknown keys without revealing cross-tenant existence", async () => {
      const key = "tenant-isolation-key";
      const fp = service.computeFingerprint("POST", "/proofs", {});

      // Reserved under org-1
      await service.reserve("org-1", key, fp);

      // Queried under org-2
      await expect(service.getOperationStatus("org-2", key)).rejects.toThrow(
        NotFoundException,
      );

      // Completely nonexistent key
      await expect(
        service.getOperationStatus("org-1", "nonexistent-key"),
      ).rejects.toThrow(NotFoundException);
    });

    it("validates key format strictly", () => {
      expect(() => service.validateKey("")).toThrow(BadRequestException);
      expect(() => service.validateKey("invalid key with spaces")).toThrow(
        BadRequestException,
      );
      expect(() => service.validateKey("a".repeat(256))).toThrow(
        BadRequestException,
      );
    });
  });

  describe("Controller: authorization and tenant scoping", () => {
    it("returns operation status for authorized tenant", async () => {
      const key = "controller-key-1";
      const fp = service.computeFingerprint("POST", "/proofs", {});
      await service.reserve("org-1", key, fp, {
        operationType: "PAYMENT_SYNC",
        resourceType: "payment",
        resourceId: "pay-10",
      });

      const res = await controller.getStatus(user, key, undefined);
      expect(res.idempotencyKey).toBe(key);
      expect(res.organizationId).toBe("org-1");
      expect(res.operationType).toBe("PAYMENT_SYNC");
    });

    it("cancels pending operation via controller endpoint", async () => {
      const key = "controller-cancel-key";
      const fp = service.computeFingerprint("POST", "/proofs", {});
      await service.reserve("org-1", key, fp);

      const res = await controller.cancel(
        user,
        key,
        { reason: "Client timeout" },
        undefined,
      );
      expect(res.cancelled).toBe(true);

      const status = await controller.getStatus(user, key, undefined);
      expect(status.status).toBe("CANCELLED");
      expect(status.cancellationReason).toBe("Client timeout");
    });

    it("rejects unauthorized organization header", async () => {
      await expect(
        controller.getStatus(user, "key-1", "org-unauthorized"),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
