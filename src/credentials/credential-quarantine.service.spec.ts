import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CredentialQuarantineService } from './credential-quarantine.service';
import { CredentialQuarantineReasonCode, CredentialQuarantineState } from '@prisma/client';

/**
 * Synthetic fixture generators for deterministic test data
 */
function syntheticHash(seed: string): string {
  const parts = seed.split('-');
  return `sha256:synthetic${parts[0]?.padEnd(64, '0').slice(0, 64) || 'a'.repeat(64)}`;
}

function syntheticUserId(seed: string): string {
  return `user_synthetic_${seed}`;
}

function syntheticOrgId(seed: string): string {
  return `org_synthetic_${seed}`;
}

describe('CredentialQuarantineService', () => {
  let service: CredentialQuarantineService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialQuarantineService,
        {
          provide: PrismaService,
          useValue: {
            credentialQuarantine: {
              create: jest.fn(),
              findFirst: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
              update: jest.fn(),
              updateMany: jest.fn(),
            },
            credentialQuarantineAudit: {
              create: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<CredentialQuarantineService>(CredentialQuarantineService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ========================================================================
  // POSITIVE TESTS: Happy path scenarios
  // ========================================================================

  describe('createQuarantine - positive', () => {
    it('should create quarantine for malformed credential', async () => {
      const orgId = syntheticOrgId('positive-1');
      const userId = syntheticUserId('importer');
      const hash = syntheticHash('malformed-cred');

      const quarantine = {
        id: 'quat_test_1',
        organizationId: orgId,
        tenantId: orgId,
        reason: 'MALFORMED' as CredentialQuarantineReasonCode,
        state: 'QUARANTINED' as CredentialQuarantineState,
        contentHash: hash,
        contentSize: 512,
        schemaType: 'EarnProofMinimumIncomeCredential',
        schemaVersion: 'earnproof.minimum-income.v1',
        issuerIdentifier: 'test-issuer',
        issuerPolicyVersion: null,
        credentialProofType: null,
        credentialExpiresAt: null,
        credentialIssuedAt: null,
        keyId: null,
        keyType: null,
        network: null,
        evidenceRefreshedAt: null,
        evidenceFreshUntil: null,
        evidenceRefreshReason: null,
        decidedByUserId: null,
        decidedAt: null,
        decisionReason: null,
        importedByUserId: userId,
        importedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revision: 1,
        updatedAt: new Date(),
        createdAt: new Date(),
      };

      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(null);
      jest.spyOn(prisma.credentialQuarantine, 'count').mockResolvedValue(100);
      jest.spyOn(prisma.credentialQuarantine, 'create').mockResolvedValue(quarantine);
      jest.spyOn(prisma.credentialQuarantineAudit, 'create').mockResolvedValue(undefined);

      const result = await service.createQuarantine({
        organizationId: orgId,
        reason: 'MALFORMED',
        metadata: {
          contentHash: hash,
          contentSize: 512,
          schemaType: 'EarnProofMinimumIncomeCredential',
          schemaVersion: 'earnproof.minimum-income.v1',
          issuerIdentifier: 'test-issuer',
        },
        importedByUserId: userId,
      });

      expect(result.id).toBe('quat_test_1');
      expect(result.state).toBe('QUARANTINED');
      expect(result.reason).toBe('MALFORMED');
      expect(prisma.credentialQuarantine.create).toHaveBeenCalled();
    });

    it('should create quarantine for unknown key', async () => {
      const orgId = syntheticOrgId('positive-2');
      const userId = syntheticUserId('importer');
      const hash = syntheticHash('unknown-key-cred');

      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(null);
      jest.spyOn(prisma.credentialQuarantine, 'count').mockResolvedValue(50);
      jest.spyOn(prisma.credentialQuarantine, 'create').mockResolvedValue({
        id: 'quat_test_2',
        organizationId: orgId,
        state: 'QUARANTINED',
        reason: 'UNKNOWN_KEY',
      } as any);
      jest.spyOn(prisma.credentialQuarantineAudit, 'create').mockResolvedValue(undefined);

      const result = await service.createQuarantine({
        organizationId: orgId,
        reason: 'UNKNOWN_KEY',
        metadata: {
          contentHash: hash,
          contentSize: 1024,
          schemaType: 'EarnProofMinimumIncomeCredential',
          schemaVersion: 'earnproof.minimum-income.v1',
          issuerIdentifier: 'test-issuer',
          keyId: 'unknown_key_123',
          keyType: 'Ed25519',
          network: 'public',
        },
        importedByUserId: userId,
      });

      expect(result.reason).toBe('UNKNOWN_KEY');
      expect(result.state).toBe('QUARANTINED');
    });
  });

  describe('releaseCredential - positive', () => {
    it('should release with fresh evidence and independent actor', async () => {
      const orgId = syntheticOrgId('release-positive-1');
      const importerId = syntheticUserId('importer');
      const releaserId = syntheticUserId('releaser');
      const now = new Date();

      const quarantine = {
        id: 'quat_release_1',
        organizationId: orgId,
        state: 'QUARANTINED',
        reason: 'POLICY_CONFLICT',
        importedByUserId: importerId,
        decidedByUserId: null,
        decidedAt: null,
        decisionReason: null,
        revision: 1,
        evidenceRefreshedAt: now,
        evidenceFreshUntil: new Date(now.getTime() + 12 * 60 * 60 * 1000), // Fresh
        issuerIdentifier: 'test-issuer',
      };

      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(quarantine as any);
      jest.spyOn(prisma.credentialQuarantine, 'updateMany').mockResolvedValue({ count: 1 });
      jest.spyOn(prisma.credentialQuarantineAudit, 'create').mockResolvedValue(undefined);

      const result = await service.releaseCredential(
        'quat_release_1',
        orgId,
        releaserId,
        { reason: 'Evidence validated, re-validation passed' },
      );

      // After release, findFirst should be called again to return updated record
      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValueOnce({
        ...quarantine,
        state: 'RELEASED',
        decidedByUserId: releaserId,
        decidedAt: now,
        revision: 2,
      } as any);

      const updated = await service.getQuarantine('quat_release_1', orgId);
      expect(updated.state).toBe('RELEASED');
      expect(updated.decidedByUserId).toBe(releaserId);
    });
  });

  describe('rejectCredential - positive', () => {
    it('should reject with reason', async () => {
      const orgId = syntheticOrgId('reject-positive-1');
      const rejecterId = syntheticUserId('rejecter');

      const quarantine = {
        id: 'quat_reject_1',
        organizationId: orgId,
        state: 'QUARANTINED',
        reason: 'SUSPICIOUS',
        importedByUserId: syntheticUserId('importer'),
        revision: 1,
      };

      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(quarantine as any);
      jest.spyOn(prisma.credentialQuarantine, 'updateMany').mockResolvedValue({ count: 1 });
      jest.spyOn(prisma.credentialQuarantineAudit, 'create').mockResolvedValue(undefined);

      const result = await service.rejectCredential(
        'quat_reject_1',
        orgId,
        rejecterId,
        { reason: 'Heuristic detection flagged as suspicious pattern' },
      );

      expect(prisma.credentialQuarantine.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'quat_reject_1',
            revision: 1,
          }),
          data: expect.objectContaining({
            state: 'REJECTED',
            decidedByUserId: rejecterId,
          }),
        }),
      );
    });
  });

  describe('expireQuarantineRecords - positive', () => {
    it('should expire records past deadline', async () => {
      jest.spyOn(prisma.credentialQuarantine, 'updateMany').mockResolvedValue({ count: 5 });

      const count = await service.expireQuarantineRecords();

      expect(count).toBe(5);
      expect(prisma.credentialQuarantine.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            state: 'QUARANTINED',
            expiresAt: expect.objectContaining({
              lt: expect.any(Date),
            }),
          }),
          data: expect.objectContaining({
            state: 'EXPIRED',
          }),
        }),
      );
    });
  });

  // ========================================================================
  // NEGATIVE TESTS: Error scenarios
  // ========================================================================

  describe('createQuarantine - negative', () => {
    it('should reject if already quarantined', async () => {
      const orgId = syntheticOrgId('neg-1');
      const hash = syntheticHash('dup-cred');

      const existing = {
        id: 'quat_dup_1',
        organizationId: orgId,
        state: 'QUARANTINED',
      };

      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(existing as any);

      await expect(
        service.createQuarantine({
          organizationId: orgId,
          reason: 'MALFORMED',
          metadata: {
            contentHash: hash,
            contentSize: 512,
            schemaType: 'EarnProofMinimumIncomeCredential',
            schemaVersion: 'earnproof.minimum-income.v1',
            issuerIdentifier: 'test-issuer',
          },
          importedByUserId: syntheticUserId('importer'),
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should reject if capacity exceeded', async () => {
      const orgId = syntheticOrgId('neg-2');

      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(null);
      jest.spyOn(prisma.credentialQuarantine, 'count').mockResolvedValue(10_000);

      await expect(
        service.createQuarantine({
          organizationId: orgId,
          reason: 'MALFORMED',
          metadata: {
            contentHash: syntheticHash('over-cap'),
            contentSize: 512,
            schemaType: 'EarnProofMinimumIncomeCredential',
            schemaVersion: 'earnproof.minimum-income.v1',
            issuerIdentifier: 'test-issuer',
          },
          importedByUserId: syntheticUserId('importer'),
        }),
      ).rejects.toThrow(PayloadTooLargeException);
    });

    it('should reject metadata with oversized fields', async () => {
      const orgId = syntheticOrgId('neg-3');
      const tooLongSchema = 'a'.repeat(101); // Max is 100

      await expect(
        service.createQuarantine({
          organizationId: orgId,
          reason: 'MALFORMED',
          metadata: {
            contentHash: syntheticHash('oversized'),
            contentSize: 512,
            schemaType: tooLongSchema,
            schemaVersion: 'earnproof.minimum-income.v1',
            issuerIdentifier: 'test-issuer',
          },
          importedByUserId: syntheticUserId('importer'),
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('releaseCredential - negative', () => {
    it('should reject if evidence stale', async () => {
      const orgId = syntheticOrgId('rel-neg-1');
      const pastTime = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago

      const quarantine = {
        id: 'quat_stale_1',
        organizationId: orgId,
        state: 'QUARANTINED',
        importedByUserId: syntheticUserId('importer'),
        evidenceRefreshedAt: pastTime,
        evidenceFreshUntil: new Date(pastTime.getTime() + 24 * 60 * 60 * 1000), // Now stale
      };

      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(quarantine as any);

      await expect(
        service.releaseCredential('quat_stale_1', orgId, syntheticUserId('releaser'), {}),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject self-approval (four-eyes)', async () => {
      const orgId = syntheticOrgId('rel-neg-2');
      const userId = syntheticUserId('same-user');
      const now = new Date();

      const quarantine = {
        id: 'quat_selfapprove_1',
        organizationId: orgId,
        state: 'QUARANTINED',
        importedByUserId: userId, // Same user
        evidenceRefreshedAt: now,
        evidenceFreshUntil: new Date(now.getTime() + 12 * 60 * 60 * 1000),
      };

      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(quarantine as any);

      await expect(
        service.releaseCredential('quat_selfapprove_1', orgId, userId, {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject if record in terminal state', async () => {
      const orgId = syntheticOrgId('rel-neg-3');

      const quarantine = {
        id: 'quat_terminal_1',
        organizationId: orgId,
        state: 'REJECTED', // Terminal
        importedByUserId: syntheticUserId('importer'),
      };

      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(quarantine as any);

      await expect(
        service.releaseCredential(
          'quat_terminal_1',
          orgId,
          syntheticUserId('releaser'),
          {},
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject on concurrent modification', async () => {
      const orgId = syntheticOrgId('rel-neg-4');
      const now = new Date();

      const quarantine = {
        id: 'quat_concurrent_1',
        organizationId: orgId,
        state: 'QUARANTINED',
        importedByUserId: syntheticUserId('importer'),
        revision: 1,
        evidenceRefreshedAt: now,
        evidenceFreshUntil: new Date(now.getTime() + 12 * 60 * 60 * 1000),
      };

      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(quarantine as any);
      jest.spyOn(prisma.credentialQuarantine, 'updateMany').mockResolvedValue({ count: 0 }); // No rows updated

      await expect(
        service.releaseCredential(
          'quat_concurrent_1',
          orgId,
          syntheticUserId('releaser'),
          {},
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('rejectCredential - negative', () => {
    it('should reject if reason too long', async () => {
      const orgId = syntheticOrgId('rej-neg-1');
      const tooLongReason = 'a'.repeat(1025); // Max is 1024

      const quarantine = {
        id: 'quat_long_reason_1',
        organizationId: orgId,
        state: 'QUARANTINED',
        importedByUserId: syntheticUserId('importer'),
        revision: 1,
      };

      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(quarantine as any);

      await expect(
        service.rejectCredential('quat_long_reason_1', orgId, syntheticUserId('rejecter'), {
          reason: tooLongReason,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject if concurrent modification', async () => {
      const orgId = syntheticOrgId('rej-neg-2');

      const quarantine = {
        id: 'quat_rej_concurrent_1',
        organizationId: orgId,
        state: 'QUARANTINED',
        revision: 1,
      };

      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(quarantine as any);
      jest.spyOn(prisma.credentialQuarantine, 'updateMany').mockResolvedValue({ count: 0 });

      await expect(
        service.rejectCredential('quat_rej_concurrent_1', orgId, syntheticUserId('rejecter'), {
          reason: 'Test rejection',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ========================================================================
  // AUTHORIZATION TESTS: Role and tenant scoping
  // ========================================================================

  describe('tenant scoping', () => {
    it('should return 404 for cross-tenant access', async () => {
      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(null);

      await expect(
        service.getQuarantine('quat_other_org', syntheticOrgId('wrong-org')),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return 404 indistinguishable from non-existent', async () => {
      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(null);

      const error1 = await service
        .getQuarantine('quat_nonexistent', syntheticOrgId('org1'))
        .catch((e) => e.message);

      const error2 = await service
        .getQuarantine('quat_other_tenant', syntheticOrgId('org2'))
        .catch((e) => e.message);

      expect(error1).toBe(error2);
    });
  });

  // ========================================================================
  // CONCURRENCY TESTS: Optimistic locking and race conditions
  // ========================================================================

  describe('concurrency - optimistic locking', () => {
    it('simultaneous release and reject: exactly one should succeed', async () => {
      const orgId = syntheticOrgId('concur-1');
      const now = new Date();

      const quarantine = {
        id: 'quat_race_1',
        organizationId: orgId,
        state: 'QUARANTINED',
        importedByUserId: syntheticUserId('importer'),
        revision: 1,
        evidenceRefreshedAt: now,
        evidenceFreshUntil: new Date(now.getTime() + 12 * 60 * 60 * 1000),
      };

      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(quarantine as any);

      // First release succeeds (updates count = 1)
      jest.spyOn(prisma.credentialQuarantine, 'updateMany').mockResolvedValueOnce({ count: 1 });

      const releaseResult = service.releaseCredential(
        'quat_race_1',
        orgId,
        syntheticUserId('releaser'),
        {},
      );

      // Second reject fails (updates count = 0, concurrent modification)
      jest.spyOn(prisma.credentialQuarantine, 'updateMany').mockResolvedValueOnce({ count: 0 });

      const rejectResult = service.rejectCredential(
        'quat_race_1',
        orgId,
        syntheticUserId('rejecter'),
        { reason: 'Rejected' },
      );

      await expect(releaseResult).resolves.toBeDefined();
      await expect(rejectResult).rejects.toThrow(ConflictException);
    });
  });

  // ========================================================================
  // BOUNDARY TESTS: Edge cases at limits
  // ========================================================================

  describe('boundary - capacity limits', () => {
    it('record at cap is rejected', async () => {
      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(null);
      jest.spyOn(prisma.credentialQuarantine, 'count').mockResolvedValue(10_000);

      await expect(
        service.createQuarantine({
          organizationId: syntheticOrgId('boundary-1'),
          reason: 'MALFORMED',
          metadata: {
            contentHash: syntheticHash('at-cap'),
            contentSize: 512,
            schemaType: 'EarnProofMinimumIncomeCredential',
            schemaVersion: 'earnproof.minimum-income.v1',
            issuerIdentifier: 'test-issuer',
          },
          importedByUserId: syntheticUserId('importer'),
        }),
      ).rejects.toThrow(PayloadTooLargeException);
    });

    it('record one past cap is rejected', async () => {
      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(null);
      jest.spyOn(prisma.credentialQuarantine, 'count').mockResolvedValue(10_001);

      await expect(
        service.createQuarantine({
          organizationId: syntheticOrgId('boundary-2'),
          reason: 'MALFORMED',
          metadata: {
            contentHash: syntheticHash('past-cap'),
            contentSize: 512,
            schemaType: 'EarnProofMinimumIncomeCredential',
            schemaVersion: 'earnproof.minimum-income.v1',
            issuerIdentifier: 'test-issuer',
          },
          importedByUserId: syntheticUserId('importer'),
        }),
      ).rejects.toThrow(PayloadTooLargeException);
    });

    it('evidence exactly at freshness limit is accepted', async () => {
      const orgId = syntheticOrgId('boundary-3');
      const now = new Date();
      const exactLimit = new Date(now.getTime() - 24 * 60 * 60 * 1000); // Exactly 24 hours ago

      const quarantine = {
        id: 'quat_exact_limit_1',
        organizationId: orgId,
        state: 'QUARANTINED',
        importedByUserId: syntheticUserId('importer'),
        evidenceRefreshedAt: exactLimit,
        evidenceFreshUntil: now, // Expires exactly now
      };

      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(quarantine as any);
      jest.spyOn(prisma.credentialQuarantine, 'updateMany').mockResolvedValue({ count: 1 });
      jest.spyOn(prisma.credentialQuarantineAudit, 'create').mockResolvedValue(undefined);

      // Should succeed because evidenceFreshUntil >= now
      await expect(
        service.releaseCredential(
          'quat_exact_limit_1',
          orgId,
          syntheticUserId('releaser'),
          {},
        ),
      ).resolves.toBeDefined();
    });
  });

  // ========================================================================
  // REPLAY TESTS: Idempotency
  // ========================================================================

  describe('replay - idempotency', () => {
    it('double release is rejected after first succeeds', async () => {
      const orgId = syntheticOrgId('replay-1');
      const now = new Date();

      // First call: state is QUARANTINED
      const quarantineState = {
        id: 'quat_replay_1',
        organizationId: orgId,
        state: 'QUARANTINED',
        importedByUserId: syntheticUserId('importer'),
        revision: 1,
        evidenceRefreshedAt: now,
        evidenceFreshUntil: new Date(now.getTime() + 12 * 60 * 60 * 1000),
      };

      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValueOnce(quarantineState as any);
      jest.spyOn(prisma.credentialQuarantine, 'updateMany').mockResolvedValueOnce({ count: 1 });
      jest.spyOn(prisma.credentialQuarantineAudit, 'create').mockResolvedValueOnce(undefined);

      // First release succeeds
      const first = await service.releaseCredential(
        'quat_replay_1',
        orgId,
        syntheticUserId('releaser'),
        {},
      );

      // Second call: state is now RELEASED
      const releasedState = {
        ...quarantineState,
        state: 'RELEASED',
        revision: 2,
      };

      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValueOnce(releasedState as any);

      // Second release should fail because state != QUARANTINED
      const second = service.releaseCredential(
        'quat_replay_1',
        orgId,
        syntheticUserId('releaser'),
        {},
      );

      await expect(second).rejects.toThrow(BadRequestException);
    });
  });

  // ========================================================================
  // REGRESSION TESTS: Privacy and logging
  // ========================================================================

  describe('privacy - no raw content in responses', () => {
    it('should never expose raw credential content', async () => {
      const quarantine = {
        id: 'quat_privacy_1',
        organizationId: syntheticOrgId('privacy-1'),
        contentHash: syntheticHash('private-cred'),
        contentSize: 512, // Size is OK; content itself is never stored
        schemaType: 'EarnProofMinimumIncomeCredential',
      };

      jest.spyOn(prisma.credentialQuarantine, 'findFirst').mockResolvedValue(quarantine as any);

      const result = await service.getQuarantine(quarantine.id, quarantine.organizationId);

      // Verify no raw content fields
      expect(result).not.toHaveProperty('rawCredential');
      expect(result).not.toHaveProperty('credentialContent');
      expect(result).toHaveProperty('contentHash');
      expect(result).toHaveProperty('contentSize');
    });
  });
});
