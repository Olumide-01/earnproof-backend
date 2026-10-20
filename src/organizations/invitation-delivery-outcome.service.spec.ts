import { Test, TestingModule } from '@nestjs/testing';
import { InvitationDeliveryOutcomeService } from './invitation-delivery-outcome.service';
import { PrismaClient, InvitationDeliveryOutcome } from '@prisma/client';

describe('InvitationDeliveryOutcomeService', () => {
  let service: InvitationDeliveryOutcomeService;
  let prisma: PrismaClient;

  const organizationId = 'org_test_123';
  const testEmail = 'test@example.com';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitationDeliveryOutcomeService,
        {
          provide: PrismaClient,
          useValue: {
            invitationDeliveryOutcomeRecord: {
              create: jest.fn(),
              groupBy: jest.fn(),
              findMany: jest.fn(),
              deleteMany: jest.fn(),
            },
            invitationDeliverySuppression: {
              upsert: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<InvitationDeliveryOutcomeService>(InvitationDeliveryOutcomeService);
    prisma = module.get<PrismaClient>(PrismaClient);
  });

  describe('recordOutcome', () => {
    it('should record a successful delivery outcome', async () => {
      const mockOutcome = {
        id: 'outcome_1',
        organizationId,
        recipientEmailHash: 'hash123',
        outcome: InvitationDeliveryOutcome.SENT,
        statusCode: 200,
        failureReason: null,
        attemptCount: 1,
        attemptedAt: new Date(),
        expiresAt: new Date(),
      };

      jest.spyOn(prisma.invitationDeliveryOutcomeRecord, 'create').mockResolvedValue(mockOutcome);

      const result = await service.recordOutcome(
        organizationId,
        testEmail,
        InvitationDeliveryOutcome.SENT,
        200,
      );

      expect(result).toEqual(mockOutcome);
      expect(prisma.invitationDeliveryOutcomeRecord.create).toHaveBeenCalled();
    });

    it('should auto-suppress on BOUNCED outcome', async () => {
      const mockOutcome = {
        id: 'outcome_2',
        organizationId,
        recipientEmailHash: 'hash123',
        outcome: InvitationDeliveryOutcome.BOUNCED,
        statusCode: 550,
        failureReason: 'Hard bounce',
        attemptCount: 1,
        attemptedAt: new Date(),
        expiresAt: new Date(),
      };

      jest.spyOn(prisma.invitationDeliveryOutcomeRecord, 'create').mockResolvedValue(mockOutcome);
      jest.spyOn(prisma.invitationDeliverySuppression, 'upsert').mockResolvedValue({
        id: 'supp_1',
        organizationId,
        recipientEmailHash: 'hash123',
        reason: 'BOUNCED',
        sourceOutcome: InvitationDeliveryOutcome.BOUNCED,
        suppressedAt: new Date(),
        expiresAt: null,
        note: 'Auto-suppressed due to BOUNCED',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.recordOutcome(
        organizationId,
        testEmail,
        InvitationDeliveryOutcome.BOUNCED,
        550,
        'Hard bounce',
      );

      expect(result.outcome).toBe(InvitationDeliveryOutcome.BOUNCED);
      expect(prisma.invitationDeliverySuppression.upsert).toHaveBeenCalled();
    });

    it('should auto-suppress on COMPLAINT outcome', async () => {
      const mockOutcome = {
        id: 'outcome_3',
        organizationId,
        recipientEmailHash: 'hash123',
        outcome: InvitationDeliveryOutcome.COMPLAINT,
        statusCode: null,
        failureReason: null,
        attemptCount: 1,
        attemptedAt: new Date(),
        expiresAt: new Date(),
      };

      jest.spyOn(prisma.invitationDeliveryOutcomeRecord, 'create').mockResolvedValue(mockOutcome);
      jest.spyOn(prisma.invitationDeliverySuppression, 'upsert').mockResolvedValue({
        id: 'supp_2',
        organizationId,
        recipientEmailHash: 'hash123',
        reason: 'COMPLAINT',
        sourceOutcome: InvitationDeliveryOutcome.COMPLAINT,
        suppressedAt: new Date(),
        expiresAt: null,
        note: 'Auto-suppressed due to COMPLAINT',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await service.recordOutcome(
        organizationId,
        testEmail,
        InvitationDeliveryOutcome.COMPLAINT,
      );

      expect(prisma.invitationDeliverySuppression.upsert).toHaveBeenCalled();
    });

    it('should not auto-suppress on SENT outcome', async () => {
      const mockOutcome = {
        id: 'outcome_4',
        organizationId,
        recipientEmailHash: 'hash123',
        outcome: InvitationDeliveryOutcome.SENT,
        statusCode: 200,
        failureReason: null,
        attemptCount: 1,
        attemptedAt: new Date(),
        expiresAt: new Date(),
      };

      jest.spyOn(prisma.invitationDeliveryOutcomeRecord, 'create').mockResolvedValue(mockOutcome);

      await service.recordOutcome(
        organizationId,
        testEmail,
        InvitationDeliveryOutcome.SENT,
      );

      expect(prisma.invitationDeliverySuppression.upsert).not.toHaveBeenCalled();
    });
  });

  describe('getOutcomeStats', () => {
    it('should return outcome statistics with bounce and complaint rates', async () => {
      const mockStats = [
        { outcome: InvitationDeliveryOutcome.SENT, _count: 900 },
        { outcome: InvitationDeliveryOutcome.BOUNCED, _count: 80 },
        { outcome: InvitationDeliveryOutcome.COMPLAINT, _count: 5 },
        { outcome: InvitationDeliveryOutcome.FAILED, _count: 15 },
      ];

      jest.spyOn(prisma.invitationDeliveryOutcomeRecord, 'groupBy').mockResolvedValue(mockStats);

      const result = await service.getOutcomeStats(organizationId, 24);

      expect(result.organizationId).toBe(organizationId);
      expect(result.total).toBe(1000);
      expect(result.bounceRate).toBe(8); // 80/1000
      expect(result.complaintRate).toBe(0.5); // 5/1000
      expect(result.failureRate).toBe(1.5); // 15/1000
    });

    it('should detect high bounce rate', async () => {
      const mockStats = [
        { outcome: InvitationDeliveryOutcome.SENT, _count: 850 },
        { outcome: InvitationDeliveryOutcome.BOUNCED, _count: 150 }, // 15% bounce rate
      ];

      jest.spyOn(prisma.invitationDeliveryOutcomeRecord, 'groupBy').mockResolvedValue(mockStats);

      const result = await service.detectAbusePatterns(organizationId);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('High bounce rate');
    });
  });

  describe('getRecentOutcomes', () => {
    it('should return recent outcomes for a recipient', async () => {
      const mockOutcomes = [
        {
          id: 'outcome_1',
          organizationId,
          recipientEmailHash: 'hash123',
          outcome: InvitationDeliveryOutcome.BOUNCED,
          statusCode: 550,
          failureReason: 'Hard bounce',
          attemptCount: 1,
          attemptedAt: new Date(),
          expiresAt: new Date(),
        },
        {
          id: 'outcome_2',
          organizationId,
          recipientEmailHash: 'hash123',
          outcome: InvitationDeliveryOutcome.SENT,
          statusCode: 200,
          failureReason: null,
          attemptCount: 1,
          attemptedAt: new Date(),
          expiresAt: new Date(),
        },
      ];

      jest.spyOn(prisma.invitationDeliveryOutcomeRecord, 'findMany').mockResolvedValue(mockOutcomes);

      const result = await service.getRecentOutcomes(organizationId, testEmail, 10);

      expect(result).toEqual(mockOutcomes);
      expect(result.length).toBe(2);
    });
  });

  describe('cleanupExpiredOutcomes', () => {
    it('should delete expired outcomes', async () => {
      jest.spyOn(prisma.invitationDeliveryOutcomeRecord, 'deleteMany').mockResolvedValue({ count: 1000 });

      const result = await service.cleanupExpiredOutcomes(organizationId);

      expect(result).toBe(1000);
    });
  });

  describe('detectAbusePatterns', () => {
    it('should return no warnings for healthy delivery', async () => {
      const mockStats = [
        { outcome: InvitationDeliveryOutcome.SENT, _count: 980 },
        { outcome: InvitationDeliveryOutcome.FAILED, _count: 20 },
      ];

      jest.spyOn(prisma.invitationDeliveryOutcomeRecord, 'groupBy').mockResolvedValue(mockStats);

      const result = await service.detectAbusePatterns(organizationId);

      expect(result.warnings.length).toBe(0);
    });

    it('should warn on complaint rate > 0.1%', async () => {
      const mockStats = [
        { outcome: InvitationDeliveryOutcome.SENT, _count: 900 },
        { outcome: InvitationDeliveryOutcome.COMPLAINT, _count: 2 }, // 0.2%
      ];

      jest.spyOn(prisma.invitationDeliveryOutcomeRecord, 'groupBy').mockResolvedValue(mockStats);

      const result = await service.detectAbusePatterns(organizationId);

      expect(result.warnings.some(w => w.includes('Complaint rate'))).toBe(true);
    });
  });
});
