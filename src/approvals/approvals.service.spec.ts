import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ApprovalRequestStatus } from "@prisma/client";
import { Test, TestingModule } from "@nestjs/testing";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import { PrismaService } from "../database/prisma.service";
import { ApprovalsService } from "./approvals.service";

describe("ApprovalsService", () => {
  let service: ApprovalsService;
  let prisma: {
    approvalRequest: {
      create: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
    };
    auditLog: { create: jest.Mock };
  };

  const requester = { id: "user-1", walletAddress: "G1", walletHash: "h1", role: "WORKER" };
  const approver = { id: "user-2", walletAddress: "G2", walletHash: "h2", role: "ADMIN" };

  const payload = { organizationId: "org_1", allowedRegions: ["eu-west-1"] };
  const payloadHash = sha256(canonicalize(payload));

  function pendingRequest(overrides: Record<string, unknown> = {}) {
    return {
      id: "req-1",
      operationType: "organization.residency_policy.override",
      payload,
      payloadHash,
      requestedById: requester.id,
      status: ApprovalRequestStatus.PENDING,
      decidedById: null,
      decidedAt: null,
      decisionReason: null,
      executionLeaseToken: null,
      executionLeasedAt: null,
      executedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApprovalsService,
        {
          provide: PrismaService,
          useValue: {
            approvalRequest: {
              create: jest.fn(),
              findUnique: jest.fn(),
              updateMany: jest.fn(),
            },
            auditLog: { create: jest.fn() },
          },
        },
      ],
    }).compile();

    service = module.get(ApprovalsService);
    prisma = module.get(PrismaService) as unknown as typeof prisma;
  });

  // ---------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------

  describe("create", () => {
    it("pins the payload hash and a default 24h expiry", async () => {
      prisma.approvalRequest.create.mockResolvedValue(pendingRequest());

      await service.create(requester, {
        operationType: "organization.residency_policy.override",
        payload,
      });

      const createArgs = prisma.approvalRequest.create.mock.calls[0][0];
      expect(createArgs.data.payloadHash).toBe(payloadHash);
      expect(createArgs.data.requestedById).toBe(requester.id);
      expect(createArgs.data.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // approve / reject — authorization and terminal-decision guarantees
  // ---------------------------------------------------------------------

  describe("approve", () => {
    it("blocks self-approval", async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue(pendingRequest());

      await expect(
        service.approve(requester, "req-1", { expectedPayloadHash: payloadHash }),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.approvalRequest.updateMany).not.toHaveBeenCalled();
    });

    it("rejects a stale payload hash before attempting the transition", async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue(pendingRequest());

      await expect(
        service.approve(approver, "req-1", { expectedPayloadHash: "stale-hash" }),
      ).rejects.toThrow(ConflictException);

      expect(prisma.approvalRequest.updateMany).not.toHaveBeenCalled();
    });

    it("approves a pending request within its deadline", async () => {
      prisma.approvalRequest.findUnique
        .mockResolvedValueOnce(pendingRequest())
        .mockResolvedValueOnce(
          pendingRequest({ status: ApprovalRequestStatus.APPROVED, decidedById: approver.id }),
        );
      prisma.approvalRequest.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.approve(approver, "req-1", {
        expectedPayloadHash: payloadHash,
      });

      expect(result.status).toBe(ApprovalRequestStatus.APPROVED);
      const where = prisma.approvalRequest.updateMany.mock.calls[0][0].where;
      expect(where.status).toBe(ApprovalRequestStatus.PENDING);
    });

    it("gives only one decision when two approvers race on the same request", async () => {
      // First call wins the conditional update; second finds it already terminal.
      // First approver: initial get() sees PENDING, updateMany claims the
      // transition (count 1), final get() reflects the new APPROVED state.
      prisma.approvalRequest.findUnique
        .mockResolvedValueOnce(pendingRequest())
        .mockResolvedValueOnce(pendingRequest({ status: ApprovalRequestStatus.APPROVED }));
      prisma.approvalRequest.updateMany.mockResolvedValueOnce({ count: 1 });

      const first = await service.approve(approver, "req-1", {
        expectedPayloadHash: payloadHash,
      });
      expect(first.status).toBe(ApprovalRequestStatus.APPROVED);

      // Second approver, racing on the same request: initial get() now sees
      // the already-APPROVED row, so its conditional updateMany misses
      // (count 0), and the re-read it uses to explain the conflict confirms
      // the decision is already terminal.
      const other = { id: "user-3", walletAddress: "G3", walletHash: "h3", role: "ADMIN" };
      prisma.approvalRequest.findUnique
        .mockResolvedValueOnce(pendingRequest({ status: ApprovalRequestStatus.APPROVED }))
        .mockResolvedValueOnce(pendingRequest({ status: ApprovalRequestStatus.APPROVED }));
      prisma.approvalRequest.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.reject(other, "req-1", { expectedPayloadHash: payloadHash }),
      ).rejects.toThrow(ConflictException);
    });

    it("rejects a decision on a request that expired exactly at the boundary", async () => {
      prisma.approvalRequest.findUnique.mockResolvedValueOnce(
        pendingRequest({ expiresAt: new Date(Date.now() - 1) }),
      );
      prisma.approvalRequest.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.approvalRequest.findUnique.mockResolvedValueOnce(
        pendingRequest({ expiresAt: new Date(Date.now() - 1) }),
      );

      await expect(
        service.approve(approver, "req-1", { expectedPayloadHash: payloadHash }),
      ).rejects.toThrow("expired");
    });

    it("throws NotFoundException for an unknown request id", async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.approve(approver, "missing", { expectedPayloadHash: payloadHash }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------
  // cancel
  // ---------------------------------------------------------------------

  describe("cancel", () => {
    it("allows the requester to cancel", async () => {
      prisma.approvalRequest.findUnique
        .mockResolvedValueOnce(pendingRequest())
        .mockResolvedValueOnce(pendingRequest({ status: ApprovalRequestStatus.CANCELLED }));
      prisma.approvalRequest.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.cancel(requester, "req-1");
      expect(result.status).toBe(ApprovalRequestStatus.CANCELLED);
    });

    it("forbids a third party (non-requester, non-admin) from cancelling", async () => {
      const bystander = { id: "user-9", walletAddress: "G9", walletHash: "h9", role: "WORKER" };
      prisma.approvalRequest.findUnique.mockResolvedValue(pendingRequest());

      await expect(service.cancel(bystander, "req-1")).rejects.toThrow(ForbiddenException);
    });

    it("allows an admin who is not the requester to cancel", async () => {
      prisma.approvalRequest.findUnique
        .mockResolvedValueOnce(pendingRequest())
        .mockResolvedValueOnce(pendingRequest({ status: ApprovalRequestStatus.CANCELLED }));
      prisma.approvalRequest.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.cancel(approver, "req-1");
      expect(result.status).toBe(ApprovalRequestStatus.CANCELLED);
    });
  });

  // ---------------------------------------------------------------------
  // execution lease — idempotency under concurrency
  // ---------------------------------------------------------------------

  describe("claimForExecution / completeExecution", () => {
    it("lets only one concurrent caller claim the execution lease", async () => {
      prisma.approvalRequest.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      prisma.approvalRequest.findUnique.mockResolvedValueOnce(
        pendingRequest({ status: ApprovalRequestStatus.APPROVED, executionLeaseToken: "winner" }),
      );

      const [first, second] = await Promise.all([
        service.claimForExecution("req-1"),
        service.claimForExecution("req-1"),
      ]);

      const claims = [first, second];
      const claimed = claims.filter((c) => c.claimed);
      const notClaimed = claims.filter((c) => !c.claimed);
      expect(claimed).toHaveLength(1);
      expect(notClaimed).toHaveLength(1);
    });

    it("refuses to claim a request that is not APPROVED", async () => {
      prisma.approvalRequest.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.approvalRequest.findUnique.mockResolvedValueOnce(pendingRequest());

      const result = await service.claimForExecution("req-1");
      expect(result.claimed).toBe(false);
      if (!result.claimed) {
        expect(result.request.status).toBe(ApprovalRequestStatus.PENDING);
      }
    });

    it("completes execution exactly once for the winning lease", async () => {
      prisma.approvalRequest.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.approvalRequest.findUnique.mockResolvedValueOnce(
        pendingRequest({
          status: ApprovalRequestStatus.EXECUTED,
          executionLeaseToken: "token-1",
          executedAt: new Date(),
        }),
      );

      const result = await service.completeExecution("req-1", "token-1");
      expect(result.status).toBe(ApprovalRequestStatus.EXECUTED);
    });

    it("is idempotent when the same lease completes execution twice", async () => {
      prisma.approvalRequest.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.approvalRequest.findUnique.mockResolvedValueOnce(
        pendingRequest({
          status: ApprovalRequestStatus.EXECUTED,
          executionLeaseToken: "token-1",
          executedAt: new Date(),
        }),
      );

      const result = await service.completeExecution("req-1", "token-1");
      expect(result.status).toBe(ApprovalRequestStatus.EXECUTED);
    });

    it("rejects completion from a caller that does not hold the active lease", async () => {
      prisma.approvalRequest.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.approvalRequest.findUnique.mockResolvedValueOnce(
        pendingRequest({
          status: ApprovalRequestStatus.APPROVED,
          executionLeaseToken: "someone-elses-token",
        }),
      );

      await expect(service.completeExecution("req-1", "my-token")).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // ---------------------------------------------------------------------
  // expireStale
  // ---------------------------------------------------------------------

  describe("expireStale", () => {
    it("returns the number of requests expired", async () => {
      prisma.approvalRequest.updateMany.mockResolvedValue({ count: 3 });
      await expect(service.expireStale()).resolves.toBe(3);
    });
  });
});
