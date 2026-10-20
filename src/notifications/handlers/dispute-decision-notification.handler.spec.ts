import { Test, TestingModule } from "@nestjs/testing";
import { DisputeDecisionNotificationHandler } from "./dispute-decision-notification.handler";
import { SecurityNotificationService } from "../security-notification.service";
import { PrismaService } from "../../database/prisma.service";
import { DomainEvent } from "../../common/events/domain-event.types";
import {
  DisputeDecisionNotificationPayload,
} from "../../disputes/events/dispute-decision-notification.types";
import { DisputeStatus, DisputeCategory, SecurityNotificationType } from "@prisma/client";

describe("DisputeDecisionNotificationHandler", () => {
  let handler: DisputeDecisionNotificationHandler;
  let securityNotificationService: jest.Mocked<SecurityNotificationService>;
  let prismaService: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputeDecisionNotificationHandler,
        {
          provide: SecurityNotificationService,
          useValue: {
            createNotification: jest.fn(),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            proofDispute: {
              findFirst: jest.fn(),
            },
            proof: {
              findUnique: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    handler = module.get<DisputeDecisionNotificationHandler>(
      DisputeDecisionNotificationHandler
    );
    securityNotificationService = module.get(SecurityNotificationService) as jest.Mocked<
      SecurityNotificationService
    >;
    prismaService = module.get(PrismaService) as jest.Mocked<PrismaService>;
  });

  describe("consumerName", () => {
    it("should have correct consumer name", () => {
      expect(handler.consumerName).toBe("DisputeDecisionNotificationHandler");
    });
  });

  describe("handle - DISPUTE_RESOLVED", () => {
    let event: DomainEvent<DisputeDecisionNotificationPayload>;
    const payload: DisputeDecisionNotificationPayload = {
      disputeId: "disp_123",
      proofId: "proof_456",
      organizationId: "org_789",
      category: DisputeCategory.ACCURACY,
      decisionType: "RESOLVED",
      status: DisputeStatus.RESOLVED,
      resolutionOutcome: "UPHELD",
      resolutionReason: "Proof data verified as accurate through issuer confirmation",
      resolvedBy: "user_resolver",
      resolvedAt: new Date().toISOString(),
      participants: {
        proofOwnerId: "user_owner",
        disputeSubmitterId: "user_submitter",
        assignedReviewerId: "user_reviewer",
      },
    };

    beforeEach(() => {
      event = {
        id: "evt_123",
        organizationId: "org_789",
        eventType: "DISPUTE_RESOLVED",
        eventVersion: 1,
        aggregateType: "ProofDispute",
        aggregateId: "disp_123",
        payload,
        status: "PENDING" as any,
        attempts: 1,
        maxAttempts: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });

    it("should create notifications for all participants", async () => {
      // Setup
      prismaService.proofDispute.findFirst.mockResolvedValue({
        id: "disp_123",
        proofId: "proof_456",
        status: DisputeStatus.RESOLVED,
        category: DisputeCategory.ACCURACY,
        submittedBy: "user_submitter",
        resolvedBy: "user_resolver",
        resolvedAt: new Date(),
        withdrawnAt: null,
      } as any);

      prismaService.proof.findUnique.mockResolvedValue({
        id: "proof_456",
        userId: "user_owner",
        status: "VERIFIED",
      } as any);

      securityNotificationService.createNotification.mockResolvedValue({} as any);

      // Execute
      await handler.handle(event);

      // Assert: notifications for proof owner, submitter, reviewer, and org
      expect(securityNotificationService.createNotification).toHaveBeenCalledTimes(4);

      // Verify proof owner notification
      expect(securityNotificationService.createNotification).toHaveBeenCalledWith(
        "org_789",
        expect.objectContaining({
          type: SecurityNotificationType.DISPUTE_FILED,
          userId: "user_owner",
          title: expect.stringContaining("UPHELD"),
        })
      );

      // Verify dispute submitter notification
      expect(securityNotificationService.createNotification).toHaveBeenCalledWith(
        "org_789",
        expect.objectContaining({
          type: SecurityNotificationType.DISPUTE_FILED,
          userId: "user_submitter",
          title: expect.stringContaining("Your Dispute Report"),
        })
      );

      // Verify reviewer notification
      expect(securityNotificationService.createNotification).toHaveBeenCalledWith(
        "org_789",
        expect.objectContaining({
          type: SecurityNotificationType.DISPUTE_FILED,
          userId: "user_reviewer",
          title: expect.stringContaining("Dispute Review Completed"),
        })
      );

      // Verify org-wide audit notification
      expect(securityNotificationService.createNotification).toHaveBeenCalledWith(
        "org_789",
        expect.objectContaining({
          userId: null,
          title: expect.stringContaining("[Audit]"),
        })
      );
    });

    it("should handle deduplication when proof owner and submitter are same", async () => {
      // Setup: same person is both owner and submitter
      const payloadSamePerson = {
        ...payload,
        participants: {
          proofOwnerId: "user_same",
          disputeSubmitterId: "user_same",
          assignedReviewerId: "user_reviewer",
        },
      };

      const eventSamePerson = {
        ...event,
        payload: payloadSamePerson,
      };

      prismaService.proofDispute.findFirst.mockResolvedValue({} as any);
      prismaService.proof.findUnique.mockResolvedValue({
        userId: "user_same",
      } as any);
      securityNotificationService.createNotification.mockResolvedValue({} as any);

      // Execute
      await handler.handle(eventSamePerson);

      // Assert: only 3 notifications (owner+submitter combined, reviewer, org)
      expect(securityNotificationService.createNotification).toHaveBeenCalledTimes(3);
    });

    it("should include privacy-safe notification data", async () => {
      // Setup
      prismaService.proofDispute.findFirst.mockResolvedValue({} as any);
      prismaService.proof.findUnique.mockResolvedValue({
        userId: "user_owner",
      } as any);
      securityNotificationService.createNotification.mockResolvedValue({} as any);

      // Execute
      await handler.handle(event);

      // Assert: check data payload does not include sensitive info
      const callArgs = securityNotificationService.createNotification.mock.calls[0];
      const notificationDto = callArgs[1];
      const data = notificationDto.data;

      expect(data).toEqual(
        expect.objectContaining({
          disputeId: "disp_123",
          proofId: "proof_456",
          category: DisputeCategory.ACCURACY,
          decisionType: "RESOLVED",
          resolutionOutcome: "UPHELD",
          resolutionReason: payload.resolutionReason,
        })
      );

      // Should NOT include raw claims or sensitive fields
      expect(JSON.stringify(data)).not.toContain("claims");
      expect(JSON.stringify(data)).not.toContain("balance");
    });

    it("should throw error if notification creation fails", async () => {
      // Setup
      prismaService.proofDispute.findFirst.mockResolvedValue({} as any);
      prismaService.proof.findUnique.mockResolvedValue({
        userId: "user_owner",
      } as any);

      const error = new Error("Database error");
      securityNotificationService.createNotification.mockRejectedValue(error);

      // Execute & Assert
      await expect(handler.handle(event)).rejects.toThrow("Database error");
    });
  });

  describe("handle - DISPUTE_WITHDRAWN", () => {
    let event: DomainEvent<DisputeDecisionNotificationPayload>;
    const payload: DisputeDecisionNotificationPayload = {
      disputeId: "disp_456",
      proofId: "proof_789",
      organizationId: "org_123",
      category: DisputeCategory.FRAUD,
      decisionType: "WITHDRAWN",
      status: DisputeStatus.WITHDRAWN,
      withdrawnBy: "user_submitter",
      withdrawnAt: new Date().toISOString(),
      participants: {
        proofOwnerId: "user_owner",
        disputeSubmitterId: "user_submitter",
      },
    };

    beforeEach(() => {
      event = {
        id: "evt_456",
        organizationId: "org_123",
        eventType: "DISPUTE_WITHDRAWN",
        eventVersion: 1,
        aggregateType: "ProofDispute",
        aggregateId: "disp_456",
        payload,
        status: "PENDING" as any,
        attempts: 1,
        maxAttempts: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });

    it("should create notifications with INFO severity", async () => {
      // Setup
      prismaService.proofDispute.findFirst.mockResolvedValue({} as any);
      prismaService.proof.findUnique.mockResolvedValue({
        userId: "user_owner",
      } as any);
      securityNotificationService.createNotification.mockResolvedValue({} as any);

      // Execute
      await handler.handle(event);

      // Assert: check severity is INFO
      const calls = securityNotificationService.createNotification.mock.calls;
      calls.forEach((call) => {
        const dto = call[1];
        expect(dto.severity).toBe("INFO");
      });
    });

    it("should include withdrawal reason in summary", async () => {
      // Setup
      prismaService.proofDispute.findFirst.mockResolvedValue({} as any);
      prismaService.proof.findUnique.mockResolvedValue({
        userId: "user_owner",
      } as any);
      securityNotificationService.createNotification.mockResolvedValue({} as any);

      // Execute
      await handler.handle(event);

      // Assert: check summary mentions withdrawal
      const calls = securityNotificationService.createNotification.mock.calls;
      expect(calls[0][1].summary).toContain("withdrawn");
    });
  });

  describe("handle - Stale State Detection", () => {
    const payload: DisputeDecisionNotificationPayload = {
      disputeId: "disp_stale",
      proofId: "proof_stale",
      organizationId: "org_stale",
      category: DisputeCategory.TECHNICAL,
      decisionType: "RESOLVED",
      status: DisputeStatus.RESOLVED,
      resolutionOutcome: "REJECTED",
      resolutionReason: "Technical issue resolved",
      resolvedBy: "user_admin",
      resolvedAt: new Date().toISOString(),
      participants: {
        proofOwnerId: "user_owner",
        disputeSubmitterId: "user_submitter",
      },
    };

    let event: DomainEvent<DisputeDecisionNotificationPayload>;

    beforeEach(() => {
      event = {
        id: "evt_stale",
        organizationId: "org_stale",
        eventType: "DISPUTE_RESOLVED",
        eventVersion: 1,
        aggregateType: "ProofDispute",
        aggregateId: "disp_stale",
        payload,
        status: "PENDING" as any,
        attempts: 1,
        maxAttempts: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });

    it("should handle case where dispute is not found (soft delete)", async () => {
      // Setup
      prismaService.proofDispute.findFirst.mockResolvedValue(null);

      // Execute - should not throw
      await handler.handle(event);

      // Assert: no notifications created
      expect(securityNotificationService.createNotification).not.toHaveBeenCalled();
    });

    it("should handle case where proof is not found", async () => {
      // Setup
      prismaService.proofDispute.findFirst.mockResolvedValue({
        id: "disp_stale",
      } as any);
      prismaService.proof.findUnique.mockResolvedValue(null);

      // Execute - should not throw
      await handler.handle(event);

      // Assert: no notifications created
      expect(securityNotificationService.createNotification).not.toHaveBeenCalled();
    });

    it("should still fail if organization is inactive", async () => {
      // Setup
      prismaService.proofDispute.findFirst.mockResolvedValue({
        id: "disp_stale",
      } as any);
      prismaService.proof.findUnique.mockResolvedValue({
        userId: "user_owner",
      } as any);

      const error = new Error("Organization not found or not active");
      securityNotificationService.createNotification.mockRejectedValue(error);

      // Execute & Assert
      await expect(handler.handle(event)).rejects.toThrow(
        "Organization not found or not active"
      );
    });
  });

  describe("handle - Authorization Checks", () => {
    const payload: DisputeDecisionNotificationPayload = {
      disputeId: "disp_auth",
      proofId: "proof_auth",
      organizationId: "org_auth",
      category: DisputeCategory.COMPLIANCE,
      decisionType: "RESOLVED",
      status: DisputeStatus.RESOLVED,
      resolutionOutcome: "INCONCLUSIVE",
      resolutionReason: "Insufficient evidence",
      resolvedBy: "user_admin",
      resolvedAt: new Date().toISOString(),
      participants: {
        proofOwnerId: "user_owner",
        disputeSubmitterId: "user_submitter",
        assignedReviewerId: "user_reviewer",
      },
    };

    let event: DomainEvent<DisputeDecisionNotificationPayload>;

    beforeEach(() => {
      event = {
        id: "evt_auth",
        organizationId: "org_auth",
        eventType: "DISPUTE_RESOLVED",
        eventVersion: 1,
        aggregateType: "ProofDispute",
        aggregateId: "disp_auth",
        payload,
        status: "PENDING" as any,
        attempts: 1,
        maxAttempts: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });

    it("should fail if participant does not have org access", async () => {
      // Setup
      prismaService.proofDispute.findFirst.mockResolvedValue({} as any);
      prismaService.proof.findUnique.mockResolvedValue({
        userId: "user_owner",
      } as any);

      const forbiddenError = new Error("User is not a member of the requested organization");
      securityNotificationService.createNotification.mockRejectedValueOnce(forbiddenError);

      // Execute & Assert
      await expect(handler.handle(event)).rejects.toThrow(
        "User is not a member of the requested organization"
      );
    });
  });

  describe("handle - Concurrency", () => {
    it("should handle multiple concurrent events without race conditions", async () => {
      // Setup: multiple events for different disputes
      const events = [
        {
          id: "evt_1",
          organizationId: "org_test",
          eventType: "DISPUTE_RESOLVED",
          payload: {
            disputeId: "disp_1",
            proofId: "proof_1",
            organizationId: "org_test",
            category: DisputeCategory.ACCURACY,
            decisionType: "RESOLVED" as const,
            status: DisputeStatus.RESOLVED,
            resolutionOutcome: "UPHELD",
            resolutionReason: "Test 1",
            participants: {
              proofOwnerId: "owner_1",
              disputeSubmitterId: "submitter_1",
            },
          } as DisputeDecisionNotificationPayload,
        },
        {
          id: "evt_2",
          organizationId: "org_test",
          eventType: "DISPUTE_RESOLVED",
          payload: {
            disputeId: "disp_2",
            proofId: "proof_2",
            organizationId: "org_test",
            category: DisputeCategory.FRAUD,
            decisionType: "RESOLVED" as const,
            status: DisputeStatus.RESOLVED,
            resolutionOutcome: "REJECTED",
            resolutionReason: "Test 2",
            participants: {
              proofOwnerId: "owner_2",
              disputeSubmitterId: "submitter_2",
            },
          } as DisputeDecisionNotificationPayload,
        },
      ] as DomainEvent<DisputeDecisionNotificationPayload>[];

      // Setup mocks
      prismaService.proofDispute.findFirst.mockResolvedValue({} as any);
      prismaService.proof.findUnique.mockImplementation(({ where }) => {
        const proofId = (where as any).id;
        return Promise.resolve({
          id: proofId,
          userId: proofId === "proof_1" ? "owner_1" : "owner_2",
        } as any);
      });
      securityNotificationService.createNotification.mockResolvedValue({} as any);

      // Execute concurrently
      await Promise.all(events.map((e) => handler.handle(e)));

      // Assert: all notifications created without interference
      expect(securityNotificationService.createNotification).toHaveBeenCalledTimes(6); // 3 per event
    });
  });

  describe("handle - Boundary Cases", () => {
    it("should handle missing optional assignedReviewerId", async () => {
      // Setup: no assigned reviewer
      const payload: DisputeDecisionNotificationPayload = {
        disputeId: "disp_norev",
        proofId: "proof_norev",
        organizationId: "org_norev",
        category: DisputeCategory.OTHER,
        decisionType: "RESOLVED",
        status: DisputeStatus.RESOLVED,
        resolutionOutcome: "UPHELD",
        resolutionReason: "Decision made",
        resolvedBy: "user_admin",
        resolvedAt: new Date().toISOString(),
        participants: {
          proofOwnerId: "user_owner",
          disputeSubmitterId: "user_submitter",
          // No assignedReviewerId
        },
      };

      const event = {
        id: "evt_norev",
        organizationId: "org_norev",
        eventType: "DISPUTE_RESOLVED",
        eventVersion: 1,
        aggregateType: "ProofDispute",
        aggregateId: "disp_norev",
        payload,
        status: "PENDING" as any,
        attempts: 1,
        maxAttempts: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prismaService.proofDispute.findFirst.mockResolvedValue({} as any);
      prismaService.proof.findUnique.mockResolvedValue({
        userId: "user_owner",
      } as any);
      securityNotificationService.createNotification.mockResolvedValue({} as any);

      // Execute
      await handler.handle(event);

      // Assert: 2 notifications (owner, submitter) + org = 3
      expect(securityNotificationService.createNotification).toHaveBeenCalledTimes(3);
    });

    it("should handle very long resolution reason", async () => {
      // Setup: max length reason
      const longReason = "A".repeat(2000);
      const payload: DisputeDecisionNotificationPayload = {
        disputeId: "disp_long",
        proofId: "proof_long",
        organizationId: "org_long",
        category: DisputeCategory.ACCURACY,
        decisionType: "RESOLVED",
        status: DisputeStatus.RESOLVED,
        resolutionOutcome: "UPHELD",
        resolutionReason: longReason,
        resolvedBy: "user_admin",
        resolvedAt: new Date().toISOString(),
        participants: {
          proofOwnerId: "user_owner",
          disputeSubmitterId: "user_submitter",
        },
      };

      const event = {
        id: "evt_long",
        organizationId: "org_long",
        eventType: "DISPUTE_RESOLVED",
        eventVersion: 1,
        aggregateType: "ProofDispute",
        aggregateId: "disp_long",
        payload,
        status: "PENDING" as any,
        attempts: 1,
        maxAttempts: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prismaService.proofDispute.findFirst.mockResolvedValue({} as any);
      prismaService.proof.findUnique.mockResolvedValue({
        userId: "user_owner",
      } as any);
      securityNotificationService.createNotification.mockResolvedValue({} as any);

      // Execute - should not throw
      await handler.handle(event);

      // Assert: notification data preserves reason
      const callArgs = securityNotificationService.createNotification.mock.calls[0];
      expect(callArgs[1].data.resolutionReason).toBe(longReason);
    });

    it("should handle all DisputeCategory types", async () => {
      const categories = [
        DisputeCategory.ACCURACY,
        DisputeCategory.FRAUD,
        DisputeCategory.TECHNICAL,
        DisputeCategory.COMPLIANCE,
        DisputeCategory.OTHER,
      ];

      for (const category of categories) {
        const payload: DisputeDecisionNotificationPayload = {
          disputeId: `disp_${category}`,
          proofId: `proof_${category}`,
          organizationId: "org_categories",
          category,
          decisionType: "RESOLVED",
          status: DisputeStatus.RESOLVED,
          resolutionOutcome: "UPHELD",
          resolutionReason: `Test for ${category}`,
          resolvedBy: "user_admin",
          resolvedAt: new Date().toISOString(),
          participants: {
            proofOwnerId: "user_owner",
            disputeSubmitterId: "user_submitter",
          },
        };

        const event = {
          id: `evt_${category}`,
          organizationId: "org_categories",
          eventType: "DISPUTE_RESOLVED",
          eventVersion: 1,
          aggregateType: "ProofDispute",
          aggregateId: `disp_${category}`,
          payload,
          status: "PENDING" as any,
          attempts: 1,
          maxAttempts: 5,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        prismaService.proofDispute.findFirst.mockResolvedValue({} as any);
        prismaService.proof.findUnique.mockResolvedValue({
          userId: "user_owner",
        } as any);
        securityNotificationService.createNotification.mockResolvedValue({} as any);
        securityNotificationService.createNotification.mockClear();

        // Execute
        await handler.handle(event);

        // Assert: should handle all categories without error
        expect(securityNotificationService.createNotification).toHaveBeenCalled();
      }
    });
  });
});
