import { NotFoundException, ConflictException } from "@nestjs/common";
import { ReconciliationConflictStatus } from "@prisma/client";
import { ReconciliationConflictService } from "./reconciliation-conflict.service";

describe("ReconciliationConflictService", () => {
  let service: ReconciliationConflictService;
  let mockPrisma: any;
  let mockApprovals: any;

  beforeEach(() => {
    mockPrisma = {
      reconciliationConflict: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    mockApprovals = {
      create: jest.fn(),
      claimForExecution: jest.fn(),
      get: jest.fn(),
      completeExecution: jest.fn(),
    };
    service = new ReconciliationConflictService(mockPrisma, mockApprovals);
  });

  const mockUser = {
    id: "user-1",
    email: "test@example.com",
    role: "ADMIN",
    sessionId: "sess-1",
  } as any;

  it("proposes a resolution plan and queues an approval request", async () => {
    mockPrisma.reconciliationConflict.findUnique.mockResolvedValue({
      id: "conflict-1",
      resourceType: "proof",
      resourceId: "proof-1",
      status: ReconciliationConflictStatus.QUARANTINED,
      contractState: { status: "REVOKED" },
    });
    mockApprovals.create.mockResolvedValue({ id: "approval-1" });

    const res = await service.proposeResolution(mockUser, {
      conflictId: "conflict-1",
      action: "ADOPT_CONTRACT_STATE",
      reason: "Contract state is authoritative",
      riskLevel: "LOW",
    });

    expect(res.approvalRequestId).toBe("approval-1");
    expect(res.status).toBe("PENDING_APPROVAL");
    expect(mockApprovals.create).toHaveBeenCalledWith(
      mockUser,
      expect.objectContaining({
        operationType: "reconciliation.resolve_conflict",
      }),
    );
  });

  it("fails execution if lease cannot be claimed", async () => {
    mockApprovals.claimForExecution.mockResolvedValue({
      claimed: false,
      request: { status: "PENDING" },
    });

    await expect(
      service.executeResolution(mockUser, "approval-1", {
        executionLeaseToken: "lease-token-1",
      }),
    ).rejects.toThrow(ConflictException);
  });

  it("executes resolution plan idempotently under valid lease", async () => {
    mockApprovals.claimForExecution.mockResolvedValue({
      claimed: true,
      leaseToken: "lease-token-1",
    });
    mockApprovals.get.mockResolvedValue({
      id: "approval-1",
      payload: {
        conflictId: "conflict-1",
        action: "ADOPT_CONTRACT_STATE",
        reason: "Contract is authoritative",
        riskLevel: "LOW",
      },
    });
    mockPrisma.reconciliationConflict.findUnique.mockResolvedValue({
      id: "conflict-1",
      status: ReconciliationConflictStatus.QUARANTINED,
    });
    mockPrisma.reconciliationConflict.update.mockResolvedValue({
      id: "conflict-1",
      status: ReconciliationConflictStatus.RESOLVED,
    });
    mockApprovals.completeExecution.mockResolvedValue(undefined);

    const res = await service.executeResolution(mockUser, "approval-1", {
      executionLeaseToken: "lease-token-1",
    });

    expect(res.status).toBe(ReconciliationConflictStatus.RESOLVED);
    expect(mockPrisma.reconciliationConflict.update).toHaveBeenCalled();
    expect(mockApprovals.completeExecution).toHaveBeenCalledWith(
      "approval-1",
      "lease-token-1",
    );
  });
});
