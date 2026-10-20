import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CheckpointHealthClassification } from "@prisma/client";
import {
  DEFAULT_STALL_LEDGER_THRESHOLD,
  MAX_SNAPSHOTS_PER_USER,
  PaymentCheckpointHealthService,
} from "./payment-checkpoint-health.service";

describe("PaymentCheckpointHealthService", () => {
  let service: PaymentCheckpointHealthService;
  let prismaMock: any;
  let configServiceMock: any;

  beforeEach(() => {
    prismaMock = {
      paymentSyncCheckpoint: {
        findUnique: jest.fn(),
      },
      paymentCheckpointHealthSnapshot: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
        deleteMany: jest.fn(),
      },
      organization: {
        findUnique: jest.fn(),
      },
    };

    configServiceMock = {
      get: jest.fn().mockReturnValue(DEFAULT_STALL_LEDGER_THRESHOLD),
    };

    service = new PaymentCheckpointHealthService(
      prismaMock as any,
      configServiceMock as ConfigService,
    );
  });

  describe("classify", () => {
    it("classifies as REORGANIZATION_RECOVERY when divergenceReason is present", () => {
      const result = service.classify(5, "checkpoint_record_replaced", null);
      expect(result).toBe(CheckpointHealthClassification.REORGANIZATION_RECOVERY);
    });

    it("classifies as REORGANIZATION_RECOVERY when isReorganizing is true", () => {
      const result = service.classify(5, null, null, true);
      expect(result).toBe(CheckpointHealthClassification.REORGANIZATION_RECOVERY);
    });

    it("classifies as RATE_LIMITING when error status is 429", () => {
      const result = service.classify(10, null, { status: 429 });
      expect(result).toBe(CheckpointHealthClassification.RATE_LIMITING);
    });

    it("classifies as RATE_LIMITING when error code is RATE_LIMIT", () => {
      const result = service.classify(10, null, { code: "RATE_LIMIT" });
      expect(result).toBe(CheckpointHealthClassification.RATE_LIMITING);
    });

    it("classifies as HORIZON_OUTAGE on 503 or 500 error", () => {
      expect(service.classify(10, null, { status: 503 })).toBe(
        CheckpointHealthClassification.HORIZON_OUTAGE,
      );
      expect(service.classify(10, null, { status: 500 })).toBe(
        CheckpointHealthClassification.HORIZON_OUTAGE,
      );
    });

    it("classifies as HORIZON_OUTAGE on network connection errors", () => {
      expect(service.classify(10, null, { code: "ECONNREFUSED" })).toBe(
        CheckpointHealthClassification.HORIZON_OUTAGE,
      );
      expect(
        service.classify(10, null, { message: "Horizon service unavailable outage" }),
      ).toBe(CheckpointHealthClassification.HORIZON_OUTAGE);
    });

    it("classifies as STALLED_INGESTION when lag exceeds threshold without errors", () => {
      const result = service.classify(250, null, null);
      expect(result).toBe(CheckpointHealthClassification.STALLED_INGESTION);
    });

    it("classifies as NORMAL_LAG when lag is within acceptable bounds", () => {
      const result = service.classify(10, null, null);
      expect(result).toBe(CheckpointHealthClassification.NORMAL_LAG);
    });
  });

  describe("recordSnapshot", () => {
    it("successfully records snapshot without leaking raw memo, amount or counterparty", async () => {
      prismaMock.paymentSyncCheckpoint.findUnique.mockResolvedValueOnce({
        ledgerSequence: 1000,
        status: "VERIFIED",
      });

      prismaMock.paymentCheckpointHealthSnapshot.create.mockImplementation(({ data }: any) => ({
        id: "snap_1",
        ...data,
      }));

      const snapshot = await service.recordSnapshot({
        userId: "user_1",
        organizationId: "org_1",
        network: "testnet",
        walletAddressHash: "hash_abc",
        ledgerSequence: 1050,
        latestKnownLedger: 1060,
        pagingToken: "1050-01",
      });

      expect(snapshot).toBeDefined();
      expect(snapshot.ledgerLag).toBe(10);
      expect(snapshot.classification).toBe(CheckpointHealthClassification.NORMAL_LAG);
      expect(prismaMock.paymentCheckpointHealthSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user_1",
          organizationId: "org_1",
          network: "testnet",
          walletAddressHash: "hash_abc",
          ledgerSequence: 1050,
          latestKnownLedger: 1060,
          ledgerLag: 10,
        }),
      });

      // Assert created metadata contains no memo, amount, counterparty
      const callData = prismaMock.paymentCheckpointHealthSnapshot.create.mock.calls[0][0].data;
      expect(callData.metadata).not.toHaveProperty("memo");
      expect(callData.metadata).not.toHaveProperty("amount");
      expect(callData.metadata).not.toHaveProperty("counterparty");
    });

    it("fails with BadRequestException on checkpoint regression", async () => {
      prismaMock.paymentSyncCheckpoint.findUnique.mockResolvedValueOnce({
        ledgerSequence: 2000,
        status: "VERIFIED",
      });

      await expect(
        service.recordSnapshot({
          userId: "user_1",
          network: "testnet",
          walletAddressHash: "hash_abc",
          ledgerSequence: 1900, // older than verified 2000
          latestKnownLedger: 2050,
          pagingToken: "1900-01",
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prismaMock.paymentCheckpointHealthSnapshot.create).not.toHaveBeenCalled();
    });

    it("allows older sequence during reorg recovery", async () => {
      prismaMock.paymentSyncCheckpoint.findUnique.mockResolvedValueOnce({
        ledgerSequence: 2000,
        status: "VERIFIED",
      });

      prismaMock.paymentCheckpointHealthSnapshot.create.mockImplementation(({ data }: any) => ({
        id: "snap_reorg",
        ...data,
      }));

      const snapshot = await service.recordSnapshot({
        userId: "user_1",
        network: "testnet",
        walletAddressHash: "hash_abc",
        ledgerSequence: 1900,
        latestKnownLedger: 2050,
        pagingToken: "1900-01",
        divergenceReason: "ledger_missing",
        isReorganizing: true,
      });

      expect(snapshot).toBeDefined();
      expect(snapshot.classification).toBe(CheckpointHealthClassification.REORGANIZATION_RECOVERY);
    });

    it("prunes excess snapshots when user count exceeds maximum", async () => {
      prismaMock.paymentSyncCheckpoint.findUnique.mockResolvedValueOnce(null);
      prismaMock.paymentCheckpointHealthSnapshot.create.mockResolvedValueOnce({ id: "snap_new" });
      prismaMock.paymentCheckpointHealthSnapshot.count.mockResolvedValueOnce(MAX_SNAPSHOTS_PER_USER + 5);
      prismaMock.paymentCheckpointHealthSnapshot.findMany.mockResolvedValueOnce([
        { id: "old_1" },
        { id: "old_2" },
        { id: "old_3" },
        { id: "old_4" },
        { id: "old_5" },
      ]);

      await service.recordSnapshot({
        userId: "user_1",
        network: "testnet",
        walletAddressHash: "hash_abc",
        ledgerSequence: 100,
        latestKnownLedger: 105,
        pagingToken: "100-01",
      });

      expect(prismaMock.paymentCheckpointHealthSnapshot.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["old_1", "old_2", "old_3", "old_4", "old_5"] } },
      });
    });
  });

  describe("getTenantSummary", () => {
    it("computes tenant metrics across distinct user accounts", async () => {
      prismaMock.organization.findUnique.mockResolvedValueOnce({ id: "org_123" });
      prismaMock.paymentCheckpointHealthSnapshot.findMany.mockResolvedValueOnce([
        {
          userId: "u1",
          classification: CheckpointHealthClassification.NORMAL_LAG,
          ledgerLag: 5,
          isStalled: false,
          isReorganizing: false,
        },
        {
          userId: "u2",
          classification: CheckpointHealthClassification.STALLED_INGESTION,
          ledgerLag: 200,
          isStalled: true,
          isReorganizing: false,
        },
        {
          userId: "u3",
          classification: CheckpointHealthClassification.REORGANIZATION_RECOVERY,
          ledgerLag: 50,
          isStalled: false,
          isReorganizing: true,
        },
      ]);

      const summary = await service.getTenantSummary("org_123");

      expect(summary.totalAccounts).toBe(3);
      expect(summary.maxLag).toBe(200);
      expect(summary.avgLag).toBe(85);
      expect(summary.stalledAccountsCount).toBe(1);
      expect(summary.reorganizingAccountsCount).toBe(1);
      expect(summary.countsByClassification[CheckpointHealthClassification.NORMAL_LAG]).toBe(1);
      expect(summary.countsByClassification[CheckpointHealthClassification.STALLED_INGESTION]).toBe(1);
      expect(summary.countsByClassification[CheckpointHealthClassification.REORGANIZATION_RECOVERY]).toBe(1);
    });

    it("throws NotFoundException if organization does not exist", async () => {
      prismaMock.organization.findUnique.mockResolvedValueOnce(null);

      await expect(service.getTenantSummary("invalid_org")).rejects.toThrow(NotFoundException);
    });
  });

  describe("retrySync", () => {
    it("allows a user to retry their own sync", async () => {
      prismaMock.paymentSyncCheckpoint.findUnique.mockResolvedValueOnce({
        userId: "user_1",
        ledgerSequence: 500,
        pagingToken: "500-0",
        status: "VERIFIED",
        divergenceReason: null,
      });

      prismaMock.paymentCheckpointHealthSnapshot.findFirst.mockResolvedValueOnce({
        recoveryAttempts: 1,
        latestKnownLedger: 550,
        network: "testnet",
        walletAddressHash: "hash_1",
      });

      prismaMock.paymentCheckpointHealthSnapshot.create.mockResolvedValueOnce({ id: "retry_snap" });

      const res = await service.retrySync(
        { id: "user_1", role: "WORKER" },
        { maxPages: 5 },
      );

      expect(res.status).toBe("RETRY_TRIGGERED");
      expect(res.targetUserId).toBe("user_1");
      expect(res.recoveryAttempts).toBe(2);
    });

    it("forbids non-admin user from retrying another user's sync", async () => {
      await expect(
        service.retrySync(
          { id: "user_1", role: "WORKER" },
          { userId: "user_other" },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("allows admin to retry another user's sync", async () => {
      prismaMock.paymentSyncCheckpoint.findUnique.mockResolvedValueOnce({
        userId: "user_other",
        ledgerSequence: 500,
        pagingToken: "500-0",
        status: "VERIFIED",
        divergenceReason: null,
      });

      prismaMock.paymentCheckpointHealthSnapshot.findFirst.mockResolvedValueOnce({
        recoveryAttempts: 0,
        latestKnownLedger: 550,
        network: "testnet",
        walletAddressHash: "hash_2",
      });

      prismaMock.paymentCheckpointHealthSnapshot.create.mockResolvedValueOnce({ id: "retry_admin" });

      const res = await service.retrySync(
        { id: "admin_user", role: "ADMIN" },
        { userId: "user_other" },
      );

      expect(res.status).toBe("RETRY_TRIGGERED");
      expect(res.targetUserId).toBe("user_other");
    });
  });
});
