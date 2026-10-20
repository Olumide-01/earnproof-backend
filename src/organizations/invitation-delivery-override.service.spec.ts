import { Test, TestingModule } from '@nestjs/testing';
import { InvitationDeliveryOverrideService } from './invitation-delivery-override.service';
import { PrismaClient, InvitationOverrideReason } from '@prisma/client';
import { ForbiddenException, BadRequestException } from '@nestjs/common';

describe('InvitationDeliveryOverrideService', () => {
  let service: InvitationDeliveryOverrideService;
  let prisma: PrismaClient;

  const organizationId = 'org_test_123';
  const testEmail = 'test@example.com';
  const authorizedById = 'user_admin_123';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitationDeliveryOverrideService,
        {
          provide: PrismaClient,
          useValue: {
            invitationDeliveryOverride: {
              findFirst: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
              findMany: jest.fn(),
              groupBy: jest.fn(),
              count: jest.fn(),
              deleteMany: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<InvitationDeliveryOverrideService>(InvitationDeliveryOverrideService);
    prisma = module.get<PrismaClient>(PrismaClient);
  });

  describe('createOverride', () => {
    it('should create a new override with recent authorization', async () => {
      const recentAuth = new Date();
      recentAuth.setMinutes(recentAuth.getMinutes() - 30); // 30 minutes ago

      const mockOverride = {
        id: 'override_1',
        organizationId,
        recipientEmailHash: 'hash123',
        overrideType: 'COOLDOWN',
        reason: InvitationOverrideReason.CUSTOMER_REQUEST,
        authorizedById,
        authorizedAt: recentAuth,
        assertionTokenHash: 'assertion_hash',
        description: 'Customer requested override',
        expiresAt: null,
        revokedAt: null,
        revokedById: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.invitationDeliveryOverride, 'findFirst').mockResolvedValue(null);
      jest.spyOn(prisma.invitationDeliveryOverride, 'create').mockResolvedValue(mockOverride);

      const result = await service.createOverride(
        organizationId,
        testEmail,
        'COOLDOWN',
        InvitationOverrideReason.CUSTOMER_REQUEST,
        authorizedById,
        recentAuth,
        'assertion_hash',
        'Customer requested override',
      );

      expect(result).toEqual(mockOverride);
      expect(prisma.invitationDeliveryOverride.create).toHaveBeenCalled();
    });

    it('should reject stale authorization', async () => {
      const staleAuth = new Date();
      staleAuth.setHours(staleAuth.getHours() - 2); // 2 hours ago

      await expect(
        service.createOverride(
          organizationId,
          testEmail,
          'COOLDOWN',
          InvitationOverrideReason.CUSTOMER_REQUEST,
          authorizedById,
          staleAuth,
          'assertion_hash',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return existing active override (idempotent)', async () => {
      const recentAuth = new Date();
      recentAuth.setMinutes(recentAuth.getMinutes() - 30);

      const existingOverride = {
        id: 'override_existing',
        organizationId,
        recipientEmailHash: 'hash123',
        overrideType: 'COOLDOWN',
        reason: InvitationOverrideReason.CUSTOMER_REQUEST,
        authorizedById,
        authorizedAt: recentAuth,
        assertionTokenHash: 'assertion_hash',
        description: 'Existing override',
        expiresAt: null,
        revokedAt: null,
        revokedById: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.invitationDeliveryOverride, 'findFirst').mockResolvedValue(existingOverride);

      const result = await service.createOverride(
        organizationId,
        testEmail,
        'COOLDOWN',
        InvitationOverrideReason.CUSTOMER_REQUEST,
        authorizedById,
        recentAuth,
        'assertion_hash',
      );

      expect(result).toEqual(existingOverride);
      expect(prisma.invitationDeliveryOverride.create).not.toHaveBeenCalled();
    });

    it('should support temporary overrides with expiry', async () => {
      const recentAuth = new Date();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const mockOverride = {
        id: 'override_temp',
        organizationId,
        recipientEmailHash: 'hash123',
        overrideType: 'SUPPRESSION',
        reason: InvitationOverrideReason.COMPLIANCE_REVIEW,
        authorizedById,
        authorizedAt: recentAuth,
        assertionTokenHash: 'assertion_hash',
        description: 'Temporary compliance review override',
        expiresAt,
        revokedAt: null,
        revokedById: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.invitationDeliveryOverride, 'findFirst').mockResolvedValue(null);
      jest.spyOn(prisma.invitationDeliveryOverride, 'create').mockResolvedValue(mockOverride);

      const result = await service.createOverride(
        organizationId,
        testEmail,
        'SUPPRESSION',
        InvitationOverrideReason.COMPLIANCE_REVIEW,
        authorizedById,
        recentAuth,
        'assertion_hash',
        'Temporary compliance review override',
        expiresAt,
      );

      expect(result.expiresAt).toEqual(expiresAt);
    });
  });

  describe('revokeOverride', () => {
    it('should revoke an active override', async () => {
      const mockOverride = {
        id: 'override_1',
        organizationId,
        recipientEmailHash: 'hash123',
        overrideType: 'COOLDOWN',
        reason: InvitationOverrideReason.CUSTOMER_REQUEST,
        authorizedById,
        authorizedAt: new Date(),
        assertionTokenHash: 'assertion_hash',
        description: null,
        expiresAt: null,
        revokedAt: new Date(),
        revokedById: 'user_admin_456',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.invitationDeliveryOverride, 'update').mockResolvedValue(mockOverride);

      const result = await service.revokeOverride(organizationId, 'override_1', 'user_admin_456');

      expect(result.revokedAt).toBeDefined();
      expect(result.revokedById).toBe('user_admin_456');
    });

    it('should reject revoke for override from different organization', async () => {
      const mockOverride = {
        id: 'override_1',
        organizationId: 'org_other',
        recipientEmailHash: 'hash123',
        overrideType: 'COOLDOWN',
        reason: InvitationOverrideReason.CUSTOMER_REQUEST,
        authorizedById,
        authorizedAt: new Date(),
        assertionTokenHash: 'assertion_hash',
        description: null,
        expiresAt: null,
        revokedAt: new Date(),
        revokedById: 'user_admin_456',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.invitationDeliveryOverride, 'update').mockResolvedValue(mockOverride);

      await expect(
        service.revokeOverride(organizationId, 'override_1', 'user_admin_456'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException if override not found', async () => {
      const error = new Error('Not found');
      (error as any).code = 'P2025';

      jest.spyOn(prisma.invitationDeliveryOverride, 'update').mockRejectedValue(error);

      await expect(
        service.revokeOverride(organizationId, 'override_nonexistent', 'user_admin_456'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getActiveOverrides', () => {
    it('should return active overrides for a recipient', async () => {
      const mockOverrides = [
        {
          id: 'override_1',
          organizationId,
          recipientEmailHash: 'hash123',
          overrideType: 'COOLDOWN',
          reason: InvitationOverrideReason.CUSTOMER_REQUEST,
          authorizedById,
          authorizedAt: new Date(),
          assertionTokenHash: 'assertion_hash',
          description: null,
          expiresAt: null,
          revokedAt: null,
          revokedById: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      jest.spyOn(prisma.invitationDeliveryOverride, 'findMany').mockResolvedValue(mockOverrides);

      const result = await service.getActiveOverrides(organizationId, testEmail);

      expect(result).toEqual(mockOverrides);
      expect(result.length).toBe(1);
    });

    it('should exclude revoked overrides', async () => {
      jest.spyOn(prisma.invitationDeliveryOverride, 'findMany').mockResolvedValue([]);

      const result = await service.getActiveOverrides(organizationId, testEmail);

      expect(result).toEqual([]);
    });

    it('should exclude expired overrides', async () => {
      jest.spyOn(prisma.invitationDeliveryOverride, 'findMany').mockResolvedValue([]);

      const result = await service.getActiveOverrides(organizationId, testEmail);

      expect(result).toEqual([]);
    });
  });

  describe('getOverrideStats', () => {
    it('should return override statistics', async () => {
      const mockByType = [
        { overrideType: 'COOLDOWN', _count: 10 },
        { overrideType: 'RATE_LIMIT', _count: 5 },
      ];

      const mockByReason = [
        { reason: InvitationOverrideReason.CUSTOMER_REQUEST, _count: 12 },
        { reason: InvitationOverrideReason.COMPLIANCE_REVIEW, _count: 3 },
      ];

      jest
        .spyOn(prisma.invitationDeliveryOverride, 'groupBy')
        .mockResolvedValueOnce(mockByType)
        .mockResolvedValueOnce(mockByReason);

      jest.spyOn(prisma.invitationDeliveryOverride, 'count').mockResolvedValueOnce(8).mockResolvedValueOnce(2);

      const result = await service.getOverrideStats(organizationId);

      expect(result.organizationId).toBe(organizationId);
      expect(result.totalActive).toBe(15);
      expect(result.createdLast7Days).toBe(8);
      expect(result.revokedTotal).toBe(2);
    });
  });

  describe('getRecentCreators', () => {
    it('should return recent override creators with counts', async () => {
      const mockCreators = [
        { authorizedById: 'user_admin_1', _count: 25 },
        { authorizedById: 'user_admin_2', _count: 10 },
      ];

      jest.spyOn(prisma.invitationDeliveryOverride, 'groupBy').mockResolvedValue(mockCreators);

      const result = await service.getRecentCreators(organizationId, 7);

      expect(result.length).toBe(2);
      expect(result[0].authorizedById).toBe('user_admin_1');
      expect(result[0].overrideCount).toBe(25);
    });
  });

  describe('cleanupExpiredOverrides', () => {
    it('should delete expired overrides', async () => {
      jest.spyOn(prisma.invitationDeliveryOverride, 'deleteMany').mockResolvedValue({ count: 42 });

      const result = await service.cleanupExpiredOverrides(organizationId);

      expect(result).toBe(42);
    });
  });
});
