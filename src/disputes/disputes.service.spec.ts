import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DisputeStatus, DisputeCategory } from "@prisma/client";
import { DisputesService } from "./disputes.service";
import { PrismaService } from "../database/prisma.service";
import { WebhookDeliveryService } from "../webhooks/webhook-delivery.service";
import { AuthenticatedUser } from "../auth/auth.types";

describe("DisputesService", () => {
  let service: DisputesService;
  let prismaService: jest.Mocked<PrismaService>;
  let webhookService: jest.Mocked<WebhookDeliveryService>;

  const mockUser: AuthenticatedUser = {
    id: "user123",
    role: "USER",
    organizationId: "org123",
  };

  const mockAdminUser: AuthenticatedUser = {
    id: "admin123", 
    role: "ADMIN",
    organizationId: "org123",
  };

  beforeEach(async () => {
    const mockPrismaService = {
      $transaction: jest.fn(),
      proof: {
        findFirst: jest.fn(),
      },
      proofDispute: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        groupBy: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
      },
      organizationMember: {
        findFirst: jest.fn(),
      },
    };

    const mockWebhookService = {
      enqueueForOrganization: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputesService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: WebhookDeliveryService,
          useValue: mockWebhookService,
        },
      ],
    }).compile();

    service = module.get<DisputesService>(DisputesService);
    prismaService = module.get(PrismaService);
    webhookService = module.get(WebhookDeliveryService);
  });

  describe("submitDispute", () => {
    const validDisputeInput = {
      proofId: "proof123",
      category: DisputeCategory.ACCURACY,
      evidenceCommitment: "sha256:a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3",
    };

    it("should successfully submit a dispute", async () => {
      // Mock organization access verification
      prismaService.organizationMember.findFirst.mockResolvedValue({ userId: "user123" });

      // Mock proof exists
      const mockProof = {
        id: "proof123",
        userId: "user123",
        user: {
          organizationMemberships: [{ organizationId: "org123" }],
        },
      };
      prismaService.proof.findFirst.mockResolvedValue(mockProof);

      // Mock no existing dispute
      const mockTransaction = jest.fn().mockImplementation(async (callback) => {
        return callback({
          proofDispute: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({
              id: "dispute123",
              organizationId: "org123",
              proofId: "proof123",
              category: DisputeCategory.ACCURACY,
              status: DisputeStatus.OPEN,
              submittedBy: "user123",
              submittedAt: new Date(),
              proof: { id: "proof123", proofType: "INCOME", userId: "user123" },
            }),
          },
          auditLog: { create: jest.fn() },
        });
      });

      prismaService.$transaction.mockImplementation(mockTransaction);

      const result = await service.submitDispute(mockUser, "org123", validDisputeInput);

      expect(result.id).toBe("dispute123");
      expect(result.status).toBe(DisputeStatus.OPEN);
      expect(result.category).toBe(DisputeCategory.ACCURACY);
    });

    it("should reject dispute if proof not found", async () => {
      prismaService.organizationMember.findFirst.mockResolvedValue({ userId: "user123" });
      prismaService.proof.findFirst.mockResolvedValue(null);

      await expect(
        service.submitDispute(mockUser, "org123", validDisputeInput)
      ).rejects.toThrow(NotFoundException);
    });

    it("should reject duplicate active dispute", async () => {
      prismaService.organizationMember.findFirst.mockResolvedValue({ userId: "user123" });
      
      const mockProof = {
        id: "proof123",
        userId: "user123",
        user: { organizationMemberships: [{ organizationId: "org123" }] },
      };
      prismaService.proof.findFirst.mockResolvedValue(mockProof);

      // Mock existing active dispute
      const mockTransaction = jest.fn().mockImplementation(async (callback) => {
        return callback({
          proofDispute: {
            findFirst: jest.fn().mockResolvedValue({
              id: "existing123",
              status: DisputeStatus.OPEN,
            }),
          },
        });
      });

      prismaService.$transaction.mockImplementation(mockTransaction);

      await expect(
        service.submitDispute(mockUser, "org123", validDisputeInput)
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject invalid evidence commitment format", async () => {
      prismaService.organizationMember.findFirst.mockResolvedValue({ userId: "user123" });
      
      const invalidInput = {
        ...validDisputeInput,
        evidenceCommitment: "invalid-format",
      };

      await expect(
        service.submitDispute(mockUser, "org123", invalidInput)
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("assignDispute", () => {
    it("should successfully assign dispute as admin", async () => {
      prismaService.organizationMember.findFirst
        .mockResolvedValueOnce({ userId: "admin123" }) // Admin access
        .mockResolvedValueOnce({ userId: "reviewer123" }); // Assignee access

      const mockDispute = {
        id: "dispute123",
        status: DisputeStatus.OPEN,
        proofId: "proof123",
        assignedTo: null,
      };
      
      const mockTransaction = jest.fn().mockImplementation(async (callback) => {
        return callback({
          proofDispute: {
            findFirst: jest.fn().mockResolvedValue(mockDispute),
            update: jest.fn().mockResolvedValue({
              ...mockDispute,
              status: DisputeStatus.ASSIGNED,
              assignedTo: "reviewer123",
              assignedAt: new Date(),
            }),
          },
          auditLog: { create: jest.fn() },
        });
      });

      prismaService.$transaction.mockImplementation(mockTransaction);

      const result = await service.assignDispute(
        mockAdminUser,
        "org123",
        "dispute123",
        { assignedTo: "reviewer123" }
      );

      expect(result.status).toBe(DisputeStatus.ASSIGNED);
      expect(result.assignedTo).toBe("reviewer123");
    });

    it("should reject assignment by non-admin", async () => {
      prismaService.organizationMember.findFirst.mockResolvedValue({ userId: "user123" });

      await expect(
        service.assignDispute(mockUser, "org123", "dispute123", { assignedTo: "reviewer123" })
      ).rejects.toThrow(ForbiddenException);
    });

    it("should reject assignment to invalid assignee", async () => {
      prismaService.organizationMember.findFirst
        .mockResolvedValueOnce({ userId: "admin123" }) // Admin access
        .mockResolvedValueOnce(null); // Invalid assignee

      await expect(
        service.assignDispute(
          mockAdminUser,
          "org123",
          "dispute123",
          { assignedTo: "invalid123" }
        )
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("resolveDispute", () => {
    const resolutionInput = {
      resolutionOutcome: "UPHELD",
      resolutionReason: "Evidence supports the dispute claim.",
    };

    it("should successfully resolve dispute as admin", async () => {
      prismaService.organizationMember.findFirst.mockResolvedValue({ userId: "admin123" });

      const mockDispute = {
        id: "dispute123",
        status: DisputeStatus.ASSIGNED,
        proofId: "proof123",
        assignedTo: "reviewer123",
        category: DisputeCategory.ACCURACY,
      };

      const mockTransaction = jest.fn().mockImplementation(async (callback) => {
        return callback({
          proofDispute: {
            findFirst: jest.fn().mockResolvedValue(mockDispute),
            update: jest.fn().mockResolvedValue({
              ...mockDispute,
              status: DisputeStatus.RESOLVED,
              resolutionOutcome: "UPHELD",
              resolutionReason: "Evidence supports the dispute claim.",
              resolvedBy: "admin123",
              resolvedAt: new Date(),
            }),
          },
          auditLog: { create: jest.fn() },
        });
      });

      prismaService.$transaction.mockImplementation(mockTransaction);

      const result = await service.resolveDispute(
        mockAdminUser,
        "org123",
        "dispute123",
        resolutionInput
      );

      expect(result.status).toBe(DisputeStatus.RESOLVED);
      expect(result.resolutionOutcome).toBe("UPHELD");
      expect(result.resolvedBy).toBe("admin123");
    });

    it("should successfully resolve dispute as assigned reviewer", async () => {
      const mockReviewer: AuthenticatedUser = {
        id: "reviewer123",
        role: "USER",
        organizationId: "org123",
      };

      prismaService.organizationMember.findFirst.mockResolvedValue({ userId: "reviewer123" });

      const mockDispute = {
        id: "dispute123",
        status: DisputeStatus.ASSIGNED,
        proofId: "proof123",
        assignedTo: "reviewer123", // Same as current user
        category: DisputeCategory.ACCURACY,
      };

      const mockTransaction = jest.fn().mockImplementation(async (callback) => {
        return callback({
          proofDispute: {
            findFirst: jest.fn().mockResolvedValue(mockDispute),
            update: jest.fn().mockResolvedValue({
              ...mockDispute,
              status: DisputeStatus.RESOLVED,
              resolutionOutcome: "DISMISSED",
              resolvedBy: "reviewer123",
              resolvedAt: new Date(),
            }),
          },
          auditLog: { create: jest.fn() },
        });
      });

      prismaService.$transaction.mockImplementation(mockTransaction);

      const result = await service.resolveDispute(
        mockReviewer,
        "org123",
        "dispute123",
        { ...resolutionInput, resolutionOutcome: "DISMISSED" }
      );

      expect(result.status).toBe(DisputeStatus.RESOLVED);
      expect(result.resolvedBy).toBe("reviewer123");
    });

    it("should reject resolution by unauthorized user", async () => {
      prismaService.organizationMember.findFirst.mockResolvedValue({ userId: "user123" });

      const mockDispute = {
        id: "dispute123",
        status: DisputeStatus.ASSIGNED,
        proofId: "proof123",
        assignedTo: "reviewer123", // Different from current user
        category: DisputeCategory.ACCURACY,
      };

      prismaService.proofDispute.findFirst.mockResolvedValue(mockDispute);

      await expect(
        service.resolveDispute(mockUser, "org123", "dispute123", resolutionInput)
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("withdrawDispute", () => {
    it("should successfully withdraw dispute as submitter", async () => {
      prismaService.organizationMember.findFirst.mockResolvedValue({ userId: "user123" });

      const mockDispute = {
        id: "dispute123",
        status: DisputeStatus.OPEN,
        submittedBy: "user123", // Same as current user
        proofId: "proof123",
      };

      const mockTransaction = jest.fn().mockImplementation(async (callback) => {
        return callback({
          proofDispute: {
            findFirst: jest.fn().mockResolvedValue(mockDispute),
            update: jest.fn().mockResolvedValue({
              ...mockDispute,
              status: DisputeStatus.WITHDRAWN,
              withdrawnAt: new Date(),
            }),
          },
          auditLog: { create: jest.fn() },
        });
      });

      prismaService.$transaction.mockImplementation(mockTransaction);

      const result = await service.withdrawDispute(mockUser, "org123", "dispute123");

      expect(result.status).toBe(DisputeStatus.WITHDRAWN);
    });

    it("should reject withdrawal by non-submitter", async () => {
      prismaService.organizationMember.findFirst.mockResolvedValue({ userId: "user123" });

      const mockDispute = {
        id: "dispute123",
        status: DisputeStatus.OPEN,
        submittedBy: "otheruser123", // Different from current user
        proofId: "proof123",
      };

      prismaService.proofDispute.findFirst.mockResolvedValue(mockDispute);

      await expect(
        service.withdrawDispute(mockUser, "org123", "dispute123")
      ).rejects.toThrow(ForbiddenException);
    });

    it("should reject withdrawal of non-open dispute", async () => {
      prismaService.organizationMember.findFirst.mockResolvedValue({ userId: "user123" });

      const mockDispute = {
        id: "dispute123",
        status: DisputeStatus.RESOLVED, // Not OPEN
        submittedBy: "user123",
        proofId: "proof123",
      };

      prismaService.proofDispute.findFirst.mockResolvedValue(mockDispute);

      await expect(
        service.withdrawDispute(mockUser, "org123", "dispute123")
      ).rejects.toThrow(BadRequestException);
    });
  });
});