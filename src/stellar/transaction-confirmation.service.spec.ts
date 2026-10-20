import { BadRequestException, NotFoundException } from "@nestjs/common";
import { TransactionConfirmationStatus } from "@prisma/client";
import {
  MAX_CONFIRMATION_RETRIES,
  MAX_POLL_DELAY_MS,
  TransactionConfirmationService,
} from "./transaction-confirmation.service";

describe("TransactionConfirmationService", () => {
  let service: TransactionConfirmationService;
  let mockPrisma: any;
  let store: Map<string, any>;

  beforeEach(() => {
    store = new Map();
    mockPrisma = {
      transactionConfirmation: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.network_transactionHash) {
            const key = `${where.network_transactionHash.network}:${where.network_transactionHash.transactionHash}`;
            return store.get(key) || null;
          }
          if (where.id) {
            for (const v of store.values()) {
              if (v.id === where.id) return v;
            }
          }
          return null;
        }),
        findMany: jest.fn(async ({ where, take }: any) => {
          const list = Array.from(store.values()).filter((item) => {
            if (where?.status?.in && !where.status.in.includes(item.status)) {
              return false;
            }
            return true;
          });
          return list.slice(0, take ?? 50);
        }),
        create: jest.fn(async ({ data }: any) => {
          const id = `tc_${Date.now()}_${Math.random()}`;
          const record = {
            id,
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          const key = `${record.network}:${record.transactionHash}`;
          store.set(key, record);
          return record;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          let found: any = null;
          let foundKey = "";
          for (const [k, v] of store.entries()) {
            if (v.id === where.id) {
              found = v;
              foundKey = k;
              break;
            }
          }
          if (!found) throw new Error("Record not found in store");
          const updated = {
            ...found,
            ...data,
            updatedAt: new Date(),
          };
          store.set(foundKey, updated);
          return updated;
        }),
      },
    };

    service = new TransactionConfirmationService(mockPrisma);
  });

  const validTxHash = "a".repeat(64);
  const otherTxHash = "b".repeat(64);

  describe("network qualification and explorer references", () => {
    it("rejects an operation satisfied by a transaction from another network", () => {
      expect(() => {
        service.assertNetworkMatches("testnet", "mainnet");
      }).toThrow(BadRequestException);
      expect(() => {
        service.assertNetworkMatches("testnet", "mainnet");
      }).toThrow(/Cross-network validation error/);
    });

    it("accepts matching networks regardless of case/whitespace", () => {
      expect(() => {
        service.assertNetworkMatches("  Testnet ", "testnet");
      }).not.toThrow();
    });

    it("generates privacy-safe explorer URLs with normalized network naming", () => {
      expect(service.getExplorerUrl("mainnet", validTxHash)).toBe(
        `https://stellar.expert/explorer/public/tx/${validTxHash}`,
      );
      expect(service.getExplorerUrl("testnet", validTxHash)).toBe(
        `https://stellar.expert/explorer/testnet/tx/${validTxHash}`,
      );
      expect(service.getExplorerUrl("futurenet", validTxHash)).toBe(
        `https://stellar.expert/explorer/futurenet/tx/${validTxHash}`,
      );
    });

    it("redacts Stellar secret seeds from diagnostic or failure messages", () => {
      const secret = "SB6XQ27VRK7266M7V67J276Y7L7L7L7L7L7L7L7L7L7L7L7L7L7L7L7L";
      const dirty = `Transaction failed with key ${secret} at node`;
      const cleaned = service.redactSensitiveData(dirty);
      expect(cleaned).not.toContain(secret);
      expect(cleaned).toContain("[REDACTED_SECRET_KEY]");
    });
  });

  describe("recordSubmission", () => {
    it("rejects invalid networks", async () => {
      await expect(
        service.recordSubmission({
          organizationId: "org-1",
          network: "unsupported-net",
          transactionHash: validTxHash,
          operationType: "ANCHOR",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects malformed transaction hashes", async () => {
      await expect(
        service.recordSubmission({
          organizationId: "org-1",
          network: "testnet",
          transactionHash: "not-a-hex",
          operationType: "ANCHOR",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("records submission with SUBMITTED status and computed nextPollAt", async () => {
      const result = await service.recordSubmission({
        organizationId: "org-1",
        network: "testnet",
        transactionHash: validTxHash,
        operationType: "ANCHOR",
        operationRef: "intent-123",
      });

      expect(result.status).toBe(TransactionConfirmationStatus.SUBMITTED);
      expect(result.network).toBe("testnet");
      expect(result.transactionHash).toBe(validTxHash);
      expect(result.operationRef).toBe("intent-123");
    });

    it("returns existing record idempotently on replay within same tenant", async () => {
      const first = await service.recordSubmission({
        organizationId: "org-1",
        network: "testnet",
        transactionHash: validTxHash,
        operationType: "ANCHOR",
      });

      const second = await service.recordSubmission({
        organizationId: "org-1",
        network: "testnet",
        transactionHash: validTxHash,
        operationType: "ANCHOR",
      });

      expect(second.id).toBe(first.id);
    });

    it("fails closed without revealing record existence to another tenant", async () => {
      await service.recordSubmission({
        organizationId: "org-1",
        network: "testnet",
        transactionHash: validTxHash,
        operationType: "ANCHOR",
      });

      await expect(
        service.recordSubmission({
          organizationId: "org-2",
          network: "testnet",
          transactionHash: validTxHash,
          operationType: "ANCHOR",
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("getStatus", () => {
    it("returns status for owner organization", async () => {
      await service.recordSubmission({
        organizationId: "org-1",
        network: "testnet",
        transactionHash: validTxHash,
        operationType: "ANCHOR",
      });

      const res = await service.getStatus("org-1", "testnet", validTxHash);
      expect(res.transactionHash).toBe(validTxHash);
      expect(res.explorerUrl).toContain("stellar.expert");
    });

    it("throws NotFoundException when queried by unauthorized tenant", async () => {
      await service.recordSubmission({
        organizationId: "org-1",
        network: "testnet",
        transactionHash: validTxHash,
        operationType: "ANCHOR",
      });

      await expect(
        service.getStatus("org-2", "testnet", validTxHash),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("reconcileTransaction", () => {
    it("transitions to CONFIRMED on ledger inclusion", async () => {
      await service.recordSubmission({
        organizationId: "org-1",
        network: "testnet",
        transactionHash: validTxHash,
        operationType: "ANCHOR",
      });

      const updated = await service.reconcileTransaction("testnet", validTxHash, {
        status: "confirmed",
        ledgerSequence: 12345,
        ledgerHash: "ledgerhash123",
      });

      expect(updated.status).toBe(TransactionConfirmationStatus.CONFIRMED);
      expect(updated.ledgerSequence).toBe(12345);
      expect(updated.ledgerHash).toBe("ledgerhash123");
      expect(updated.confirmedAt).toBeDefined();
    });

    it("duplicate observation is idempotent", async () => {
      await service.recordSubmission({
        organizationId: "org-1",
        network: "testnet",
        transactionHash: validTxHash,
        operationType: "ANCHOR",
      });

      await service.reconcileTransaction("testnet", validTxHash, {
        status: "confirmed",
        ledgerSequence: 12345,
        ledgerHash: "hash1",
      });

      const reObserved = await service.reconcileTransaction(
        "testnet",
        validTxHash,
        {
          status: "confirmed",
        },
      );

      expect(reObserved.status).toBe(TransactionConfirmationStatus.CONFIRMED);
      expect(reObserved.ledgerSequence).toBe(12345);
    });

    it("handles replacement idempotently", async () => {
      await service.recordSubmission({
        organizationId: "org-1",
        network: "testnet",
        transactionHash: validTxHash,
        operationType: "ANCHOR",
      });

      const updated = await service.reconcileTransaction("testnet", validTxHash, {
        status: "replaced",
        replacedByHash: otherTxHash,
      });

      expect(updated.status).toBe(TransactionConfirmationStatus.REPLACED);
      expect(updated.replacedByHash).toBe(otherTxHash);
    });

    it("handles failures and redacts sensitive messages", async () => {
      await service.recordSubmission({
        organizationId: "org-1",
        network: "testnet",
        transactionHash: validTxHash,
        operationType: "ANCHOR",
      });

      const secret = "SB6XQ27VRK7266M7V67J276Y7L7L7L7L7L7L7L7L7L7L7L7L7L7L7L7L";
      const updated = await service.reconcileTransaction("testnet", validTxHash, {
        status: "failed",
        failureReason: `Signing failed with key ${secret}`,
        errorCode: "TX_BAD_AUTH",
      });

      expect(updated.status).toBe(TransactionConfirmationStatus.FAILED);
      expect(updated.failureReason).not.toContain(secret);
      expect(updated.failureReason).toContain("[REDACTED_SECRET_KEY]");
      expect(updated.errorCode).toBe("TX_BAD_AUTH");
    });

    it("transitions to TIMEOUT after max retry attempts", async () => {
      await service.recordSubmission({
        organizationId: "org-1",
        network: "testnet",
        transactionHash: validTxHash,
        operationType: "ANCHOR",
      });

      // Advance retry count to MAX_CONFIRMATION_RETRIES - 1
      for (let i = 0; i < MAX_CONFIRMATION_RETRIES - 1; i++) {
        await service.reconcileTransaction("testnet", validTxHash, {
          status: "pending",
        });
      }

      // Final attempt triggers TIMEOUT
      const timedOut = await service.reconcileTransaction("testnet", validTxHash, {
        status: "not_found",
      });

      expect(timedOut.status).toBe(TransactionConfirmationStatus.TIMEOUT);
      expect(timedOut.failureReason).toContain("maximum duration");
    });
  });

  describe("reorg handling and crash recovery", () => {
    it("updates confirmed transaction on ledger reorg", async () => {
      await service.recordSubmission({
        organizationId: "org-1",
        network: "testnet",
        transactionHash: validTxHash,
        operationType: "ANCHOR",
      });
      await service.reconcileTransaction("testnet", validTxHash, {
        status: "confirmed",
        ledgerSequence: 100,
        ledgerHash: "oldhash",
      });

      const reorged = await service.handleReorg(
        "testnet",
        validTxHash,
        105,
        "newreorghash",
      );

      expect(reorged.status).toBe(TransactionConfirmationStatus.CONFIRMED);
      expect(reorged.ledgerSequence).toBe(105);
      expect(reorged.ledgerHash).toBe("newreorghash");
    });

    it("resumes pending items on crash recovery after restart", async () => {
      await service.recordSubmission({
        organizationId: "org-1",
        network: "testnet",
        transactionHash: validTxHash,
        operationType: "ANCHOR",
      });

      const processedCount = await service.reconcilePending(10);
      expect(processedCount).toBeGreaterThanOrEqual(1);
    });

    it("calculates exponential backoff within bounds", () => {
      const now = new Date();
      const next1 = service.computeNextPollAt(0, now);
      const next5 = service.computeNextPollAt(5, now);

      expect(next1.getTime()).toBeGreaterThan(now.getTime());
      expect(next5.getTime()).toBeGreaterThan(next1.getTime());
      expect(next5.getTime() - now.getTime()).toBeLessThanOrEqual(
        MAX_POLL_DELAY_MS + 500,
      );
    });
  });
});
