/**
 * Integration point for purpose enforcement into ProofsService.verifyProof()
 *
 * This file documents where purpose enforcement should be integrated into the
 * verification flow. Purpose enforcement is an ADDITIONAL gate that runs
 * AFTER credential validation but BEFORE the verification result is returned.
 *
 * IMPORTANT: Purpose enforcement never replaces or reorders existing authorization
 * checks. Privacy budgets and abuse controls still run unchanged and unconditionally.
 *
 * Flow:
 * 1. Abuse checks (existing - unchanged)
 * 2. Load proof (existing - unchanged)
 * 3. Credential validation (existing - unchanged)
 * 4. Contract anchoring check (existing - unchanged)
 * 5. ** PURPOSE ENFORCEMENT (NEW - additional gate)
 * 6. Record verification event (existing - now includes declaration ID/version)
 * 7. Return result
 */

/**
 * STEP 1: Add PurposeEnforcementService to constructor injection
 *
 * In ProofsService.constructor(), add:
 *
 *   @Optional() @Inject(PurposeEnforcementService) p11?: any,
 *
 * And in the service detection loop, add:
 *
 *   } else if (typeof candidate.enforceVerificationPurpose === "function") {
 *     this.purposeEnforcementService = candidate;
 *   }
 *
 * Initialize as optional:
 *
 *   private purposeEnforcementService?: PurposeEnforcementService;
 */

/**
 * STEP 2: Modify verifyProof to add purpose enforcement gate
 *
 * After contract anchoring check (line ~2829) and before event recording (line ~2832),
 * add this enforcement block:
 *
 * ```typescript
 * // Purpose enforcement: additional gate (fail closed if policy requires it)
 * // This is an additional gate only; it never replaces existing authorization.
 * let declarationId: string | null = null;
 * let declarationVersion: number | null = null;
 *
 * const purposeEnforcementContext = {
 *   organizationId: proof.user?.organizationId ?? 'unknown',
 *   verifierOrganizationId: proof.user?.organizationId ?? 'unknown',
 *   policyRequiresPurposeDeclaration: false, // TODO: load from policy
 *   policyDisclosureScope: undefined,
 * };
 *
 * if (this.purposeEnforcementService && result === VerificationResult.VALID) {
 *   const enforceResult = await this.purposeEnforcementService.enforceVerificationPurpose(
 *     purposeEnforcementContext,
 *   );
 *
 *   if (!enforceResult.isValid) {
 *     result = VerificationResult.INVALID_SIGNATURE; // Fail closed
 *     // TODO: return new error code in VerificationResult enum
 *     // E.g., DECLARATION_NOT_FOUND, DECLARATION_EXPIRED, etc.
 *   } else {
 *     // Valid declaration: record for audit trail
 *     declarationId = enforceResult.declaration?.id ?? null;
 *     declarationVersion = enforceResult.declarationVersion ?? null;
 *   }
 * }
 * ```
 *
 * THEN, when recording verification event (line ~2844), include declaration context:
 *
 * ```typescript
 * await this.prisma.verificationEvent.create({
 *   data: {
 *     proofId: proof.id,
 *     result,
 *     declarationId,
 *     declarationVersion,
 *   },
 * });
 * ```
 */

/**
 * STEP 3: Load VerificationPolicy to determine if purpose is required
 *
 * Before purpose enforcement, load the policy for this verification:
 *
 * ```typescript
 * // Load verification policy (if one is configured for this organization)
 * const policy = await this.prisma.verificationPolicy.findFirst({
 *   where: {
 *     organizationId: proof.user?.organizationId,
 *     status: ResourceStatus.ACTIVE,
 *   },
 * });
 *
 * purposeEnforcementContext.policyRequiresPurposeDeclaration = policy?.requiresPurposeDeclaration ?? false;
 * purposeEnforcementContext.policyDisclosureScope = policy?.config?.disclosureScope;
 * ```
 */

/**
 * STEP 4: Update ProofsModule to export PurposeEnforcementService
 *
 * Already done in proofs.module.ts - PurposeEnforcementService is exported.
 */

