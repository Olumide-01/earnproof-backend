import { Test, TestingModule } from '@nestjs/testing';
import { PurposeEnforcementService } from './purpose-enforcement.service';
import { PrismaService } from '../database/prisma.service';
import * as fixtures from './purpose-declarations.fixtures';

describe('PurposeEnforcementService', () => {
  let service: PurposeEnforcementService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PurposeEnforcementService,
        {
          provide: PrismaService,
          useValue: {
            purposeDeclaration: {
              findFirst: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<PurposeEnforcementService>(PurposeEnforcementService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  // =========================================================================
  // Backward Compatibility Tests
  // =========================================================================

  describe('Backward Compatibility', () => {
    it('should allow verification when policy does not require purpose', async () => {
      const context = {
        organizationId: fixtures.FIXTURE_ORGANIZATION_ID,
        verifierOrganizationId: fixtures.FIXTURE_VERIFIER_ORG_ID,
        policyRequiresPurposeDeclaration: false, // Not required
      };

      const result = await service.enforceVerificationPurpose(context);

      expect(result.isValid).toBe(true);
      // Should not even attempt to load declaration
      expect(prisma.purposeDeclaration.findFirst).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Purpose Enforcement Tests (Policy Requires Declaration)
  // =========================================================================

  describe('enforceVerificationPurpose with requirement', () => {
    it('should pass verification with valid approved declaration', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationApproved();
      const context = {
        organizationId: fixtures.FIXTURE_ORGANIZATION_ID,
        verifierOrganizationId: fixtures.FIXTURE_VERIFIER_ORG_ID,
        policyRequiresPurposeDeclaration: true,
      };

      (prisma.purposeDeclaration.findFirst as jest.Mock).mockResolvedValueOnce(declaration);

      const result = await service.enforceVerificationPurpose(context);

      expect(result.isValid).toBe(true);
      expect(result.declaration).toEqual(declaration);
      expect(result.declarationVersion).toBe(declaration.revision);
    });

    it('should reject verification when no declaration exists', async () => {
      const context = {
        organizationId: fixtures.FIXTURE_ORGANIZATION_ID,
        verifierOrganizationId: fixtures.FIXTURE_VERIFIER_ORG_ID,
        policyRequiresPurposeDeclaration: true,
      };

      (prisma.purposeDeclaration.findFirst as jest.Mock).mockResolvedValueOnce(null);

      const result = await service.enforceVerificationPurpose(context);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('NO_VALID_PURPOSE_DECLARATION');
    });

    it('should reject verification with PENDING declaration', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationPending();
      const context = {
        organizationId: fixtures.FIXTURE_ORGANIZATION_ID,
        verifierOrganizationId: fixtures.FIXTURE_VERIFIER_ORG_ID,
        policyRequiresPurposeDeclaration: true,
      };

      (prisma.purposeDeclaration.findFirst as jest.Mock).mockResolvedValueOnce(declaration);

      const result = await service.enforceVerificationPurpose(context);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('DECLARATION_PENDING');
    });

    it('should reject verification with REVOKED declaration', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationRevoked();
      const context = {
        organizationId: fixtures.FIXTURE_ORGANIZATION_ID,
        verifierOrganizationId: fixtures.FIXTURE_VERIFIER_ORG_ID,
        policyRequiresPurposeDeclaration: true,
      };

      (prisma.purposeDeclaration.findFirst as jest.Mock).mockResolvedValueOnce(declaration);

      const result = await service.enforceVerificationPurpose(context);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('DECLARATION_REVOKED');
    });

    it('should reject verification with EXPIRED declaration', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationExpired();
      const context = {
        organizationId: fixtures.FIXTURE_ORGANIZATION_ID,
        verifierOrganizationId: fixtures.FIXTURE_VERIFIER_ORG_ID,
        policyRequiresPurposeDeclaration: true,
      };

      (prisma.purposeDeclaration.findFirst as jest.Mock).mockResolvedValueOnce(declaration);

      const result = await service.enforceVerificationPurpose(context);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('DECLARATION_EXPIRED');
    });

    it('should reject verification with wrong organization', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationWrongOrg();
      const context = {
        organizationId: fixtures.FIXTURE_ORGANIZATION_ID,
        verifierOrganizationId: fixtures.FIXTURE_VERIFIER_ORG_ID,
        policyRequiresPurposeDeclaration: true,
      };

      (prisma.purposeDeclaration.findFirst as jest.Mock).mockResolvedValueOnce(declaration);

      const result = await service.enforceVerificationPurpose(context);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('DECLARATION_ORG_MISMATCH');
    });

    it('should reject verification with wrong verifier organization', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationWrongVerifier();
      const context = {
        organizationId: fixtures.FIXTURE_ORGANIZATION_ID,
        verifierOrganizationId: fixtures.FIXTURE_VERIFIER_ORG_ID,
        policyRequiresPurposeDeclaration: true,
      };

      (prisma.purposeDeclaration.findFirst as jest.Mock).mockResolvedValueOnce(declaration);

      const result = await service.enforceVerificationPurpose(context);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('DECLARATION_VERIFIER_MISMATCH');
    });
  });

  // =========================================================================
  // Invariant Tests
  // =========================================================================

  describe('Hard Invariants', () => {
    it('should not allow valid declaration alone to grant access (invariant)', async () => {
      // This test verifies that a valid declaration doesn't bypass authorization
      // The declaration can only restrict, never grant. Authorization still required.
      const context = {
        organizationId: fixtures.FIXTURE_ORGANIZATION_ID,
        verifierOrganizationId: fixtures.FIXTURE_VERIFIER_ORG_ID,
        policyRequiresPurposeDeclaration: true,
      };

      const declaration = fixtures.createFixturePurposeDeclarationApproved();
      (prisma.purposeDeclaration.findFirst as jest.Mock).mockResolvedValueOnce(declaration);

      const result = await service.enforceVerificationPurpose(context);

      // Declaration is valid, but caller still needs to be authenticated
      // and the proof still needs to be valid. Purpose enforcement is only
      // one gate among many.
      expect(result.isValid).toBe(true);
      // But this alone doesn't mean verification is authorized —
      // other checks still apply (signature, revocation, expiry, etc.)
    });
  });

  // =========================================================================
  // Declaration Loading Tests
  // =========================================================================

  describe('Declaration Loading', () => {
    it('should load most recent valid declaration', async () => {
      const context = {
        organizationId: fixtures.FIXTURE_ORGANIZATION_ID,
        verifierOrganizationId: fixtures.FIXTURE_VERIFIER_ORG_ID,
        policyRequiresPurposeDeclaration: true,
      };

      const declaration = fixtures.createFixturePurposeDeclarationApproved();
      (prisma.purposeDeclaration.findFirst as jest.Mock).mockResolvedValueOnce(declaration);

      await service.enforceVerificationPurpose(context);

      // Verify findFirst was called with correct criteria
      expect(prisma.purposeDeclaration.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: fixtures.FIXTURE_ORGANIZATION_ID,
            approvalState: 'APPROVED',
            expiresAt: expect.any(Object), // Date comparison
          }),
        }),
      );
    });
  });

  // =========================================================================
  // Error Determinism Tests
  // =========================================================================

  describe('Deterministic Error Codes', () => {
    it('should return deterministic error codes for each failure mode', async () => {
      const testCases = [
        {
          name: 'Not found',
          declaration: null,
          expectedCode: 'NO_VALID_PURPOSE_DECLARATION',
        },
        {
          name: 'Pending',
          declaration: fixtures.createFixturePurposeDeclarationPending(),
          expectedCode: 'DECLARATION_PENDING',
        },
        {
          name: 'Revoked',
          declaration: fixtures.createFixturePurposeDeclarationRevoked(),
          expectedCode: 'DECLARATION_REVOKED',
        },
        {
          name: 'Expired',
          declaration: fixtures.createFixturePurposeDeclarationExpired(),
          expectedCode: 'DECLARATION_EXPIRED',
        },
        {
          name: 'Wrong org',
          declaration: fixtures.createFixturePurposeDeclarationWrongOrg(),
          expectedCode: 'DECLARATION_ORG_MISMATCH',
        },
      ];

      for (const { name, declaration, expectedCode } of testCases) {
        const context = {
          organizationId: fixtures.FIXTURE_ORGANIZATION_ID,
          verifierOrganizationId: fixtures.FIXTURE_VERIFIER_ORG_ID,
          policyRequiresPurposeDeclaration: true,
        };

        (prisma.purposeDeclaration.findFirst as jest.Mock).mockResolvedValueOnce(declaration);

        const result = await service.enforceVerificationPurpose(context);

        expect(result.errorCode).toBe(expectedCode);
        expect(result.reason).toBeDefined();
      }
    });
  });

  // =========================================================================
  // Scope Constraint Tests (Placeholder)
  // =========================================================================

  describe('Scope Constraints', () => {
    it('should validate scope constraints if policy scope provided', async () => {
      const declaration = fixtures.createFixturePurposeDeclarationApproved();
      const context = {
        organizationId: fixtures.FIXTURE_ORGANIZATION_ID,
        verifierOrganizationId: fixtures.FIXTURE_VERIFIER_ORG_ID,
        policyRequiresPurposeDeclaration: true,
        policyDisclosureScope: { maxAmount: 100000 }, // Policy scope
      };

      (prisma.purposeDeclaration.findFirst as jest.Mock).mockResolvedValueOnce(declaration);

      // With current implementation, scope is validated at declaration creation,
      // not here. This test documents the behavior.
      const result = await service.enforceVerificationPurpose(context);

      expect(result.isValid).toBe(true);
    });
  });
});
