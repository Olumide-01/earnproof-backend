import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { TransactionConfirmationController } from "./transaction-confirmation.controller";
import { TransactionConfirmationStatus } from "@prisma/client";

describe("TransactionConfirmationController", () => {
  let controller: TransactionConfirmationController;
  let mockService: any;
  let mockPrisma: any;

  const user = {
    id: "user-1",
    walletAddress: "GABC",
    walletHash: "hash",
    role: "MEMBER",
  };

  beforeEach(() => {
    mockService = {
      recordSubmission: jest.fn(async (input) => ({
        id: "tc-1",
        ...input,
        status: TransactionConfirmationStatus.SUBMITTED,
        retryCount: 0,
        explorerUrl: "https://stellar.expert/explorer/testnet/tx/" + input.transactionHash,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      getStatus: jest.fn(async (orgId, net, hash) => {
        if (orgId !== "org-primary" && orgId !== "org-explicit") {
          throw new NotFoundException("Not found");
        }
        return {
          id: "tc-1",
          organizationId: orgId,
          network: net,
          transactionHash: hash,
          operationType: "ANCHOR",
          status: TransactionConfirmationStatus.CONFIRMED,
          retryCount: 1,
          explorerUrl: `https://stellar.expert/explorer/${net}/tx/${hash}`,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }),
    };

    mockPrisma = {
      organizationMember: {
        findFirst: jest.fn(async ({ where }: any) => {
          if (where.organizationId === "org-unauthorized") {
            return null;
          }
          if (where.organizationId) {
            return { organizationId: where.organizationId, role: "MEMBER" };
          }
          return { organizationId: "org-primary", role: "MEMBER" };
        }),
      },
    };

    controller = new TransactionConfirmationController(mockService, mockPrisma);
  });

  it("submits confirmation using primary org when header is not provided", async () => {
    const res = await controller.recordSubmission(
      user,
      {
        network: "testnet",
        transactionHash: "a".repeat(64),
        operationType: "ANCHOR",
      },
      undefined,
    );

    expect(res.organizationId).toBe("org-primary");
    expect(mockService.recordSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-primary" }),
    );
  });

  it("submits confirmation using explicit org header if member has access", async () => {
    const res = await controller.recordSubmission(
      user,
      {
        network: "testnet",
        transactionHash: "a".repeat(64),
        operationType: "ANCHOR",
      },
      "org-explicit",
    );

    expect(res.organizationId).toBe("org-explicit");
  });

  it("rejects submission if user is not member of specified organization", async () => {
    await expect(
      controller.recordSubmission(
        user,
        {
          network: "testnet",
          transactionHash: "a".repeat(64),
          operationType: "ANCHOR",
        },
        "org-unauthorized",
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("gets status using resolved tenant", async () => {
    const res = await controller.getStatus(
      user,
      "testnet",
      "a".repeat(64),
      undefined,
    );
    expect(res.organizationId).toBe("org-primary");
    expect(res.status).toBe(TransactionConfirmationStatus.CONFIRMED);
  });
});
