import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PurposeDeclarationsService } from './purpose-declarations.service';
import { PrismaService } from '../database/prisma.service';
import * as fixtures from './purpose-declarations.fixtures';

describe('PurposeDeclarationsService', () => {
  let service: PurposeDeclarationsService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PurposeDeclarationsService,
        {
          provide: PrismaService,
          useValue: {
            purposeDefinition: {
              create: jest.fn(),
              findFirst: jest.fn(),
              findUnique: jest.fn(),
            },
            purposeDeclaration: {
              create: jest.fn(),
              findUnique: jest.fn(),
              findFirst: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
              update: jest.fn(),
            },
            declarationAuditEntry: {
              create: jest.fn(),
              findFirst: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<PurposeDeclarationsService>(PurposeDeclarationsService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  // =========================================================================
  // Purpose Definition Creation Tests
  // =========================================================================

  describe('createPurposeDefinition', () => {
    it('should create a new purpose definition v1 if none exists', async () => {
      const input = {
        purposeKey: fixtures.FIXTURE_PURPOSE_KEY,
        description: fixtures.FIXTURE_DESCRIPTION,
        disclosureScope: fixtures.FIXTURE_DISCLOSURE_SCOPE_NARROW,
      };

      (prisma.purposeDefinition.findFirst as jest.Mock).mockResolvedValueOnce(null);
      (prisma.purposeDefinition.create as jest.Mock).mockResolvedValueOnce(
        fixtures.createFixturePurposeDefinition({ version: 1 }),
      );

      const result = await service.createPurposeDefinition(fixtures.FIXTURE_ORGANIZATION_ID, input);

      expect(result.version).toBe(1);
      expect(prisma.purposeDefinition.create).toHaveBeenCalledWith({
        data: {
          organizationId: fixtures.FIXTURE_ORGANIZATION_ID,
          purposeKey: input.purposeKey,
          version: 1,
          description: input.description,
          disclosureScope: input.disclosureScope,
        },
      });
    });

    it('should create v2 if v1 already exists', async () => {
      const input = {
        purposeKey: fixtures.FIXTURE_PURPOSE_KEY,
        description: 'Updated description',
        disclosureScope: fixtures.FIXTURE_DISCLOSURE_SCOPE_NARROW,
      };

      const v1 = fixtures.createFixturePurposeDefinition({ version: 1 });
      (prisma.purposeDefinition.findFirst as jest.Mock).mockResolvedValueOnce(v1);
      (prisma.purposeDefinition.create as jest.Mock).mockResolvedValueOnce(
        fixtures.createFixturePurposeDefinition({ version: 2 }),
      );

      const result = await service.createPurposeDefinition(fixtures.FIXTURE_ORGANIZATION_ID, input);

      expect(result.version).toBe(2);
      expect(prisma.purposeDefinition.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            version: 2,
          }),
        }),
      );
    });

    it('should reject empty purpose key', async () => {
      const input = {
        purposeKey: '',
        description: fixtures.FIXTURE_DESCRIPTION,
        disclosureScope: fixtures.FIXTURE_DISCLOSURE_SCOPE_NARROW,
      };

      await expect(
        service.createPurposeDefinition(fixtures.FIXTURE_ORGANIZATION_ID, input),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject description exceeding 500 chars', async () => {
      const input = {
        purposeKey: fixtures.FIXTURE_PURPOSE_KEY,
        description: 'a'.repeat(501),
        disclosureScope: fixtures.FIXTURE_DISCLOSURE_SCOPE_NARROW,
      };

      await expect(
        service.createPurposeDefinition(fixtures.FIXTURE_ORGANIZATION_ID, input),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // =========================================================================
  // Purpose Declaration Lifecycle Tests
  // =========================================================================

  describe('createPurposeDeclaration', () => {
    it('should create a new declaration in PENDING state', async () => {
      const input = {
        purposeDefinitionId: 'purpose_def_1',
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      };

      const purposeDef = fixtures.createFixturePurposeDefinition();
      (prisma.purposeDefinition.findUnique as jest.Mock).mockResolvedValueOnce(purposeDef);
      (prisma.purposeDeclaration.findUnique as jest.Mock).mockResolvedValueOnce(null);

      const created = fixtures.createFixturePurposeDeclarationPending();
      (prisma.purposeDeclaration.create as jest.Mock).mockResolvedValueOnce(created);
      (prisma.declarationAuditEntry.create as jest.Mock).mockResolvedValueOnce({});

      const result = await service.createPurposeDeclaration(
        fixtures.FIXTURE_ORGANIZATION_ID,
        fixtures.FIXTURE_USER_ID,
        input,
      );

      expect(result.approvalState).toBe('PENDING');
      expect(prisma.purposeDeclaration.create).toHaveBeenCalled();
      expect(prisma.declarationAuditEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            event: 'CREATED',
          }),
        }),
      );
    });

    it('should reject if purpose definition not found', async () => {
      const input = {
        purposeDefinitionId: 'nonexistent',
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      };

      (prisma.purposeDefinition.findUnique as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        service.createPurposeDeclaration(
          fixtures.FIXTURE_ORGANIZATION_ID,
          fixtures.FIXTURE_USER_ID,
          input,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject if declaration already exists for purpose', async () => {
      const input = {
        purposeDefinitionId: 'purpose_def_1',
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      };

      const purposeDef = fixtures.createFixturePurposeDefinition();
      (prisma.purposeDefinition.findUnique as jest.Mock).mockResolvedValueOnce(purposeDef);
      (prisma.purposeDeclaration.findUnique as jest.Mock).mockResolvedValueOnce(
        fixtures.createFixturePurposeDeclarationPending(),
      );

      await expect(
        service.createPurposeDeclaration(
          fixtures.FIXTURE_ORGANIZATION_ID,
          fixtures.FIXTURE_USER_ID,
          input,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('approvePurposeDeclaration', () => {
    it('should transition PENDING to APPROVED', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationPending();
      (prisma.purposeDeclaration.findUnique as jest.Mock).mockResolvedValueOnce(declaration);
      (prisma.declarationAuditEntry.findFirst as jest.Mock).mockResolvedValueOnce(null);

      const approved = fixtures.createFixturePurposeDeclarationApproved();
      (prisma.purposeDeclaration.update as jest.Mock).mockResolvedValueOnce(approved);
      (prisma.declarationAuditEntry.create as jest.Mock).mockResolvedValueOnce({});

      const result = await service.approvePurposeDeclaration(
        fixtures.FIXTURE_ORGANIZATION_ID,
        fixtures.FIXTURE_APPROVER_ID,
        {
          declarationId: declaration.id,
          reason: 'Loan application approved',
        },
      );

      expect(result.approvalState).toBe('APPROVED');
      expect(prisma.purposeDeclaration.update).toHaveBeenCalled();
    });

    it('should be idempotent for repeated approval requests', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationPending();
      (prisma.purposeDeclaration.findUnique as jest.Mock).mockResolvedValueOnce(declaration);

      const priorApproval = { id: 'audit_1' };
      (prisma.declarationAuditEntry.findFirst as jest.Mock).mockResolvedValueOnce(priorApproval);

      const approved = fixtures.createFixturePurposeDeclarationApproved();
      (prisma.purposeDeclaration.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce(approved);

      const result = await service.approvePurposeDeclaration(
        fixtures.FIXTURE_ORGANIZATION_ID,
        fixtures.FIXTURE_APPROVER_ID,
        {
          declarationId: declaration.id,
          reason: 'Loan application approved',
        },
      );

      expect(result.approvalState).toBe('APPROVED');
      // Should not call update (idempotent)
      expect(prisma.purposeDeclaration.update).not.toHaveBeenCalled();
    });

    it('should reject approval of non-PENDING declaration', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationApproved();
      (prisma.purposeDeclaration.findUnique as jest.Mock).mockResolvedValueOnce(declaration);

      await expect(
        service.approvePurposeDeclaration(
          fixtures.FIXTURE_ORGANIZATION_ID,
          fixtures.FIXTURE_APPROVER_ID,
          { declarationId: declaration.id },
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('revokePurposeDeclaration', () => {
    it('should transition APPROVED to REVOKED', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationApproved();
      (prisma.purposeDeclaration.findUnique as jest.Mock).mockResolvedValueOnce(declaration);
      (prisma.declarationAuditEntry.findFirst as jest.Mock).mockResolvedValueOnce(null);

      const revoked = fixtures.createFixturePurposeDeclarationRevoked();
      (prisma.purposeDeclaration.update as jest.Mock).mockResolvedValueOnce(revoked);
      (prisma.declarationAuditEntry.create as jest.Mock).mockResolvedValueOnce({});

      const result = await service.revokePurposeDeclaration(
        fixtures.FIXTURE_ORGANIZATION_ID,
        fixtures.FIXTURE_REVOKER_ID,
        {
          declarationId: declaration.id,
          reason: 'Loan application declined',
        },
      );

      expect(result.approvalState).toBe('REVOKED');
    });

    it('should be idempotent for repeated revocation requests', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationApproved();
      (prisma.purposeDeclaration.findUnique as jest.Mock).mockResolvedValueOnce(declaration);

      const priorRevocation = { id: 'audit_2' };
      (prisma.declarationAuditEntry.findFirst as jest.Mock).mockResolvedValueOnce(priorRevocation);

      const revoked = fixtures.createFixturePurposeDeclarationRevoked();
      (prisma.purposeDeclaration.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce(revoked);

      const result = await service.revokePurposeDeclaration(
        fixtures.FIXTURE_ORGANIZATION_ID,
        fixtures.FIXTURE_REVOKER_ID,
        { declarationId: declaration.id },
      );

      expect(result.approvalState).toBe('REVOKED');
      expect(prisma.purposeDeclaration.update).not.toHaveBeenCalled();
    });

    it('should take effect immediately (no in-flight grace period)', async () => {
      // Verified by the fact that revoke updates state immediately with no delay or async marker
      const declaration = fixtures.createFixturePurposeDeclarationApproved();
      (prisma.purposeDeclaration.findUnique as jest.Mock).mockResolvedValueOnce(declaration);
      (prisma.declarationAuditEntry.findFirst as jest.Mock).mockResolvedValueOnce(null);

      const revoked = fixtures.createFixturePurposeDeclarationRevoked();
      (prisma.purposeDeclaration.update as jest.Mock).mockResolvedValueOnce(revoked);
      (prisma.declarationAuditEntry.create as jest.Mock).mockResolvedValueOnce({});

      // Verify that update includes revokedAt timestamp
      await service.revokePurposeDeclaration(
        fixtures.FIXTURE_ORGANIZATION_ID,
        fixtures.FIXTURE_REVOKER_ID,
        { declarationId: declaration.id },
      );

      expect(prisma.purposeDeclaration.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            revokedAt: expect.any(Date),
          }),
        }),
      );
    });
  });

  // =========================================================================
  // Validation Tests
  // =========================================================================

  describe('validateDeclarationForVerification', () => {
    it('should validate an APPROVED, non-expired declaration', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationApproved();
      const purposeDef = fixtures.createFixturePurposeDefinition();

      (prisma.purposeDeclaration.findUnique as jest.Mock).mockResolvedValueOnce({
        ...declaration,
        purposeDefinition: purposeDef,
      });

      const result = await service.validateDeclarationForVerification(
        fixtures.FIXTURE_ORGANIZATION_ID,
        declaration.id,
      );

      expect(result.isValid).toBe(true);
    });

    it('should reject PENDING declaration', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationPending();
      const purposeDef = fixtures.createFixturePurposeDefinition();

      (prisma.purposeDeclaration.findUnique as jest.Mock).mockResolvedValueOnce({
        ...declaration,
        purposeDefinition: purposeDef,
      });

      const result = await service.validateDeclarationForVerification(
        fixtures.FIXTURE_ORGANIZATION_ID,
        declaration.id,
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('DECLARATION_PENDING');
    });

    it('should reject REVOKED declaration', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationRevoked();
      const purposeDef = fixtures.createFixturePurposeDefinition();

      (prisma.purposeDeclaration.findUnique as jest.Mock).mockResolvedValueOnce({
        ...declaration,
        purposeDefinition: purposeDef,
      });

      const result = await service.validateDeclarationForVerification(
        fixtures.FIXTURE_ORGANIZATION_ID,
        declaration.id,
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('DECLARATION_REVOKED');
    });

    it('should reject expired declaration', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationExpired();
      const purposeDef = fixtures.createFixturePurposeDefinition();

      (prisma.purposeDeclaration.findUnique as jest.Mock).mockResolvedValueOnce({
        ...declaration,
        purposeDefinition: purposeDef,
      });

      const result = await service.validateDeclarationForVerification(
        fixtures.FIXTURE_ORGANIZATION_ID,
        declaration.id,
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('DECLARATION_EXPIRED');
    });

    it('should reject declaration from wrong organization', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationWrongOrg();
      const purposeDef = fixtures.createFixturePurposeDefinition();

      (prisma.purposeDeclaration.findUnique as jest.Mock).mockResolvedValueOnce({
        ...declaration,
        purposeDefinition: purposeDef,
      });

      const result = await service.validateDeclarationForVerification(
        fixtures.FIXTURE_ORGANIZATION_ID,
        declaration.id,
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('DECLARATION_ORG_MISMATCH');
    });

    it('should reject if declaration scope exceeds policy scope', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationApproved();
      const purposeDef = fixtures.createFixturePurposeDefinition({
        disclosureScope: fixtures.FIXTURE_DISCLOSURE_SCOPE_WIDE,
      });

      (prisma.purposeDeclaration.findUnique as jest.Mock).mockResolvedValueOnce({
        ...declaration,
        purposeDefinition: purposeDef,
      });

      const narrowerPolicy = {
        proofTypes: ['AGGREGATE_EARNINGS'],
        maxAmount: 5000,
      };

      const result = await service.validateDeclarationForVerification(
        fixtures.FIXTURE_ORGANIZATION_ID,
        declaration.id,
        narrowerPolicy,
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('DECLARATION_SCOPE_EXCEEDS_POLICY');
    });
  });

  // =========================================================================
  // Boundary Tests
  // =========================================================================

  describe('Expiry Boundary', () => {
    it('should accept declaration one tick before expiry', async () => {
      const now = new Date();
      const expiryDate = new Date(now.getTime() + 1000); // 1 second in future
      const declaration = fixtures.createFixturePurposeDeclarationApproved({
        expiresAt: expiryDate,
      });
      const purposeDef = fixtures.createFixturePurposeDefinition();

      (prisma.purposeDeclaration.findUnique as jest.Mock).mockResolvedValueOnce({
        ...declaration,
        purposeDefinition: purposeDef,
      });

      const result = await service.validateDeclarationForVerification(
        fixtures.FIXTURE_ORGANIZATION_ID,
        declaration.id,
      );

      expect(result.isValid).toBe(true);
    });

    it('should reject declaration at or after expiry', async () => {
      const now = new Date();
      const declaration = fixtures.createFixturePurposeDeclarationApproved({
        expiresAt: now, // Expiry exactly now
      });
      const purposeDef = fixtures.createFixturePurposeDefinition();

      (prisma.purposeDeclaration.findUnique as jest.Mock).mockResolvedValueOnce({
        ...declaration,
        purposeDefinition: purposeDef,
      });

      const result = await service.validateDeclarationForVerification(
        fixtures.FIXTURE_ORGANIZATION_ID,
        declaration.id,
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('DECLARATION_EXPIRED');
    });
  });
});
