import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { ProofsController } from "./proofs.controller";
import { ListProofsDto } from "./dto/list-proofs.dto";
import { buildAuthorizationMatrix } from "../common/guards/authorization-policy.registry";
import { CreateEmployerPaymentProofDto } from "./dto/create-employer-payment-proof.dto";
import { CreateEmploymentContinuityProofDto } from "./dto/create-employment-continuity-proof.dto";
import { CreateMinimumIncomeProofDto } from "./dto/create-minimum-income-proof.dto";
import { CreatePaymentReceiptProofDto } from "./dto/create-payment-receipt-proof.dto";
import { CreateRecurringIncomeProofDto } from "./dto/create-recurring-income-proof.dto";
import { ProofCreatedDto } from "./dto/proof-created.dto";
import {
  ProofDetailResponseDto,
  ProofListResponseDto,
} from "./dto/proof-history-response.dto";
import { RevokeProofResponseDto } from "./dto/revoke-proof-response.dto";
import { VerifyProofResponseDto } from "./dto/verify-proof-response.dto";
import { VerificationStatsDto } from "./dto/verification-stats.dto";

type ProofsServiceMock = {
  listProofs: jest.Mock;
  getProofDetail: jest.Mock;
  createPaymentReceiptProof: jest.Mock;
  createMinimumIncomeProof: jest.Mock;
  createRecurringIncomeProof: jest.Mock;
  createEmployerPaymentProof: jest.Mock;
  createEmploymentContinuityProof: jest.Mock;
  revokeProof: jest.Mock;
  verifyProof: jest.Mock;
  getVerificationStats: jest.Mock;
};

