import { PurposeDefinition, PurposeDeclaration, PurposeDeclarationApprovalState } from '@prisma/client';

/**
 * Synthetic test fixtures for purpose declarations.
 * Never contains secrets, wallet material, private proof data, or production credentials.
 */

export const FIXTURE_PURPOSE_KEY = 'income_verification';
export const FIXTURE_DESCRIPTION = 'Verify employment income for loan applications';

export const FIXTURE_DISCLOSURE_SCOPE_NARROW = {
  proofTypes: ['AGGREGATE_EARNINGS'],
  maxAmount: 10000,
};

export const FIXTURE_DISCLOSURE_SCOPE_WIDE = {
  proofTypes: ['AGGREGATE_EARNINGS', 'PAYMENT_RECEIPT'],
  maxAmount: 100000,
};

export const FIXTURE_ORGANIZATION_ID = 'org_test_1';
export const FIXTURE_VERIFIER_ORG_ID = 'org_verifier_1';
export const FIXTURE_USER_ID = 'user_test_1';
export const FIXTURE_APPROVER_ID = 'user_approver_1';
export const FIXTURE_REVOKER_ID = 'user_revoker_1';

/**
 * Create a fixture PurposeDefinition
 */
export function createFixturePurposeDefinition(overrides?: Partial<PurposeDefinition>): PurposeDefinition {
  const now = new Date();
  return {
    id: 'purpose_def_1',
    organizationId: FIXTURE_ORGANIZATION_ID,
    purposeKey: FIXTURE_PURPOSE_KEY,
    version: 1,
    description: FIXTURE_DESCRIPTION,
    disclosureScope: FIXTURE_DISCLOSURE_SCOPE_NARROW,
    createdAt: now,
    deactivatedAt: null,
    ...overrides,
  };
}

/**
 * Create a fixture PurposeDeclaration in PENDING state
 */
export function createFixturePurposeDeclarationPending(
  overrides?: Partial<PurposeDeclaration>,
): PurposeDeclaration {
  const now = new Date();
  const expiryDate = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days from now
  return {
    id: 'declaration_1',
    organizationId: FIXTURE_ORGANIZATION_ID,
    purposeDefinitionId: 'purpose_def_1',
    verifierOrganizationId: FIXTURE_VERIFIER_ORG_ID,
    approvalState: 'PENDING' as PurposeDeclarationApprovalState,
    approvedAt: null,
    approvedById: null,
    revokedAt: null,
    revokedById: null,
    expiresAt: expiryDate,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Create a fixture PurposeDeclaration in APPROVED state
 */
export function createFixturePurposeDeclarationApproved(
  overrides?: Partial<PurposeDeclaration>,
): PurposeDeclaration {
  const now = new Date();
  const expiryDate = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  return {
    id: 'declaration_2',
    organizationId: FIXTURE_ORGANIZATION_ID,
    purposeDefinitionId: 'purpose_def_1',
    verifierOrganizationId: FIXTURE_VERIFIER_ORG_ID,
    approvalState: 'APPROVED' as PurposeDeclarationApprovalState,
    approvedAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
    approvedById: FIXTURE_APPROVER_ID,
    revokedAt: null,
    revokedById: null,
    expiresAt: expiryDate,
    revision: 2,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Create a fixture PurposeDeclaration in REVOKED state
 */
export function createFixturePurposeDeclarationRevoked(
  overrides?: Partial<PurposeDeclaration>,
): PurposeDeclaration {
  const now = new Date();
  const expiryDate = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  return {
    id: 'declaration_3',
    organizationId: FIXTURE_ORGANIZATION_ID,
    purposeDefinitionId: 'purpose_def_1',
    verifierOrganizationId: FIXTURE_VERIFIER_ORG_ID,
    approvalState: 'REVOKED' as PurposeDeclarationApprovalState,
    approvedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
    approvedById: FIXTURE_APPROVER_ID,
    revokedAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
    revokedById: FIXTURE_REVOKER_ID,
    expiresAt: expiryDate,
    revision: 3,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Create a fixture PurposeDeclaration in EXPIRED state (expiry in past)
 */
export function createFixturePurposeDeclarationExpired(
  overrides?: Partial<PurposeDeclaration>,
): PurposeDeclaration {
  const now = new Date();
  const expiryDate = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day ago
  return {
    id: 'declaration_4',
    organizationId: FIXTURE_ORGANIZATION_ID,
    purposeDefinitionId: 'purpose_def_1',
    verifierOrganizationId: FIXTURE_VERIFIER_ORG_ID,
    approvalState: 'APPROVED' as PurposeDeclarationApprovalState,
    approvedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
    approvedById: FIXTURE_APPROVER_ID,
    revokedAt: null,
    revokedById: null,
    expiresAt: expiryDate,
    revision: 2,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Create a fixture PurposeDeclaration with wrong organization
 */
export function createFixturePurposeDeclarationWrongOrg(
  overrides?: Partial<PurposeDeclaration>,
): PurposeDeclaration {
  const fixture = createFixturePurposeDeclarationApproved();
  return {
    ...fixture,
    organizationId: 'org_wrong',
    ...overrides,
  };
}

/**
 * Create a fixture PurposeDeclaration with wrong verifier organization
 */
export function createFixturePurposeDeclarationWrongVerifier(
  overrides?: Partial<PurposeDeclaration>,
): PurposeDeclaration {
  const fixture = createFixturePurposeDeclarationApproved();
  return {
    ...fixture,
    verifierOrganizationId: 'org_wrong_verifier',
    ...overrides,
  };
}
