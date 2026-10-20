import { Test, TestingModule } from '@nestjs/testing';
import { InvitationDeliverySuppressionService } from './invitation-delivery-suppression.service';
import { PrismaClient, InvitationDeliveryOutcome } from '@prisma/client';
import { createHash } from 'crypto';

describe('InvitationDeliverySuppressionService', () => {
  let service: InvitationDeliverySuppressionService;
  let prisma: PrismaClient;

  const organizationId = 'org_test_123';
  const testEmail = 'test@example.com';
  const organizationSecret = createHash('sha256')
    .update(`ORG_SECRET:${organizationId}`)
    .digest('hex');

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitationDeliverySuppressionService,
        {
          provide: PrismaClient,
          useValue: {
            invitationDeliverySuppression: {
              upsert: jest.fn(),
              delete: jest.fn(),
              findUnique: jest.fn(),
              findMany: jest.fn(),
              groupBy: jest.fn(),
              deleteMany: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<InvitationDeliverySuppressionService>(InvitationDeliverySuppressionService);
    prisma = module.get<PrismaClient>(PrismaClient);
  });

  describe('hashEmail', () => {
    it('should hash email consistently', () => {
      const hash1 = service.hashEmail(testEmail, organizationId, organizationSecret);
      const hash2 = service.hashEmail(testEmail, organizationId, organizationSecret);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });

    it('should normalize email before hashing', () => {
      const hash1 = service.hashEmail(testEmail, organizationId, organizationSecret);
      const hash2 = service.hashEmail('TEST@EXAMPLE.COM', organizationId, organizationSecret);
      const hash3 = service.hashEmail('  test@example.com  ', organizationId, organizationSecret);

      expect(hash1).toBe(hash2);
      expect(hash1).toBe(hash3);
    });

    it('should produce different hashes for different organizations', () => {
      const hash1 = service.hashEmail(testEmail, organizationId, organizationSecret);
      const otherOrgSecret = createHash('sha256')
        .update(`ORG_SECRET:org_other_456`)
        .digest('hex');
      const hash2 = service.hashEmail(testEmail, 'org_other_456', otherOrgSecret);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('addSuppression', () => {
    it('should add a suppression entry', async () => {
      const mockSuppression = {
        id: 'supp_123',
        organizationId,
        recipientEmailHash: 'hash123',
        reason: 'BOUNCED',
        sourceOutcome: InvitationDeliveryOutcome.BOUNCED,
        suppressedAt: new Date(),
        expiresAt: null,
        note: 'Hard bounce',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.invitationDeliverySuppression, 'upsert').mockResolvedValue(mockSuppression);

      const result = await service.addSuppression(
        organizationId,
        testEmail,
        'BOUNCED',
        InvitationDeliveryOutcome.BOUNCED,
        null,
        'Hard bounce',
      );

      expect(result).toEqual(mockSuppression);
      expect(prisma.invitationDeliverySuppression.upsert).toHaveBeenCalled();
    });

    it('should handle temporary suppressions with expiry', async () => {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const mockSuppression = {
        id: 'supp_456',
        organizationId,
        recipientEmailHash: 'hash456',
        reason: 'TEMPORARY_BLOCK',
        sourceOutcome: null,
        suppressedAt: new Date(),
        expiresAt,
        note: 'Temporary block',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.invitationDeliverySuppression, 'upsert').mockResolvedValue(mockSuppression);

      const result = await service.addSuppression(
        organizationId,
        testEmail,
        'TEMPORARY_BLOCK',
        null,
        expiresAt,
        'Temporary block',
      );

      expect(result.expiresAt).toEqual(expiresAt);
    });

    it('should be idempotent', async () => {
      const mockSuppression = {
        id: 'supp_789',
        organizationId,
        recipientEmailHash: 'hash789',
        reason: 'COMPLAINT',
        sourceOutcome: InvitationDeliveryOutcome.COMPLAINT,
        suppressedAt: new Date(),
        expiresAt: null,
        note: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.invitationDeliverySuppression, 'upsert').mockResolvedValue(mockSuppression);

      const result1 = await service.addSuppression(
        organizationId,
        testEmail,
        'COMPLAINT',
        InvitationDeliveryOutcome.COMPLAINT,
      );

      const result2 = await service.addSuppression(
        organizationId,
        testEmail,
        'COMPLAINT',
        InvitationDeliveryOutcome.COMPLAINT,
      );

      expect(result1).toEqual(result2);
      expect(prisma.invitationDeliverySuppression.upsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('removeSuppression', () => {
    it('should remove a suppression entry', async () => {
      const mockSuppression = {
        id: 'supp_123',
        organizationId,
        recipientEmailHash: 'hash123',
        reason: 'BOUNCED',
        sourceOutcome: InvitationDeliveryOutcome.BOUNCED,
        suppressedAt: new Date(),
        expiresAt: null,
        note: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.invitationDeliverySuppression, 'delete').mockResolvedValue(mockSuppression);

      const result = await service.removeSuppression(organizationId, testEmail);

      expect(result).toEqual(mockSuppression);
      expect(prisma.invitationDeliverySuppression.delete).toHaveBeenCalled();
    });

    it('should return null if suppression not found', async () => {
      const error = new Error('Not found');
      (error as any).code = 'P2025';

      jest.spyOn(prisma.invitationDeliverySuppression, 'delete').mockRejectedValue(error);

      const result = await service.removeSuppression(organizationId, testEmail);

      expect(result).toBeNull();
    });
  });

  describe('isSuppressed', () => {
    it('should return suppression if recipient is suppressed', async () => {
      const mockSuppression = {
        id: 'supp_123',
        organizationId,
        recipientEmailHash: 'hash123',
        reason: 'BOUNCED',
        sourceOutcome: InvitationDeliveryOutcome.BOUNCED,
        suppressedAt: new Date(),
        expiresAt: null,
        note: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.invitationDeliverySuppression, 'findUnique').mockResolvedValue(mockSuppression);

      const result = await service.isSuppressed(organizationId, testEmail);

      expect(result).toEqual(mockSuppression);
    });

    it('should return null if recipient is not suppressed', async () => {
      jest.spyOn(prisma.invitationDeliverySuppression, 'findUnique').mockResolvedValue(null);

      const result = await service.isSuppressed(organizationId, testEmail);

      expect(result).toBeNull();
    });

    it('should return null if suppression has expired', async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      const expiredSuppression = {
        id: 'supp_123',
        organizationId,
        recipientEmailHash: 'hash123',
        reason: 'TEMPORARY_BLOCK',
        sourceOutcome: null,
        suppressedAt: new Date(),
        expiresAt: pastDate,
        note: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.invitationDeliverySuppression, 'findUnique').mockResolvedValue(expiredSuppression);

      const result = await service.isSuppressed(organizationId, testEmail);

      expect(result).toBeNull();
    });
  });

  describe('getSuppressionStats', () => {
    it('should return suppression statistics', async () => {
      const mockStats = [
        { reason: 'BOUNCED', _count: 25 },
        { reason: 'COMPLAINT', _count: 5 },
      ];

      jest.spyOn(prisma.invitationDeliverySuppression, 'groupBy').mockResolvedValue(mockStats);

      const result = await service.getSuppressionStats(organizationId);

      expect(result.organizationId).toBe(organizationId);
      expect(result.totalActive).toBe(30);
      expect(result.byReason.BOUNCED).toBe(25);
      expect(result.byReason.COMPLAINT).toBe(5);
    });
  });

  describe('cleanupExpiredSuppressions', () => {
    it('should delete expired suppressions', async () => {
      jest.spyOn(prisma.invitationDeliverySuppression, 'deleteMany').mockResolvedValue({ count: 42 });

      const result = await service.cleanupExpiredSuppressions(organizationId);

      expect(result).toBe(42);
    });

    it('should work without organization filter', async () => {
      jest.spyOn(prisma.invitationDeliverySuppression, 'deleteMany').mockResolvedValue({ count: 100 });

      const result = await service.cleanupExpiredSuppressions();

      expect(result).toBe(100);
    });
  });
});