/**
 * DETERMINISTIC BEHAVIOR RULES (implemented in services, verified by tests)
 *
 * 1. Expiry Boundary:
 *    - A declaration is valid only if now() < expiresAt (strictly before expiry)
 *    - At the expiry instant, the declaration is no longer valid
 *    - Test: boundary conditions at expiry time
 *
 * 2. Stale State During Verification:
 *    - Verification evaluates declaration state once at request start
 *    - That state snapshot is recorded in the audit entry (declarationId, declarationVersion)
 *    - If a declaration is revoked/expires mid-flight, the in-flight verification uses the
 *      state captured at request start
 *    - Test: verify that concurrent revoke doesn't affect in-flight verification
 *
 * 3. Replay Idempotency:
 *    - Repeated approval/revoke requests are idempotent via requestFingerprint
 *    - Same request (fingerprint) submitted twice returns success with same result
 *    - Test: approve twice with same reason, verify second returns 200 OK
 *
 * 4. Concurrency (Optimistic Concurrency):
 *    - Simultaneous approve and revoke race on revision field
 *    - UPDATE WHERE revision = ? ensures only one winner
 *    - Loser sees revision mismatch and must retry or fail
 *    - Exactly one succeeds; no torn state
 *    - Test: concurrent approve and revoke, verify only one succeeds
 *
 * 5. Hard Invariants (enforced structurally):
 *    - A purpose cannot expand disclosure beyond policy and credential holder's consent
 *      (scope validation in validateDeclarationForVerification)
 *    - A purpose cannot authorize access by itself (declared in purpose-enforcement.service.ts)
 *    - A purpose cannot bypass/reduce privacy budgets, rate limits, abuse controls
 *      (these run before and after purpose enforcement, independently)
 *    - Tests: verify scope narrowing, verify authorization checks still run, verify quotas applied
 */

export const STEP_1_CONSTRUCTOR = `
Add to ProofsService constructor and inject detection:

@Optional() @Inject(PurposeEnforcementService) p11?: any,

Detection loop (line ~426):
  } else if (typeof candidate.enforceVerificationPurpose === "function") {
    this.purposeEnforcementService = candidate;
  }

Initialization (line ~440):
  private purposeEnforcementService?: PurposeEnforcementService;
`;

export const STEP_2_ENFORCEMENT = `
Add purpose enforcement gate after contract check (line ~2829), before event recording:

// Purpose enforcement: additional gate (fail closed if policy requires it)
let declarationId: string | null = null;
let declarationVersion: number | null = null;

const purposeEnforcementContext = {
  organizationId: proof.user?.organizationId ?? 'unknown',
  verifierOrganizationId: proof.user?.organizationId ?? 'unknown',
  policyRequiresPurposeDeclaration: false,
  policyDisclosureScope: undefined,
};

if (this.purposeEnforcementService && result === VerificationResult.VALID) {
  const enforceResult = await this.purposeEnforcementService.enforceVerificationPurpose(
    purposeEnforcementContext,
  );

  if (!enforceResult.isValid) {
    result = VerificationResult.INVALID_SIGNATURE;
  } else {
    declarationId = enforceResult.declaration?.id ?? null;
    declarationVersion = enforceResult.declarationVersion ?? null;
  }
}
`;

export const STEP_3_POLICY_LOAD = `
Before purpose enforcement, load policy:

const policy = await this.prisma.verificationPolicy.findFirst({
  where: {
    organizationId: proof.user?.organizationId,
    status: ResourceStatus.ACTIVE,
  },
});

purposeEnforcementContext.policyRequiresPurposeDeclaration = policy?.requiresPurposeDeclaration ?? false;
purposeEnforcementContext.policyDisclosureScope = policy?.config?.disclosureScope;
`;

export const STEP_4_EVENT_RECORDING = `
Update event recording to include declaration context (line ~2844):

await this.prisma.verificationEvent.create({
  data: {
    proofId: proof.id,
    result,
    declarationId,
    declarationVersion,
  },
});
`;
