import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PaymentClassification } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PaymentClassificationHistoryService } from './payment-classification-history.service';

describe('PaymentClassificationHistoryService', () => {
  let service: PaymentClassificationHistoryService;
  let prismaService: jest.Mocked<PrismaService>;

  const mockUser = {
    id: 'user-1',
    walletAddress: 'GABC123',
    role: 'WORKER' as const,
    status: 'ACTIVE' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const mockPrisma = {
      payment: {
        findFirst: jest.fn(),
      },
      paymentClassificationHistory: {
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentClassificationHistoryService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<PaymentClassificationHistoryService>(PaymentClassificationHistoryService);
    prismaService = module.get(PrismaService);
  });

  describe('getPaymentHistory', () => {
    it('should return payment history for owner', async () => {
      const paymentId = 'payment-1';
      const mockHistory = [
        {
          id: 'history-1',
          paymentId,
          actorId: mockUser.id,
          previousClassification: PaymentClassification.UNKNOWN,
          newClassification: PaymentClassification.INCOME,
          reasonCode: 'USER_RECLASSIFICATION',
          classificationRevision: 2,
          createdAt: new Date(),
        },
      ];

      prismaService.payment.findFirst.mockResolvedValue({
        id: paymentId,
      } as any);

      prismaService.paymentClassificationHistory.findMany.mockResolvedValue(mockHistory);
      prismaService.paymentClassificationHistory.count.mockResolvedValue(1);

      const result = await service.getPaymentHistory(mockUser, paymentId, {});

      expect(result.items).toHaveLength(1);
      expect(result.items[0].previousClassification).toBe(PaymentClassification.UNKNOWN);
      expect(result.items[0].newClassification).toBe(PaymentClassification.INCOME);
      expect(result.total).toBe(1);
    });

    it('should throw NotFoundException for non-existent payment', async () => {
      const paymentId = 'payment-1';

      prismaService.payment.findFirst.mockResolvedValue(null);

      await expect(
        service.getPaymentHistory(mockUser, paymentId, {}),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException for payment owned by another user', async () => {
      const paymentId = 'payment-1';

      prismaService.payment.findFirst.mockResolvedValue(null);

      await expect(
        service.getPaymentHistory(mockUser, paymentId, {}),
      ).rejects.toThrow(NotFoundException);
    });

    it('should handle pagination correctly', async () => {
      const paymentId = 'payment-1';

      prismaService.payment.findFirst.mockResolvedValue({
        id: paymentId,
      } as any);

      prismaService.paymentClassificationHistory.findMany.mockResolvedValue([]);
      prismaService.paymentClassificationHistory.count.mockResolvedValue(50);

      const result = await service.getPaymentHistory(mockUser, paymentId, {
        page: 2,
        limit: 20,
      });

      expect(prismaService.paymentClassificationHistory.findMany).toHaveBeenCalledWith({
        where: { paymentId },
        skip: 20,
        take: 20,
        orderBy: { createdAt: 'desc' },
      });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(20);
      expect(result.total).toBe(50);
    });
  });

  describe('recordClassificationChange', () => {
    it('should create history record', async () => {
      const paymentId = 'payment-1';
      const actorId = 'user-1';

      await service.recordClassificationChange(
        paymentId,
        actorId,
        PaymentClassification.UNKNOWN,
        PaymentClassification.INCOME,
        'USER_RECLASSIFICATION',
        2,
      );

      expect(prismaService.paymentClassificationHistory.create).toHaveBeenCalledWith({
        data: {
          paymentId,
          actorId,
          previousClassification: PaymentClassification.UNKNOWN,
          newClassification: PaymentClassification.INCOME,
          reasonCode: 'USER_RECLASSIFICATION',
          classificationRevision: 2,
        },
      });
    });
  });
});