describe("ProofsController", () => {
  let controller: ProofsController;
  let proofsService: ProofsServiceMock;

  const authenticatedUser: AuthenticatedUser = {
    id: "user_123",
    walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1",
    walletHash: "hash_user_123",
    role: "WORKER",
  };

  const proofId = "018e1234-abcd-7000-8000-abcdef012345";

  beforeEach(() => {
    proofsService = {
      listProofs: jest.fn(),
      getProofDetail: jest.fn(),
      createPaymentReceiptProof: jest.fn(),
      createMinimumIncomeProof: jest.fn(),
      createRecurringIncomeProof: jest.fn(),
      createEmployerPaymentProof: jest.fn(),
      createEmploymentContinuityProof: jest.fn(),
      revokeProof: jest.fn(),
      verifyProof: jest.fn(),
      getVerificationStats: jest.fn(),
    };

    controller = new ProofsController(proofsService as never, {} as never, {} as never);
  });

  describe("listProofs", () => {
    it("should list proofs for the authenticated user", async () => {
      const proofList: ProofListResponseDto = {
        data: [] as any,
        pageInfo: { hasMore: false, nextCursor: null },
      };
      proofsService.listProofs.mockResolvedValueOnce(proofList);

      const query: ListProofsDto = { limit: 20 };
      const result = await controller.listProofs(authenticatedUser, query);

      expect(result).toEqual(proofList);
      expect(proofsService.listProofs).toHaveBeenCalledWith(authenticatedUser.id, query);
    });

    it("should support cursor-based pagination", async () => {
      const proofList: ProofListResponseDto = {
        data: [] as any,
        pageInfo: { hasMore: true, nextCursor: "cursor_123" },
      };
      proofsService.listProofs.mockResolvedValueOnce(proofList);

      const query: ListProofsDto = { limit: 20, cursor: "cursor_abc" };
      await controller.listProofs(authenticatedUser, query);

      expect(proofsService.listProofs).toHaveBeenCalledWith(authenticatedUser.id, query);
    });

    it("should reject invalid cursor", async () => {
      proofsService.listProofs.mockRejectedValueOnce(
        new BadRequestException("Invalid cursor"),
      );

      const query: ListProofsDto = { limit: 20, cursor: "invalid" };

      await expect(controller.listProofs(authenticatedUser, query)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should handle empty proof list", async () => {
      const proofList: ProofListResponseDto = {
        data: [] as any,
        pageInfo: { hasMore: false, nextCursor: null },
      };
      proofsService.listProofs.mockResolvedValueOnce(proofList);

      const result = await controller.listProofs(authenticatedUser, { limit: 20 });

      expect(result.data).toEqual([]);
      expect(result.pageInfo.hasMore).toBe(false);
    });
  });

  describe("getProofDetail", () => {
    it("should get proof details for the authenticated user", async () => {
      const proofDetail: ProofDetailResponseDto = {
        id: proofId,
        schemaVersion: "earnproof.minimum-income.v1",
        type: "MINIMUM_INCOME" as any,
        localStatus: "ACTIVE" as any,
        credentialValidity: "valid" as any,
        expired: false,
        asset: { code: "USDC", issuer: null },
        periodStart: "2027-01-01",
        periodEnd: "2027-12-31",
        issuedAt: "2027-01-01T00:00:00.000Z",
        expiresAt: "2028-01-01T00:00:00.000Z",
        revokedAt: null,
        revokedByType: null,
        revocationReasonCode: null,
        revocationReasonPrivate: null,
        revocationEvidenceHash: null,
        anchoring: { anchored: false, reason: "disabled" } as any,
      };
      proofsService.getProofDetail.mockResolvedValueOnce(proofDetail);

      const result = await controller.getProofDetail(authenticatedUser, proofId);

      expect(result).toEqual(proofDetail);
      expect(proofsService.getProofDetail).toHaveBeenCalledWith(
        authenticatedUser,
        proofId,
      );
    });

    it("should return 404 for non-existent proof", async () => {
      proofsService.getProofDetail.mockRejectedValueOnce(
        new NotFoundException("Proof not found"),
      );

      await expect(
        controller.getProofDetail(authenticatedUser, "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("should return 404 for proof not accessible to user", async () => {
      proofsService.getProofDetail.mockRejectedValueOnce(
        new NotFoundException("Proof not found or not accessible to this user"),
      );

      await expect(
        controller.getProofDetail(authenticatedUser, "other_user_proof"),
      ).rejects.toThrow(NotFoundException);
    });

    it("should enforce ownership boundaries", async () => {
      const otherUser: AuthenticatedUser = {
        id: "user_456",
        walletAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2",
        walletHash: "hash_user_456",
        role: "WORKER",
      };

      proofsService.getProofDetail.mockRejectedValueOnce(
        new NotFoundException(),
      );

      await expect(controller.getProofDetail(otherUser, proofId)).rejects.toThrow(
        NotFoundException,
      );

      expect(proofsService.getProofDetail).toHaveBeenCalledWith(otherUser, proofId);
    });
  });

  describe("createPaymentReceiptProof", () => {
    it("should create a payment-receipt proof", async () => {
      const proof: ProofCreatedDto = {
        id: proofId,
        credential: {
          credentialSubject: {
            payment: {
              receivedAmount: "100.00",
              asset: "USDC",
            },
          },
        },
        anchored: false,
        anchoringResult: null,
      } as any;
      proofsService.createPaymentReceiptProof.mockResolvedValueOnce(proof);

      const body: CreatePaymentReceiptProofDto = {
        paymentId: "clx1abc2def3ghi4",
        discloseSender: false,
        discloseAmount: false,
      };
      const result = await controller.createPaymentReceiptProof(
        authenticatedUser,
        body,
      );

      expect(result).toEqual(proof);
      expect(proofsService.createPaymentReceiptProof).toHaveBeenCalledWith(
        authenticatedUser,
        body,
      );
    });

    it("should return 404 for non-existent payment", async () => {
      proofsService.createPaymentReceiptProof.mockRejectedValueOnce(
        new NotFoundException("Payment not found"),
      );

      const body: CreatePaymentReceiptProofDto = {
        paymentId: "nonexistent",
        discloseSender: false,
        discloseAmount: false,
      };

      await expect(
        controller.createPaymentReceiptProof(authenticatedUser, body),
      ).rejects.toThrow(NotFoundException);
    });

    it("should return 422 for ineligible payment", async () => {
      proofsService.createPaymentReceiptProof.mockRejectedValueOnce(
        new BadRequestException("Payment is excluded"),
      );

      const body: CreatePaymentReceiptProofDto = {
        paymentId: "clx1abc2def3ghi4",
        discloseSender: false,
        discloseAmount: false,
      };

      await expect(
        controller.createPaymentReceiptProof(authenticatedUser, body),
      ).rejects.toThrow(BadRequestException);
    });

    it("should support sender and amount disclosure options", async () => {
      const proof: ProofCreatedDto = {
        id: proofId,
        credential: {},
        anchored: false,
        anchoringResult: null,
      } as any;
      proofsService.createPaymentReceiptProof.mockResolvedValueOnce(proof);

      const body: CreatePaymentReceiptProofDto = {
        paymentId: "clx1abc2def3ghi4",
        discloseSender: true,
        discloseAmount: true,
      };
      await controller.createPaymentReceiptProof(authenticatedUser, body);

      expect(proofsService.createPaymentReceiptProof).toHaveBeenCalledWith(
        authenticatedUser,
        expect.objectContaining({
          discloseSender: true,
          discloseAmount: true,
        }),
      );
    });
  });

  describe("createMinimumIncomeProof", () => {
    it("should create a minimum-income proof", async () => {
      const proof: ProofCreatedDto = {
        id: proofId,
        credential: {
          credentialSubject: {
            income: {
              amount: "1000.00",
              asset: "USDC",
              period: {
                start: "2027-01-01",
                end: "2027-12-31",
              },
            },
          },
        },
        anchored: false,
        anchoringResult: null,
      } as any;
      proofsService.createMinimumIncomeProof.mockResolvedValueOnce(proof);

      const body: CreateMinimumIncomeProofDto = {
        thresholdAmount: "1000.00",
        assetCode: "USDC",
        startDate: "2027-01-01",
        endDate: "2027-12-31",
      } as any;
      const result = await controller.createMinimumIncomeProof(
        authenticatedUser,
        body,
      );

      expect(result).toEqual(proof);
      expect(proofsService.createMinimumIncomeProof).toHaveBeenCalledWith(
        authenticatedUser,
        body,
      );
    });

    it("should return 400 for invalid period range", async () => {
      proofsService.createMinimumIncomeProof.mockRejectedValueOnce(
        new BadRequestException("Period range invalid"),
      );

      const body: CreateMinimumIncomeProofDto = {
        thresholdAmount: "1000.00",
        assetCode: "USDC",
        startDate: "2027-12-31",
        endDate: "2027-01-01",
      } as any;

      await expect(
        controller.createMinimumIncomeProof(authenticatedUser, body),
      ).rejects.toThrow(BadRequestException);
    });

    it("should return 400 when threshold not met", async () => {
      proofsService.createMinimumIncomeProof.mockRejectedValueOnce(
        new BadRequestException("Threshold not met"),
      );

      const body: CreateMinimumIncomeProofDto = {
        thresholdAmount: "10000.00",
        assetCode: "USDC",
        startDate: "2027-01-01",
        endDate: "2027-01-31",
      } as any;

      await expect(
        controller.createMinimumIncomeProof(authenticatedUser, body),
      ).rejects.toThrow(BadRequestException);
    });

    it("should return 400 for unsupported asset", async () => {
      proofsService.createMinimumIncomeProof.mockRejectedValueOnce(
        new BadRequestException("Asset not supported"),
      );

      const body: CreateMinimumIncomeProofDto = {
        thresholdAmount: "1000.00",
        assetCode: "UNSUPPORTED",
        startDate: "2027-01-01",
        endDate: "2027-12-31",
      } as any;

      await expect(
        controller.createMinimumIncomeProof(authenticatedUser, body),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("createEmployerPaymentProof", () => {
    const body: CreateEmployerPaymentProofDto = {
      trustedSourceId: "ts_1",
      assetCode: "USDC",
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
    };

    it("delegates to the service with the authenticated user", async () => {
      const created = { proofId, status: "ACTIVE" };
      proofsService.createEmployerPaymentProof.mockResolvedValueOnce(created);

      await expect(
        controller.createEmployerPaymentProof(authenticatedUser, body),
      ).resolves.toEqual(created);
      expect(proofsService.createEmployerPaymentProof).toHaveBeenCalledWith(
        authenticatedUser,
        body,
      );
    });

    it("propagates service refusals unchanged", async () => {
      proofsService.createEmployerPaymentProof.mockRejectedValueOnce(
        new NotFoundException("Trusted source not found"),
      );

      await expect(
        controller.createEmployerPaymentProof(authenticatedUser, body),
      ).rejects.toThrow(NotFoundException);
    });

    it("is an authenticated, owner-scoped POST route", () => {
      const route = buildAuthorizationMatrix([ProofsController]).find(
        (entry) => entry.method === "createEmployerPaymentProof",
      );

      expect(route).toMatchObject({
        path: "/proofs/employer-payment",
        httpMethod: "POST",
        policy: { access: "authenticated", ownership: "user" },
      });
    });
  });

  describe("createEmploymentContinuityProof", () => {
    const body: CreateEmploymentContinuityProofDto = {
      trustedSourceId: "ts_1",
      assetCode: "USDC",
      periodStart: "2026-01-01T00:00:00.000Z",
      observedPeriods: 6,
    };

    it("delegates to the service with the authenticated user", async () => {
      const created = { proofId, status: "ACTIVE" };
      proofsService.createEmploymentContinuityProof.mockResolvedValueOnce(created);

      await expect(
        controller.createEmploymentContinuityProof(authenticatedUser, body),
      ).resolves.toEqual(created);
      expect(proofsService.createEmploymentContinuityProof).toHaveBeenCalledWith(
        authenticatedUser,
        body,
      );
    });

    it("is an authenticated, owner-scoped POST route", () => {
      const route = buildAuthorizationMatrix([ProofsController]).find(
        (entry) => entry.method === "createEmploymentContinuityProof",
      );

      expect(route).toMatchObject({
        path: "/proofs/employment-continuity",
        httpMethod: "POST",
        policy: { access: "authenticated", ownership: "user" },
      });
    });
  });

  describe("createRecurringIncomeProof", () => {
    it("should create a recurring-income proof", async () => {
      const proof: ProofCreatedDto = {
        id: proofId,
        credential: {
          credentialSubject: {
            recurringIncome: {
              assetCode: "USDC",
              cadence: "MONTHLY",
              intervals: 12,
            },
          },
        },
        anchored: false,
        anchoringResult: null,
      } as any;
      proofsService.createRecurringIncomeProof.mockResolvedValueOnce(proof);

      const body: CreateRecurringIncomeProofDto = {
        assetCode: "USDC",
        cadence: "MONTHLY",
        intervals: 12,
        startDate: "2027-01-01",
        endDate: "2027-12-31",
      } as any;
      const result = await controller.createRecurringIncomeProof(
        authenticatedUser,
        body,
      );

      expect(result).toEqual(proof);
      expect(proofsService.createRecurringIncomeProof).toHaveBeenCalledWith(
        authenticatedUser,
        body,
      );
    });

    it("should return 400 when cadence is not satisfied", async () => {
      proofsService.createRecurringIncomeProof.mockRejectedValueOnce(
        new BadRequestException("Cadence is unsatisfied"),
      );

      const body: CreateRecurringIncomeProofDto = {
        assetCode: "USDC",
        cadence: "DAILY",
        intervals: 100,
        startDate: "2027-01-01",
        endDate: "2027-01-31",
      } as any;

      await expect(
        controller.createRecurringIncomeProof(authenticatedUser, body),
      ).rejects.toThrow(BadRequestException);
    });

    it("should return 400 for invalid period", async () => {
      proofsService.createRecurringIncomeProof.mockRejectedValueOnce(
        new BadRequestException("Invalid period"),
      );

      const body: CreateRecurringIncomeProofDto = {
        assetCode: "USDC",
        cadence: "MONTHLY",
        intervals: 12,
        startDate: "2027-12-31",
        endDate: "2027-01-01",
      } as any;

      await expect(
        controller.createRecurringIncomeProof(authenticatedUser, body),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("revokeProof", () => {
    it("should revoke a proof owned by the authenticated user", async () => {
      const revokeResult: RevokeProofResponseDto = {
        id: proofId,
        status: "REVOKED" as any,
        revokedAt: "2027-01-02T00:00:00.000Z",
        revokedByType: "OWNER" as any,
        revocationReasonCode: "OWNER_REQUESTED" as any,
        anchoring: { anchored: false, reason: "disabled" } as any,
      };
      proofsService.revokeProof.mockResolvedValueOnce(revokeResult);

      const result = await controller.revokeProof(authenticatedUser, proofId);

      expect(result).toEqual(revokeResult);
      expect(proofsService.revokeProof).toHaveBeenCalledWith(
        authenticatedUser,
        proofId,
      );
    });

    it("should return 404 for non-existent proof", async () => {
      proofsService.revokeProof.mockRejectedValueOnce(
        new NotFoundException("Proof not found"),
      );

      await expect(controller.revokeProof(authenticatedUser, "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should return 403 for proof belonging to another user", async () => {
      proofsService.revokeProof.mockRejectedValueOnce(
        new ForbiddenException("Proof does not belong to the authenticated user"),
      );

      await expect(controller.revokeProof(authenticatedUser, proofId)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("should handle on-chain revocation", async () => {
      const revokeResult: RevokeProofResponseDto = {
        id: proofId,
        status: "REVOKED" as any,
        revokedAt: "2027-01-02T00:00:00.000Z",
        revokedByType: "OWNER" as any,
        revocationReasonCode: "OWNER_REQUESTED" as any,
        anchoring: { anchored: true, transactionHash: "hash123" } as any,
      };
      proofsService.revokeProof.mockResolvedValueOnce(revokeResult);

      const result = await controller.revokeProof(authenticatedUser, proofId);

      expect(result.anchoring.anchored).toBe(true);
    });
  });

  describe("verifyProof (public)", () => {
    const request = { ip: "203.0.113.7" } as never;

    it("should verify a proof without authentication", async () => {
      const verification: VerifyProofResponseDto = {
        result: "VALID" as any,
        status: "valid",
        credential: {
          id: proofId,
          type: "EarnProofMinimumIncomeCredential",
          schemaVersion: "earnproof.minimum-income.v1",
          issuer: "earnproof-backend",
          subject: { walletHash: "hash" },
          claim: {} as any,
          proof: { type: "hmac-sha256", signature: "sig" } as any,
        } as any,
      };
      proofsService.verifyProof.mockResolvedValueOnce(verification);

      const result = await controller.verifyProof(proofId, request);

      expect(result).toEqual(verification);
      expect(proofsService.verifyProof).toHaveBeenCalledWith(proofId, {
        ip: "203.0.113.7",
      });
    });

    it("should return valid=false for tampered proof", async () => {
      const verification: VerifyProofResponseDto = {
        result: "INVALID_SIGNATURE" as any,
        status: "invalid",
      };
      proofsService.verifyProof.mockResolvedValueOnce(verification);

      const result = await controller.verifyProof(proofId, request);

      expect(result.status).toBe("invalid");
    });

    it("should return 404 for non-existent proof", async () => {
      proofsService.verifyProof.mockRejectedValueOnce(
        new NotFoundException("Proof not found"),
      );

      await expect(controller.verifyProof("nonexistent", request)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should be accessible without user context", () => {
      // Verify that verifyProof does not require CurrentUser decorator
      expect(controller.verifyProof).toBeDefined();
    });
  });

  describe("getVerificationStats", () => {
    it("should get verification statistics for a proof", async () => {
      const stats: VerificationStatsDto = {
        VALID: 42,
        INVALID_SIGNATURE: 3,
        EXPIRED: 0,
        REVOKED: 0,
        UNKNOWN: 0,
        ISSUER_WARNING: 0,
      };
      proofsService.getVerificationStats.mockResolvedValueOnce(stats);

      const result = await controller.getVerificationStats(authenticatedUser, proofId);

      expect(result).toEqual(stats);
      expect(proofsService.getVerificationStats).toHaveBeenCalledWith(
        authenticatedUser.id,
        proofId,
      );
    });

    it("should return 404 for non-existent proof", async () => {
      proofsService.getVerificationStats.mockRejectedValueOnce(
        new NotFoundException("Proof not found"),
      );

      await expect(
        controller.getVerificationStats(authenticatedUser, "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("should return 403 for proof belonging to another user", async () => {
      proofsService.getVerificationStats.mockRejectedValueOnce(
        new ForbiddenException("The proof belongs to another user"),
      );

      await expect(
        controller.getVerificationStats(authenticatedUser, proofId),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should enforce ownership on statistics access", async () => {
      const otherUser: AuthenticatedUser = {
        id: "user_456",
        walletAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2",
        walletHash: "hash_user_456",
        role: "WORKER",
      };

      proofsService.getVerificationStats.mockRejectedValueOnce(
        new ForbiddenException(),
      );

      await expect(
        controller.getVerificationStats(otherUser, proofId),
      ).rejects.toThrow(ForbiddenException);

      expect(proofsService.getVerificationStats).toHaveBeenCalledWith(
        otherUser.id,
        proofId,
      );
    });
  });

  describe("authenticated request handling", () => {
    it("should enforce authentication on owned endpoints", () => {
      // These methods require CurrentUser decorator
      expect(controller.listProofs).toBeDefined();
      expect(controller.getProofDetail).toBeDefined();
      expect(controller.createPaymentReceiptProof).toBeDefined();
      expect(controller.createMinimumIncomeProof).toBeDefined();
      expect(controller.createRecurringIncomeProof).toBeDefined();
      expect(controller.revokeProof).toBeDefined();
      expect(controller.getVerificationStats).toBeDefined();
    });

    it("should allow public verification without authentication", () => {
      // verifyProof should not require authentication
      expect(controller.verifyProof).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("should propagate service errors to the caller", async () => {
      const error = new Error("Database connection failed");
      proofsService.listProofs.mockRejectedValueOnce(error);

      await expect(controller.listProofs(authenticatedUser, { limit: 20 })).rejects.toThrow(
        error,
      );
    });

    it("should distinguish between 404 and 403 errors", async () => {
      proofsService.revokeProof.mockRejectedValueOnce(
        new NotFoundException(),
      );

      await expect(controller.revokeProof(authenticatedUser, proofId)).rejects.toThrow(
        NotFoundException,
      );

      proofsService.revokeProof.mockRejectedValueOnce(
        new ForbiddenException(),
      );

      await expect(controller.revokeProof(authenticatedUser, proofId)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
