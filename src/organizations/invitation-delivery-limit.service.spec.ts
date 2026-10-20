import { Test, TestingModule } from '@nestjs/testing';
import { InvitationDeliveryLimitService } from './invitation-delivery-limit.service';
import { PrismaClient } from '@prisma/client';

describe('InvitationDeliveryLimitService', () => {
  let service: InvitationDeliveryLimitService;
  let prisma: PrismaClient;

  const organizationId = 'org_test_123';
  const testEmail = 'test@example.com';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitationDeliveryLimitService,
        {
          provide: PrismaClient,
          useValue: {
            invitationResendCooldown: {
              findUnique: jest.fn(),
              upsert: jest.fn(),
              delete: jest.fn(),
              count: jest.fn(),
            },
            invitationResendAttemptWindow: {
              findUnique: jest.fn(),
              upsert: jest.fn(),
              delete: jest.fn(),
            },
            invitationDeliveryQuota: {
              findUnique: jest.fn(),
              upsert: jest.fn(),
            },
            invitationDeliveryOverride: {
              findFirst: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<InvitationDeliveryLimitService>(InvitationDeliveryLimitService);
    prisma = module.get<PrismaClient>(PrismaClient);
  });

  describe('checkLimits', () => {
    it('should allow delivery when all limits are OK', async () => {
      jest.spyOn(prisma.invitationResendCooldown, 'findUnique').mockResolvedValue(null);
      jest.spyOn(prisma.invitationResendAttemptWindow, 'findUnique').mockResolvedValue(null);
      jest.spyOn(prisma.invitationDeliveryQuota, 'findUnique').mockResolvedValue({
        organizationId,
        windowStart: new Date(),
        count: 100,
        limit: 10000,
        updatedAt: new Date(),
      });

      const result = await service.checkLimits(organizationId, testEmail);

      expect(result.resendCooldownOk).toBe(true);
      expect(result.hourlyLimitOk).toBe(true);
      expect(result.dailyQuotaOk).toBe(true);
    });

    it('should block delivery when in resend cooldown', async () => {
      const futureDate = new Date();
      futureDate.setHours(futureDate.getHours() + 1);

      jest.spyOn(prisma.invitationResendCooldown, 'findUnique').mockResolvedValue({
        id: 'cooldown_1',
        organizationId,
        recipientEmailHash: 'hash123',
        lastSentAt: new Date(),
        availableAt: futureDate,
        reason: 'DELIVERY_RECORDED',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.checkLimits(organizationId, testEmail, false);

      expect(result.resendCooldownOk).toBe(false);
      expect(result.resendCooldownReason).toContain('cooldown until');
    });

    it('should block delivery when hourly limit exceeded', async () => {
      jest.spyOn(prisma.invitationResendCooldown, 'findUnique').mockResolvedValue(null);
      jest.spyOn(prisma.invitationResendAttemptWindow, 'findUnique').mockResolvedValue({
        id: 'window_1',
        organizationId,
        recipientEmailHash: 'hash123',
        windowStart: new Date(),
        attemptCount: 3, // At limit
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.checkLimits(organizationId, testEmail, false);

      expect(result.hourlyLimitOk).toBe(false);
      expect(result.hourlyLimitReason).toContain('Reached hourly limit');
    });

    it('should block delivery when daily quota exceeded', async () => {
      jest.spyOn(prisma.invitationResendCooldown, 'findUnique').mockResolvedValue(null);
      jest.spyOn(prisma.invitationResendAttemptWindow, 'findUnique').mockResolvedValue(null);
      jest.spyOn(prisma.invitationDeliveryQuota, 'findUnique').mockResolvedValue({
        organizationId,
        windowStart: new Date(),
        count: 10000,
        limit: 10000, // At limit
        updatedAt: new Date(),
      });

      const result = await service.checkLimits(organizationId, testEmail, false);

      expect(result.dailyQuotaOk).toBe(false);
      expect(result.dailyQuotaReason).toContain('reached daily quota');
    });

    it('should allow delivery with active override', async () => {
      const futureDate = new Date();
      futureDate.setHours(futureDate.getHours() + 1);

      jest.spyOn(prisma.invitationResendCooldown, 'findUnique').mockResolvedValue({
        id: 'cooldown_1',
        organizationId,
        recipientEmailHash: 'hash123',
        lastSentAt: new Date(),
        availableAt: futureDate,
        reason: 'DELIVERY_RECORDED',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      jest.spyOn(prisma.invitationDeliveryOverride, 'findFirst').mockResolvedValue({
        id: 'override_1',
        organizationId,
        recipientEmailHash: 'hash123',
        overrideType: 'COOLDOWN',
        reason: 'CUSTOMER_REQUEST',
        authorizedById: 'user_123',
        authorizedAt: new Date(),
        assertionTokenHash: 'hash_abc',
        description: 'Customer request',
        expiresAt: null,
        revokedAt: null,
        revokedById: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.checkLimits(organizationId, testEmail, true);

      expect(result.resendCooldownOk).toBe(true);
      expect(result.overrideActive).toBe(true);
    });
  });

  describe('recordDeliveryAttempt', () => {
    it('should update cooldown and attempt window', async () => {
      jest.spyOn(prisma.invitationResendCooldown, 'upsert').mockResolvedValue({
        id: 'cooldown_1',
        organizationId,
        recipientEmailHash: 'hash123',
        lastSentAt: new Date(),
        availableAt: new Date(),
        reason: 'DELIVERY_RECORDED',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      jest.spyOn(prisma.invitationResendAttemptWindow, 'upsert').mockResolvedValue({
        id: 'window_1',
        organizationId,
        recipientEmailHash: 'hash123',
        windowStart: new Date(),
        attemptCount: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      jest.spyOn(prisma.invitationDeliveryQuota, 'upsert').mockResolvedValue({
        organizationId,
        windowStart: new Date(),
        count: 1,
        limit: 10000,
        updatedAt: new Date(),
      });

      await service.recordDeliveryAttempt(organizationId, testEmail);

      expect(prisma.invitationResendCooldown.upsert).toHaveBeenCalled();
      expect(prisma.invitationResendAttemptWindow.upsert).toHaveBeenCalled();
      expect(prisma.invitationDeliveryQuota.upsert).toHaveBeenCalled();
    });
  });

  describe('resetRecipientLimits', () => {
    it('should delete cooldown and hourly window', async () => {
      jest.spyOn(prisma.invitationResendCooldown, 'delete').mockResolvedValue({
        id: 'cooldown_1',
        organizationId,
        recipientEmailHash: 'hash123',
        lastSentAt: new Date(),
        availableAt: new Date(),
        reason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      jest.spyOn(prisma.invitationResendAttemptWindow, 'delete').mockResolvedValue({
        id: 'window_1',
        organizationId,
        recipientEmailHash: 'hash123',
        windowStart: new Date(),
        attemptCount: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await service.resetRecipientLimits(organizationId, testEmail);

      expect(prisma.invitationResendCooldown.delete).toHaveBeenCalled();
      expect(prisma.invitationResendAttemptWindow.delete).toHaveBeenCalled();
    });
  });

  describe('getOrganizationLimitStats', () => {
    it('should return organization limit statistics', async () => {
      jest.spyOn(prisma.invitationDeliveryQuota, 'findUnique').mockResolvedValue({
        organizationId,
        windowStart: new Date(),
        count: 500,
        limit: 10000,
        updatedAt: new Date(),
      });

      jest.spyOn(prisma.invitationResendCooldown, 'count').mockResolvedValue(15);

      const result = await service.getOrganizationLimitStats(organizationId);

      expect(result.organizationId).toBe(organizationId);
      expect(result.dailyQuota.count).toBe(500);
      expect(result.dailyQuota.limit).toBe(10000);
      expect(result.recipientsInCooldown).toBe(15);
    });
  });
});
