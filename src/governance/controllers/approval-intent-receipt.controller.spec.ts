import { Test, TestingModule } from "@nestjs/testing";
import { ApprovalIntentReceiptController } from "./approval-intent-receipt.controller";
import { ApprovalIntentReceiptService } from "../services/approval-intent-receipt.service";
import { ApprovalIntentReceiptKeysService } from "../services/approval-intent-receipt-keys.service";
import { ApprovalIntentReceiptResponseDto } from "../dto/approval-intent-receipt-response.dto";
import { ReceiptVerificationKeySetDto, ReceiptVerificationResultDto } from "../dto/receipt-verification-key.dto";

describe("ApprovalIntentReceiptController", () => {
  let controller: ApprovalIntentReceiptController;
  let receiptService: any;
  let keysService: any;

  const mockUser = { id: "user-1", walletHash: "h1", role: "ADMIN" };

  beforeEach(async () => {
    receiptService = {
      issueReceiptAfterApproval: jest.fn(),
      getReceipt: jest.fn(),
      getReceiptByApprovalId: jest.fn(),
      verifyReceipt: jest.fn(),
    };

    keysService = {
      getPublicKeySet: jest.fn(),
      getEtag: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApprovalIntentReceiptController],
      providers: [
        { provide: ApprovalIntentReceiptService, useValue: receiptService },
        { provide: ApprovalIntentReceiptKeysService, useValue: keysService },
      ],
    }).compile();

    controller = module.get(ApprovalIntentReceiptController);
  });

  // =========================================================================
  // issueReceipt
  // =========================================================================

  describe("issueReceipt", () => {
    it("issues a receipt for an approval", async () => {
      const mockReceipt = new ApprovalIntentReceiptResponseDto({
        id: "receipt-1",
        schemaVersion: "v1",
        receiptData: { type: "approval-intent-receipt" } as any,
        receiptHash: "sha256:abc",
        signingKeyId: "earnproof-v0",
        signature: "ed25519:xyz",
        credentialHash: "sha256:def",
        issuedAt: new Date(),
        createdAt: new Date(),
      });

      receiptService.issueReceiptAfterApproval.mockResolvedValueOnce(mockReceipt);

      const result = await controller.issueReceipt("approval-1", mockUser);

      expect(result).toBeDefined();
      expect(result.id).toBe("receipt-1");
      expect(receiptService.issueReceiptAfterApproval).toHaveBeenCalledWith("approval-1");
    });
  });

  // =========================================================================
  // getReceipt
  // =========================================================================

  describe("getReceipt", () => {
    it("retrieves a receipt by ID", async () => {
      const mockReceipt = new ApprovalIntentReceiptResponseDto({
        id: "receipt-1",
        schemaVersion: "v1",
        receiptData: { type: "approval-intent-receipt" } as any,
        receiptHash: "sha256:abc",
        signingKeyId: "earnproof-v0",
        signature: "ed25519:xyz",
        credentialHash: "sha256:def",
        issuedAt: new Date(),
        createdAt: new Date(),
      });

      receiptService.getReceipt.mockResolvedValueOnce(mockReceipt);

      const result = await controller.getReceipt("receipt-1", mockUser);

      expect(result).toBeDefined();
      expect(receiptService.getReceipt).toHaveBeenCalledWith("receipt-1", mockUser);
    });
  });

  // =========================================================================
  // verifyReceipt
  // =========================================================================

  describe("verifyReceipt", () => {
    it("verifies a receipt signature", async () => {
      const mockResult = new ReceiptVerificationResultDto({
        valid: true,
        receiptData: { type: "approval-intent-receipt" },
      });

      receiptService.verifyReceipt.mockResolvedValueOnce(mockResult);

      const result = await controller.verifyReceipt("receipt-1");

      expect(result.valid).toBe(true);
      expect(receiptService.verifyReceipt).toHaveBeenCalledWith("receipt-1");
    });
  });

  // =========================================================================
  // getVerificationKeys
  // =========================================================================

  describe("getVerificationKeys", () => {
    it("returns JWK Set of verification keys", async () => {
      const mockKeySet = new ReceiptVerificationKeySetDto([
        {
          alg: "EdDSA",
          crv: "Ed25519",
          kid: "earnproof-v0",
          kty: "OKP",
          use: "sig",
          status: "active",
          x: "placeholder-key",
        },
      ]);

      keysService.getPublicKeySet.mockReturnValueOnce(mockKeySet);
      keysService.getEtag.mockReturnValueOnce('"etag123"');

      const mockRes = {
        req: { headers: {} },
        setHeader: jest.fn(),
        json: jest.fn(),
      } as any;

      await controller.getVerificationKeys(mockRes);

      expect(mockRes.setHeader).toHaveBeenCalledWith("ETag", '"etag123"');
      expect(mockRes.json).toHaveBeenCalledWith(mockKeySet);
    });

    it("returns 304 Not Modified if ETag matches", async () => {
      const mockKeySet = new ReceiptVerificationKeySetDto([
        {
          alg: "EdDSA",
          crv: "Ed25519",
          kid: "earnproof-v0",
          kty: "OKP",
          use: "sig",
          status: "active",
          x: "placeholder-key",
        },
      ]);

      keysService.getPublicKeySet.mockReturnValueOnce(mockKeySet);
      keysService.getEtag.mockReturnValueOnce('"etag123"');

      const mockRes = {
        req: { headers: { "if-none-match": '"etag123"' } },
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      } as any;

      await controller.getVerificationKeys(mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(304);
      expect(mockRes.send).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // getReceiptByApprovalId
  // =========================================================================

  describe("getReceiptByApprovalId", () => {
    it("retrieves receipt by approval ID", async () => {
      const mockReceipt = new ApprovalIntentReceiptResponseDto({
        id: "receipt-1",
        schemaVersion: "v1",
        receiptData: { type: "approval-intent-receipt" } as any,
        receiptHash: "sha256:abc",
        signingKeyId: "earnproof-v0",
        signature: "ed25519:xyz",
        credentialHash: "sha256:def",
        issuedAt: new Date(),
        createdAt: new Date(),
      });

      receiptService.getReceiptByApprovalId.mockResolvedValueOnce(mockReceipt);

      const result = await controller.getReceiptByApprovalId("approval-1", mockUser);

      expect(result).toBeDefined();
      expect(receiptService.getReceiptByApprovalId).toHaveBeenCalledWith("approval-1", mockUser);
    });

    it("throws BadRequestException if no receipt issued", async () => {
      receiptService.getReceiptByApprovalId.mockResolvedValueOnce(null);

      await expect(controller.getReceiptByApprovalId("approval-1", mockUser)).rejects.toThrow();
    });
  });
});
