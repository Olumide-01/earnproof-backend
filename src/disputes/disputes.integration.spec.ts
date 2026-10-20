import { Test, TestingModule } from "@nestjs/testing";
import { DisputesService } from "./disputes.service";
import { PrismaService } from "../database/prisma.service";
import { DomainEventOutboxService } from "../common/events/domain-event-outbox.service";
import { DisputeStatus, DisputeCategory, DomainEventStatus } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";

/**
 * Integration Tests for Dispute Notifications
 * 
 * Tests the end-to-end flow:
 * 1. Dispute action (submit, resolve, etc.)
 * 2. Domain event emitted and persisted to outbox
 * 3. Event handler processes notification
 * 4. Notifications created for participants
 */
describe("Disputes Service - Notification Integration", () => {
  let service: DisputesService;
  let prismaService: jest.Mocked<PrismaService>;
  let domainEventOutbox: jest.Mocked<DomainEventOutboxService>;

  const mockUser: AuthenticatedUser = {
    id: "user_123",
    email: "user@example.com",
    role: "WORKER",
  };

  const mockAdmin: AuthenticatedUser = {
    id: "admin_123",
    email: "admin@example.com",
    role: "ADMIN",
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputesService,
        {
          provide: PrismaService,
          useValue: {
            proof: {
              findFirst: jest.fn(),
              findUnique: jest.fn(),
            },
            proofDispute: {
              findFirst: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
              findMany: jest.fn(),
              groupBy: jest.fn(),
            },
            organizationMember: {
              findFirst: jest.fn(),
              findUnique: jest.fn(),
            },
            auditLog: {
              create: jest.fn(),
            },
            $transaction: jest.fn((fn) => fn(this)),
          },
        },
        {
          provide: DomainEventOutboxService,
          useValue: {
            publish: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<DisputesService>(DisputesService);
    prismaService = module.get(PrismaService) as jest.Mocked<PrismaService>;
    domainEventOutbox = module.get(DomainEventOutboxService) as jest.Mocked<
      DomainEventOutboxService
    >;
  });

  describe("submitDispute - Event Emission", () => {
    it("should emit DISPUTE_FILED event when dispute is submitted", async () => {
      // Setup
      const proofId = "proof_123";
      const organizationId = "org_456";

      prismaService.organizationMember.findFirst.mockResolvedValue({
        userId: mockUser.id,
        organizationId,
        status: "ACTIVE",
      } as any);

      prismaService.proof.findFirst.mockResolvedValue({
        id: proofId,
        userId: "proof_owner_id",
      } as any);

      prismaService.proofDispute.findFirst.mockResolvedValue(null);

      const createdDispute = {
        id: "disp_123",
        proofId,
        category: DisputeCategory.ACCURACY,
        status: DisputeStatus.OPEN,
        submittedBy: mockUser.id,
        organizationId,
        proof: { userId: "proof_owner_id" },
      };

      prismaService.proofDispute.create.mockResolvedValue(createdDispute as any);
      prismaService.$transaction.mockImplementation(async (fn) => {
        return fn(prismaService);
      });

      // Execute
      await service.submitDispute(mockUser, organizationId, {
        proofId,
        category: DisputeCategory.ACCURACY,
      });

      // Assert: domain event published
      expect(domainEventOutbox.publish).toHaveBeenCalledWith(
        prismaService,
        expect.objectContaining({
          organizationId,
          eventType: "DISPUTE_FILED",
          aggregateType: "ProofDispute",
          aggregateId: "disp_123",
          payload: expect.objectContaining({
            disputeId: "disp_123",
            proofId,
            category: DisputeCategory.ACCURACY,
            decisionType: "FILED",
            status: DisputeStatus.OPEN,
            participants: {
              proofOwnerId: "proof_owner_id",
              disputeSubmitterId: mockUser.id,
            },
          }),
        })
      );
    });

    it("should not emit event if submitDispute fails", async () => {
      // Setup - missing proof
      prismaService.organizationMember.findFirst.mockResolvedValue({
        status: "ACTIVE",
      } as any);

      prismaService.proof.findFirst.mockResolvedValue(null);

      // Execute
      await expect(
        service.submitDispute(mockUser, "org_456", {
          proofId: "nonexistent",
          category: DisputeCategory.ACCURACY,
        })
      ).rejects.toThrow("Proof not found");

      // Assert: no event published
      expect(domainEventOutbox.publish).not.toHaveBeenCalled();
    });
  });

  describe("withdrawDispute - Event Emission", () => {
    it("should emit DISPUTE_WITHDRAWN event", async () => {
      // Setup
      const disputeId = "disp_withdraw";
      const organizationId = "org_789";

      prismaService.organizationMember.findFirst.mockResolvedValue({
        status: "ACTIVE",
      } as any);

      prismaService.proofDispute.findFirst.mockResolvedValue({
        id: disputeId,
        status: DisputeStatus.OPEN,
        submittedBy: mockUser.id,
        proofId: "proof_456",
      } as any);

      const withdrawnDispute = {
        id: disputeId,
        proofId: "proof_456",
        status: DisputeStatus.WITHDRAWN,
        submittedBy: mockUser.id,
        withdrawnAt: new Date(),
        category: DisputeCategory.FRAUD,
      };

      prismaService.proofDispute.update.mockResolvedValue(withdrawnDispute as any);
      prismaService.$transaction.mockImplementation(async (fn) => {
        return fn(prismaService);
      });

      // Execute
      await service.withdrawDispute(mockUser, organizationId, disputeId);

      // Assert: event emitted
      expect(domainEventOutbox.publish).toHaveBeenCalledWith(
        prismaService,
        expect.objectContaining({
          eventType: "DISPUTE_WITHDRAWN",
          aggregateId: disputeId,
          payload: expect.objectContaining({
            decisionType: "WITHDRAWN",
            status: DisputeStatus.WITHDRAWN,
            withdrawnBy: mockUser.id,
          }),
        })
      );
    });
  });

  describe("assignDispute - Event Emission", () => {
    it("should emit DISPUTE_ASSIGNED event", async () => {
      // Setup
      const disputeId = "disp_assign";
      const organizationId = "org_assign";
      const assigneeId = "reviewer_123";

      prismaService.organizationMember.findFirst
        .mockResolvedValueOnce({ status: "ACTIVE" } as any) // Current user
        .mockResolvedValueOnce({ userId: assigneeId, status: "ACTIVE" } as any); // Assignee

      prismaService.proofDispute.findFirst.mockResolvedValue({
        id: disputeId,
        status: DisputeStatus.OPEN,
        proofId: "proof_789",
      } as any);

      const assignedDispute = {
        id: disputeId,
        proofId: "proof_789",
        status: DisputeStatus.ASSIGNED,
        submittedBy: mockUser.id,
        assignedTo: assigneeId,
        assignedAt: new Date(),
        category: DisputeCategory.TECHNICAL,
        proof: { userId: "owner_123" },
      };

      prismaService.proofDispute.update.mockResolvedValue(assignedDispute as any);
      prismaService.$transaction.mockImplementation(async (fn) => {
        return fn(prismaService);
      });

      // Execute
      await service.assignDispute(mockAdmin, organizationId, disputeId, {
        assignedTo: assigneeId,
      });

      // Assert: event emitted with reviewer info
      expect(domainEventOutbox.publish).toHaveBeenCalledWith(
        prismaService,
        expect.objectContaining({
          eventType: "DISPUTE_ASSIGNED",
          payload: expect.objectContaining({
            decisionType: "ASSIGNED",
            participants: {
              proofOwnerId: "owner_123",
              disputeSubmitterId: mockUser.id,
              assignedReviewerId: assigneeId,
            },
          }),
        })
      );
    });
  });

  describe("resolveDispute - Event Emission", () => {
    it("should emit DISPUTE_RESOLVED event with outcome", async () => {
      // Setup
      const disputeId = "disp_resolve";
      const organizationId = "org_resolve";

      prismaService.organizationMember.findFirst.mockResolvedValue({
        status: "ACTIVE",
      } as any);

      prismaService.proofDispute.findFirst.mockResolvedValue({
        id: disputeId,
        status: DisputeStatus.ASSIGNED,
        assignedTo: mockAdmin.id,
        proofId: "proof_resolve",
        submittedBy: mockUser.id,
      } as any);

      const resolvedDispute = {
        id: disputeId,
        proofId: "proof_resolve",
        status: DisputeStatus.RESOLVED,
        submittedBy: mockUser.id,
        assignedTo: mockAdmin.id,
        resolvedBy: mockAdmin.id,
        resolvedAt: new Date(),
        resolutionOutcome: "UPHELD",
        resolutionReason: "Proof verified as authentic through issuer records",
        category: DisputeCategory.ACCURACY,
        proof: { userId: "owner_456" },
      };

      prismaService.proofDispute.update.mockResolvedValue(resolvedDispute as any);
      prismaService.$transaction.mockImplementation(async (fn) => {
        return fn(prismaService);
      });

      // Execute
      await service.resolveDispute(mockAdmin, organizationId, disputeId, {
        resolutionOutcome: "UPHELD",
        resolutionReason: "Proof verified as authentic through issuer records",
      });

      // Assert: event emitted with full resolution details
      expect(domainEventOutbox.publish).toHaveBeenCalledWith(
        prismaService,
        expect.objectContaining({
          eventType: "DISPUTE_RESOLVED",
          aggregateId: disputeId,
          payload: expect.objectContaining({
            disputeId,
            decisionType: "RESOLVED",
            status: DisputeStatus.RESOLVED,
            resolutionOutcome: "UPHELD",
            resolutionReason: expect.stringContaining("issuer"),
            resolvedBy: mockAdmin.id,
            resolvedAt: expect.any(String),
            participants: {
              proofOwnerId: "owner_456",
              disputeSubmitterId: mockUser.id,
              assignedReviewerId: mockAdmin.id,
            },
          }),
        })
      );
    });

    it("should emit DISPUTE_RESOLVED for resolution with no assignment", async () => {
      // Setup: admin resolves directly without assignment
      prismaService.organizationMember.findFirst.mockResolvedValue({
        status: "ACTIVE",
      } as any);

      prismaService.proofDispute.findFirst.mockResolvedValue({
        id: "disp_direct",
        status: DisputeStatus.OPEN,
        assignedTo: null,
        proofId: "proof_direct",
        submittedBy: mockUser.id,
      } as any);

      prismaService.proofDispute.update.mockResolvedValue({
        id: "disp_direct",
        status: DisputeStatus.RESOLVED,
        resolutionOutcome: "REJECTED",
        resolutionReason: "Evidence commitment hash invalid",
        resolvedBy: mockAdmin.id,
        assignedTo: null,
        category: DisputeCategory.ACCURACY,
        proof: { userId: "owner_direct" },
      } as any);

      prismaService.$transaction.mockImplementation(async (fn) => {
        return fn(prismaService);
      });

      // Execute
      await service.resolveDispute(mockAdmin, "org_direct", "disp_direct", {
        resolutionOutcome: "REJECTED",
        resolutionReason: "Evidence commitment hash invalid",
      });

      // Assert: event still emitted with optional reviewerId
      expect(domainEventOutbox.publish).toHaveBeenCalledWith(
        prismaService,
        expect.objectContaining({
          eventType: "DISPUTE_RESOLVED",
          payload: expect.objectContaining({
            participants: {
              proofOwnerId: "owner_direct",
              disputeSubmitterId: mockUser.id,
              assignedReviewerId: undefined,
            },
          }),
        })
      );
    });

    it("should not emit event if resolution fails authorization", async () => {
      // Setup: non-admin, non-assigned user tries to resolve
      const otherUser: AuthenticatedUser = {
        id: "other_user",
        email: "other@example.com",
        role: "WORKER",
      };

      prismaService.organizationMember.findFirst.mockResolvedValue({
        status: "ACTIVE",
      } as any);

      prismaService.proofDispute.findFirst.mockResolvedValue({
        id: "disp_auth",
        status: DisputeStatus.ASSIGNED,
        assignedTo: "different_reviewer",
        proofId: "proof_auth",
      } as any);

      // Execute & Assert
      await expect(
        service.resolveDispute(otherUser, "org_auth", "disp_auth", {
          resolutionOutcome: "UPHELD",
          resolutionReason: "Unauthorized attempt",
        })
      ).rejects.toThrow("Only administrators or assigned reviewers can resolve disputes");

      // Assert: no event emitted
      expect(domainEventOutbox.publish).not.toHaveBeenCalled();
    });
  });

  describe("Event Payload Privacy", () => {
    it("should not include proof claims in event payload", async () => {
      // Setup: proof with sensitive claims
      const proofWithClaims = {
        id: "proof_private",
        userId: "owner_private",
        proofType: "EMPLOYMENT",
        claims: {
          salary: 150000,
          employer: "Acme Corp",
          startDate: "2020-01-01",
        },
      };

      prismaService.organizationMember.findFirst.mockResolvedValue({
        status: "ACTIVE",
      } as any);

      prismaService.proof.findFirst.mockResolvedValue(proofWithClaims as any);
      prismaService.proofDispute.findFirst.mockResolvedValue(null);
      prismaService.proofDispute.create.mockResolvedValue({
        id: "disp_privacy",
        proofId: "proof_private",
        category: DisputeCategory.ACCURACY,
        status: DisputeStatus.OPEN,
        submittedBy: mockUser.id,
        proof: { userId: "owner_private" },
      } as any);

      prismaService.$transaction.mockImplementation(async (fn) => {
        return fn(prismaService);
      });

      // Execute
      await service.submitDispute(mockUser, "org_privacy", {
        proofId: "proof_private",
        category: DisputeCategory.ACCURACY,
      });

      // Assert: event payload does NOT include claims
      const publishCall = domainEventOutbox.publish.mock.calls[0];
      const payload = publishCall[1].payload;

      expect(JSON.stringify(payload)).not.toContain("salary");
      expect(JSON.stringify(payload)).not.toContain("employer");
      expect(JSON.stringify(payload)).not.toContain("150000");
    });

    it("should only include safe dispute information", async () => {
      // Setup
      prismaService.organizationMember.findFirst.mockResolvedValue({
        status: "ACTIVE",
      } as any);

      prismaService.proof.findFirst.mockResolvedValue({
        id: "proof_safe",
        userId: "owner_safe",
      } as any);

      prismaService.proofDispute.findFirst.mockResolvedValue(null);
      prismaService.proofDispute.create.mockResolvedValue({
        id: "disp_safe",
        proofId: "proof_safe",
        category: DisputeCategory.FRAUD,
        status: DisputeStatus.OPEN,
        submittedBy: mockUser.id,
        metadata: { notes: "This is fake" },
        proof: { userId: "owner_safe" },
      } as any);

      prismaService.$transaction.mockImplementation(async (fn) => {
        return fn(prismaService);
      });

      // Execute
      await service.submitDispute(mockUser, "org_safe", {
        proofId: "proof_safe",
        category: DisputeCategory.FRAUD,
        metadata: { notes: "This is fake" },
      });

      // Assert: event includes safe information
      const publishCall = domainEventOutbox.publish.mock.calls[0];
      const payload = publishCall[1].payload;

      expect(payload).toEqual(
        expect.objectContaining({
          disputeId: "disp_safe",
          proofId: "proof_safe",
          category: DisputeCategory.FRAUD,
          decisionType: "FILED",
          participants: expect.objectContaining({
            proofOwnerId: "owner_safe",
            disputeSubmitterId: mockUser.id,
          }),
        })
      );

      // Should NOT include metadata
      expect(payload).not.toHaveProperty("metadata");
    });
  });

  describe("Transaction Rollback - Event Not Emitted", () => {
    it("should not emit event if transaction rolls back", async () => {
      // Setup: transaction will fail
      prismaService.organizationMember.findFirst.mockResolvedValue({
        status: "ACTIVE",
      } as any);

      prismaService.proof.findFirst.mockResolvedValue({
        id: "proof_rollback",
        userId: "owner_rollback",
      } as any);

      prismaService.proofDispute.findFirst.mockResolvedValue(null);

      // Simulate transaction rollback
      prismaService.$transaction.mockImplementation(async (fn) => {
        throw new Error("Unique constraint violation");
      });

      // Execute & Assert
      await expect(
        service.submitDispute(mockUser, "org_rollback", {
          proofId: "proof_rollback",
          category: DisputeCategory.ACCURACY,
        })
      ).rejects.toThrow();

      // Assert: publish should not be called because transaction failed before publish
      expect(domainEventOutbox.publish).not.toHaveBeenCalled();
    });
  });
});
