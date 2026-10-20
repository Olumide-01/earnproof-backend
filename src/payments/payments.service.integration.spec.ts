import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PaymentClassification } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { PaymentsService } from './payments.service';
import { PaymentClassificationHistoryService } from './payment-classification-history.service';

describe('PaymentsService - Classification Integration', () => {
  let service: PaymentsService;
  let prismaService: jest.Mocked<PrismaService>;
  let historyService: jest.Mocked<PaymentClassificationHistoryService>;

  const mockUser = { id: 'user-1' };

  beforeEach(async () => {
    const mockPrisma = {
      payment: {
        findFirst: jest.fn(),
        update: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
      },
      paymentClassificationHistory: {
        create: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: StellarService,
          useValue: {},
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().returns('test'),
          },
        },
        {
          provide: PaymentClassificationHistoryService,
          useValue: {
            recordClassificationChange: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
    prismaService = module.get(PrismaService);
    historyService = module.get(PaymentClassificationHistoryService);
  });

  describe('updateClassification', () => {
    it('should update classification and create history atomically', async () => {
      const paymentId = 'payment-1';
      const oldClassification = PaymentClassification.UNKNOWN;
      const newClassification = PaymentClassification.INCOME;

      const mockPayment = {
        id: paymentId,
        classification: oldClassification,
        classificationRevision: 1,
        assetCode: 'USDC',
        assetIssuer: null,
        isEligible: true,
      };

      const mockUpdatedPayment = {
        ...mockPayment,
        classification: newClassification,
        classificationRevision: 2,
        occurredAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        memo: null,
      };

      prismaService.payment.findFirst.mockResolvedValue(mockPayment as any);

      // Mock transaction to simulate atomic update
      prismaService.$transaction.mockImplementation(async (callback) => {
        const txMock = {
          payment: {
            update: jest.fn().mockResolvedValue(mockUpdatedPayment),
          },
          paymentClassificationHistory: {
            create: jest.fn(),
          },
        };
        return callback(txMock);
      });

      prismaService.auditLog.create.mockResolvedValue({} as any);

      const result = await service.updateClassification(
        mockUser,
        paymentId,
        newClassification,
        'USER_RECLASSIFICATION',
      );

      expect(prismaService.$transaction).toHaveBeenCalled();
      expect(result.classification).toBe(newClassification);
      expect(result.classificationRevision).toBe(2);
    });

    it('should handle no-op classification changes', async () => {
      const paymentId = 'payment-1';
      const classification = PaymentClassification.INCOME;

      const mockPayment = {
        id: paymentId,
        classification,
        classificationRevision: 1,
        occurredAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        memo: null,
      };

      prismaService.payment.findFirst.mockResolvedValue(mockPayment as any);
      prismaService.payment.findUniqueOrThrow.mockResolvedValue(mockPayment as any);

      const result = await service.updateClassification(
        mockUser,
        paymentId,
        classification,
        'USER_RECLASSIFICATION',
      );

      // Should not call transaction for no-op
      expect(prismaService.$transaction).not.toHaveBeenCalled();
      expect(result.classification).toBe(classification);
    });

    it('should throw NotFoundException for non-existent payment', async () => {
      const paymentId = 'payment-1';

      prismaService.payment.findFirst.mockResolvedValue(null);

      await expect(
        service.updateClassification(
          mockUser,
          paymentId,
          PaymentClassification.INCOME,
          'USER_RECLASSIFICATION',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should handle transaction rollback on history failure', async () => {
      const paymentId = 'payment-1';

      const mockPayment = {
        id: paymentId,
        classification: PaymentClassification.UNKNOWN,
        classificationRevision: 1,
      };

      prismaService.payment.findFirst.mockResolvedValue(mockPayment as any);

      // Mock transaction failure
      prismaService.$transaction.mockRejectedValue(new Error('History creation failed'));

      await expect(
        service.updateClassification(
          mockUser,
          paymentId,
          PaymentClassification.INCOME,
          'USER_RECLASSIFICATION',
        ),
      ).rejects.toThrow('History creation failed');

      // Ensure audit log is not created when transaction fails
      expect(prismaService.auditLog.create).not.toHaveBeenCalled();
    });
  });
});