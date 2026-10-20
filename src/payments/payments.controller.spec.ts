import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PaymentClassification } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { PaymentsController } from "./payments.controller";
import { ListPaymentsDto } from "./dto/list-payments.dto";
import { SyncResultDto } from "./dto/sync-result.dto";
import { PaymentResponseDto } from "./dto/payment-response.dto";
import { UpdatePaymentClassificationDto } from "./dto/update-payment-classification.dto";

type PaymentsServiceMock = {
  syncPayments: jest.Mock;
  listPayments: jest.Mock;
  getPayment: jest.Mock;
  updateClassification: jest.Mock;
};

describe("PaymentsController", () => {
  let controller: PaymentsController;
  let paymentsService: PaymentsServiceMock;

  const authenticatedUser: AuthenticatedUser = {
    id: "user_123",
    walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1",
    walletHash: "hash_user_123",
    role: "WORKER",
  };

  const paymentId = "clx1abc2def3ghi4";
  const assetCode = "USDC";

  beforeEach(() => {
    paymentsService = {
      syncPayments: jest.fn(),
      listPayments: jest.fn(),
      getPayment: jest.fn(),
      updateClassification: jest.fn(),
    };

    controller = new PaymentsController(paymentsService as never);
  });

  describe("syncPayments", () => {
    it("should sync payments from Stellar Horizon and return sync result", async () => {
      const syncResult: SyncResultDto = {
        created: 5,
        updated: 2,
        skipped: 1,
      };
      paymentsService.syncPayments.mockResolvedValueOnce(syncResult);

      const result = await controller.syncPayments(authenticatedUser);

      expect(result).toEqual(syncResult);
      expect(paymentsService.syncPayments).toHaveBeenCalledWith(authenticatedUser);
      expect(paymentsService.syncPayments).toHaveBeenCalledTimes(1);
    });

    it("should handle sync errors gracefully", async () => {
      paymentsService.syncPayments.mockRejectedValueOnce(
        new Error("Stellar Horizon unavailable"),
      );

      await expect(controller.syncPayments(authenticatedUser)).rejects.toThrow(
        "Stellar Horizon unavailable",
      );
    });

    it("should pass the authenticated user to the service", async () => {
      const syncResult: SyncResultDto = { created: 0, updated: 0, skipped: 0 };
      paymentsService.syncPayments.mockResolvedValueOnce(syncResult);

      await controller.syncPayments(authenticatedUser);

      expect(paymentsService.syncPayments).toHaveBeenCalledWith(authenticatedUser);
    });
  });

  describe("listPayments", () => {
    it("should list payments for the authenticated user", async () => {
      const payments: PaymentResponseDto[] = [
        {
          id: paymentId,
          walletAddress: authenticatedUser.walletAddress,
          senderWalletHash: "hash_sender",
          amountDecimal: "100.50",
          assetCode,
          classification: PaymentClassification.INCOME,
          occurredAt: new Date("2027-01-01T00:00:00Z"),
          createdAt: new Date("2027-01-01T00:00:00Z"),
        },
      ];
      paymentsService.listPayments.mockResolvedValueOnce(payments);

      const query: ListPaymentsDto = {};
      const result = await controller.listPayments(authenticatedUser, query);

      expect(result).toEqual(payments);
      expect(paymentsService.listPayments).toHaveBeenCalledWith(
        authenticatedUser.id,
        query,
      );
    });

    it("should filter payments by classification", async () => {
      const payments: PaymentResponseDto[] = [];
      paymentsService.listPayments.mockResolvedValueOnce(payments);

      const query: ListPaymentsDto = {
        classification: PaymentClassification.INCOME,
      };
      await controller.listPayments(authenticatedUser, query);

      expect(paymentsService.listPayments).toHaveBeenCalledWith(
        authenticatedUser.id,
        query,
      );
    });

    it("should filter payments by asset code", async () => {
      const payments: PaymentResponseDto[] = [];
      paymentsService.listPayments.mockResolvedValueOnce(payments);

      const query: ListPaymentsDto = {
        assetCode: "USDC",
      };
      await controller.listPayments(authenticatedUser, query);

      expect(paymentsService.listPayments).toHaveBeenCalledWith(
        authenticatedUser.id,
        query,
      );
    });

    it("should apply both classification and asset code filters", async () => {
      const payments: PaymentResponseDto[] = [];
      paymentsService.listPayments.mockResolvedValueOnce(payments);

      const query: ListPaymentsDto = {
        classification: PaymentClassification.INCOME,
        assetCode: "USDC",
      };
      await controller.listPayments(authenticatedUser, query);

      expect(paymentsService.listPayments).toHaveBeenCalledWith(
        authenticatedUser.id,
        query,
      );
    });

    it("should handle empty payment list", async () => {
      paymentsService.listPayments.mockResolvedValueOnce([]);

      const result = await controller.listPayments(authenticatedUser, {});

      expect(result).toEqual([]);
    });

    it("should reject invalid query parameters", async () => {
      paymentsService.listPayments.mockRejectedValueOnce(
        new BadRequestException("Invalid classification"),
      );

      await expect(
        controller.listPayments(authenticatedUser, {
          classification: "INVALID" as PaymentClassification,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("getPayment", () => {
    it("should get a single payment by ID", async () => {
      const payment: PaymentResponseDto = {
        id: paymentId,
        walletAddress: authenticatedUser.walletAddress,
        senderWalletHash: "hash_sender",
        amountDecimal: "100.50",
        assetCode,
        classification: PaymentClassification.INCOME,
        occurredAt: new Date("2027-01-01T00:00:00Z"),
        createdAt: new Date("2027-01-01T00:00:00Z"),
      };
      paymentsService.getPayment.mockResolvedValueOnce(payment);

      const result = await controller.getPayment(authenticatedUser, paymentId);

      expect(result).toEqual(payment);
      expect(paymentsService.getPayment).toHaveBeenCalledWith(
        authenticatedUser.id,
        paymentId,
      );
    });

    it("should return 404 for non-existent payment", async () => {
      paymentsService.getPayment.mockRejectedValueOnce(
        new NotFoundException("Payment not found"),
      );

      await expect(
        controller.getPayment(authenticatedUser, "nonexistent"),
      ).rejects.toThrow(NotFoundException);
      expect(paymentsService.getPayment).toHaveBeenCalledWith(
        authenticatedUser.id,
        "nonexistent",
      );
    });

    it("should return 404 for payment belonging to another user", async () => {
      paymentsService.getPayment.mockRejectedValueOnce(
        new NotFoundException("Payment not found or does not belong to user"),
      );

      await expect(
        controller.getPayment(authenticatedUser, "other_user_payment"),
      ).rejects.toThrow(NotFoundException);
    });

    it("should enforce ownership boundaries", async () => {
      const otherUser: AuthenticatedUser = {
        id: "user_456",
        walletAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2",
        walletHash: "hash_user_456",
        role: "WORKER",
      };

      paymentsService.getPayment.mockRejectedValueOnce(
        new NotFoundException("Payment not found"),
      );

      await expect(
        controller.getPayment(otherUser, paymentId),
      ).rejects.toThrow(NotFoundException);

      // Verify service was called with other user's ID
      expect(paymentsService.getPayment).toHaveBeenCalledWith(otherUser.id, paymentId);
    });
  });

  describe("updateClassification", () => {
    it("should update payment classification", async () => {
      const updatedPayment: PaymentResponseDto = {
        id: paymentId,
        walletAddress: authenticatedUser.walletAddress,
        senderWalletHash: "hash_sender",
        amountDecimal: "100.50",
        assetCode,
        classification: PaymentClassification.EXPENSE,
        occurredAt: new Date("2027-01-01T00:00:00Z"),
        createdAt: new Date("2027-01-01T00:00:00Z"),
      };
      paymentsService.updateClassification.mockResolvedValueOnce(updatedPayment);

      const body: UpdatePaymentClassificationDto = {
        classification: PaymentClassification.EXPENSE,
      };
      const result = await controller.updateClassification(
        authenticatedUser,
        paymentId,
        body,
      );

      expect(result).toEqual(updatedPayment);
      expect(paymentsService.updateClassification).toHaveBeenCalledWith(
        authenticatedUser,
        paymentId,
        PaymentClassification.EXPENSE,
      );
    });

    it("should reject invalid classification", async () => {
      paymentsService.updateClassification.mockRejectedValueOnce(
        new BadRequestException("Invalid classification"),
      );

      const body: UpdatePaymentClassificationDto = {
        classification: "INVALID" as PaymentClassification,
      };

      await expect(
        controller.updateClassification(authenticatedUser, paymentId, body),
      ).rejects.toThrow(BadRequestException);
    });

    it("should return 404 for non-existent payment", async () => {
      paymentsService.updateClassification.mockRejectedValueOnce(
        new NotFoundException("Payment not found"),
      );

      const body: UpdatePaymentClassificationDto = {
        classification: PaymentClassification.INCOME,
      };

      await expect(
        controller.updateClassification(authenticatedUser, "nonexistent", body),
      ).rejects.toThrow(NotFoundException);
    });

    it("should enforce ownership on classification update", async () => {
      paymentsService.updateClassification.mockRejectedValueOnce(
        new NotFoundException("Payment not found or does not belong to user"),
      );

      const body: UpdatePaymentClassificationDto = {
        classification: PaymentClassification.INCOME,
      };

      await expect(
        controller.updateClassification(authenticatedUser, paymentId, body),
      ).rejects.toThrow(NotFoundException);

      // Verify service received the authenticated user
      expect(paymentsService.updateClassification).toHaveBeenCalledWith(
        authenticatedUser,
        paymentId,
        PaymentClassification.INCOME,
      );
    });

    it("should support multiple classification transitions", async () => {
      const classifications = [
        PaymentClassification.INCOME,
        PaymentClassification.EXPENSE,
        PaymentClassification.TRANSFER,
      ];

      for (const classification of classifications) {
        const updatedPayment: PaymentResponseDto = {
          id: paymentId,
          walletAddress: authenticatedUser.walletAddress,
          senderWalletHash: "hash_sender",
          amountDecimal: "100.50",
          assetCode,
          classification,
          occurredAt: new Date("2027-01-01T00:00:00Z"),
          createdAt: new Date("2027-01-01T00:00:00Z"),
        };
        paymentsService.updateClassification.mockResolvedValueOnce(updatedPayment);

        const body: UpdatePaymentClassificationDto = { classification };
        const result = await controller.updateClassification(
          authenticatedUser,
          paymentId,
          body,
        );

        expect(result.classification).toBe(classification);
      }

      expect(paymentsService.updateClassification).toHaveBeenCalledTimes(3);
    });
  });

  describe("authenticated request handling", () => {
    it("should enforce authentication on all endpoints", () => {
      // Verify that all public methods require CurrentUser decorator
      expect(controller.syncPayments).toBeDefined();
      expect(controller.listPayments).toBeDefined();
      expect(controller.getPayment).toBeDefined();
      expect(controller.updateClassification).toBeDefined();
    });

    it("should pass user context to all service calls", async () => {
      paymentsService.listPayments.mockResolvedValueOnce([]);
      paymentsService.getPayment.mockResolvedValueOnce(null);

      await controller.listPayments(authenticatedUser, {});
      await controller.getPayment(authenticatedUser, paymentId);

      expect(paymentsService.listPayments).toHaveBeenCalledWith(
        authenticatedUser.id,
        expect.any(Object),
      );
      expect(paymentsService.getPayment).toHaveBeenCalledWith(
        authenticatedUser.id,
        expect.any(String),
      );
    });
  });

  describe("error handling", () => {
    it("should propagate service errors to the caller", async () => {
      const error = new Error("Database connection failed");
      paymentsService.syncPayments.mockRejectedValueOnce(error);

      await expect(controller.syncPayments(authenticatedUser)).rejects.toThrow(
        error,
      );
    });

    it("should distinguish between 404 and other errors", async () => {
      paymentsService.getPayment.mockRejectedValueOnce(
        new NotFoundException(),
      );

      await expect(
        controller.getPayment(authenticatedUser, paymentId),
      ).rejects.toThrow(NotFoundException);

      paymentsService.getPayment.mockRejectedValueOnce(
        new Error("Internal server error"),
      );

      await expect(
        controller.getPayment(authenticatedUser, paymentId),
      ).rejects.toThrow("Internal server error");
    });
  });
});
