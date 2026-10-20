import { DisputeStatus, DisputeCategory } from "@prisma/client";
import { faker } from "@faker-js/faker";

/**
 * Dispute Factory
 * 
 * Generates synthetic, deterministic dispute data for testing.
 * All data is obviously fake to avoid confusion with production records.
 */

export interface CreateSyntheticDisputeInput {
  proofId?: string;
  organizationId?: string;
  submittedBy?: string;
  category?: DisputeCategory;
  status?: DisputeStatus;
  evidenceCommitment?: string;
  metadata?: Record<string, unknown>;
  assignedTo?: string | null;
  resolutionOutcome?: string | null;
  resolutionReason?: string | null;
  resolvedBy?: string | null;
}

export interface SyntheticDisputeData {
  id: string;
  proofId: string;
  organizationId: string;
  submittedBy: string;
  category: DisputeCategory;
  status: DisputeStatus;
  evidenceCommitment?: string;
  metadata: Record<string, unknown>;
  assignedTo: string | null;
  resolutionOutcome: string | null;
  resolutionReason: string | null;
  resolvedBy: string | null;
  submittedAt: Date;
  assignedAt: Date | null;
  resolvedAt: Date | null;
  withdrawnAt: Date | null;
}

/**
 * Generate deterministic synthetic dispute ID.
 * Format: dispute_synthetic_<hash>
 */
export function syntheticDisputeId(seed: string): string {
  const hash = Buffer.from(seed).toString("hex").substring(0, 12);
  return `dispute_synthetic_${hash}`;
}

/**
 * Generate synthetic evidence commitment (SHA-256 hash).
 * Privacy-safe format that looks obviously fake.
 */
export function syntheticEvidenceCommitment(seed: string): string {
  const hash = Buffer.from(`evidence_commitment_${seed}`)
    .toString("hex")
    .padEnd(64, "a");
  return `sha256:${hash.substring(0, 64)}`;
}

/**
 * Generate a complete synthetic dispute record.
 */
export function createSyntheticDispute(
  input: CreateSyntheticDisputeInput = {}
): SyntheticDisputeData {
  const id = input.proofId ? syntheticDisputeId(input.proofId) : syntheticDisputeId(faker.string.uuid());
  const proofId = input.proofId || `proof_synthetic_${faker.string.uuid().substring(0, 8)}`;
  const organizationId = input.organizationId || `org_synthetic_${faker.string.uuid().substring(0, 8)}`;
  const submittedBy = input.submittedBy || `user_synthetic_${faker.string.uuid().substring(0, 8)}`;
  const status = input.status || DisputeStatus.OPEN;
  const category = input.category || DisputeCategory.ACCURACY;

  const submittedAt = new Date();
  const assignedAt =
    status === DisputeStatus.OPEN || status === DisputeStatus.WITHDRAWN
      ? null
      : new Date(submittedAt.getTime() + 3600000); // 1 hour later

  const resolvedAt =
    status !== DisputeStatus.RESOLVED ? null : new Date((assignedAt || submittedAt).getTime() + 7200000); // 2 hours later

  const withdrawnAt =
    status !== DisputeStatus.WITHDRAWN ? null : new Date(submittedAt.getTime() + 1800000); // 30 mins later

  return {
    id,
    proofId,
    organizationId,
    submittedBy,
    category,
    status,
    evidenceCommitment:
      input.evidenceCommitment || syntheticEvidenceCommitment(proofId),
    metadata: input.metadata || {
      source: "test",
      testScenario: "synthetic_dispute",
    },
    assignedTo: input.assignedTo || null,
    resolutionOutcome: input.resolutionOutcome || null,
    resolutionReason: input.resolutionReason || null,
    resolvedBy: input.resolvedBy || null,
    submittedAt,
    assignedAt,
    resolvedAt,
    withdrawnAt,
  };
}

/**
 * Generate a dispute in OPEN status (just filed).
 */
export function createSyntheticOpenDispute(
  proofId: string,
  organizationId: string,
  submittedBy: string,
  category: DisputeCategory = DisputeCategory.ACCURACY
): SyntheticDisputeData {
  return createSyntheticDispute({
    proofId,
    organizationId,
    submittedBy,
    category,
    status: DisputeStatus.OPEN,
  });
}

/**
 * Generate a dispute in ASSIGNED status.
 */
export function createSyntheticAssignedDispute(
  proofId: string,
  organizationId: string,
  submittedBy: string,
  assignedTo: string,
  category: DisputeCategory = DisputeCategory.ACCURACY
): SyntheticDisputeData {
  return createSyntheticDispute({
    proofId,
    organizationId,
    submittedBy,
    category,
    status: DisputeStatus.ASSIGNED,
    assignedTo,
  });
}

/**
 * Generate a dispute in RESOLVED status with outcome.
 */
export function createSyntheticResolvedDispute(
  proofId: string,
  organizationId: string,
  submittedBy: string,
  assignedTo: string,
  outcome: "UPHELD" | "REJECTED" | "INCONCLUSIVE" = "UPHELD",
  reason: string = "Dispute resolved through review process",
  resolvedBy: string = assignedTo,
  category: DisputeCategory = DisputeCategory.ACCURACY
): SyntheticDisputeData {
  return createSyntheticDispute({
    proofId,
    organizationId,
    submittedBy,
    category,
    status: DisputeStatus.RESOLVED,
    assignedTo,
    resolutionOutcome: outcome,
    resolutionReason: reason,
    resolvedBy,
  });
}

/**
 * Generate a dispute in WITHDRAWN status.
 */
export function createSyntheticWithdrawnDispute(
  proofId: string,
  organizationId: string,
  submittedBy: string,
  category: DisputeCategory = DisputeCategory.ACCURACY
): SyntheticDisputeData {
  return createSyntheticDispute({
    proofId,
    organizationId,
    submittedBy,
    category,
    status: DisputeStatus.WITHDRAWN,
  });
}

/**
 * Generate a batch of disputes in different states for testing.
 */
export function createSyntheticDisputeBatch(
  organizationId: string
): {
  open: SyntheticDisputeData;
  assigned: SyntheticDisputeData;
  resolvedUpheld: SyntheticDisputeData;
  resolvedRejected: SyntheticDisputeData;
  withdrawn: SyntheticDisputeData;
} {
  const owner = `user_owner_${faker.string.uuid().substring(0, 8)}`;
  const submitter = `user_submitter_${faker.string.uuid().substring(0, 8)}`;
  const reviewer = `user_reviewer_${faker.string.uuid().substring(0, 8)}`;

  return {
    open: createSyntheticOpenDispute(
      `proof_open_${faker.string.uuid().substring(0, 8)}`,
      organizationId,
      submitter,
      DisputeCategory.ACCURACY
    ),
    assigned: createSyntheticAssignedDispute(
      `proof_assigned_${faker.string.uuid().substring(0, 8)}`,
      organizationId,
      submitter,
      reviewer,
      DisputeCategory.FRAUD
    ),
    resolvedUpheld: createSyntheticResolvedDispute(
      `proof_resolved_upheld_${faker.string.uuid().substring(0, 8)}`,
      organizationId,
      submitter,
      reviewer,
      "UPHELD",
      "Proof data verified against issuer records and found authentic",
      reviewer,
      DisputeCategory.ACCURACY
    ),
    resolvedRejected: createSyntheticResolvedDispute(
      `proof_resolved_rejected_${faker.string.uuid().substring(0, 8)}`,
      organizationId,
      submitter,
      reviewer,
      "REJECTED",
      "Insufficient evidence provided to support the claim",
      reviewer,
      DisputeCategory.FRAUD
    ),
    withdrawn: createSyntheticWithdrawnDispute(
      `proof_withdrawn_${faker.string.uuid().substring(0, 8)}`,
      organizationId,
      submitter,
      DisputeCategory.TECHNICAL
    ),
  };
}

/**
 * Scenario: Common dispute notification test cases
 */
export interface DisputeNotificationScenario {
  name: string;
  dispute: SyntheticDisputeData;
  proofOwnerId: string;
  expectedNotificationCount: number;
  expectedParticipants: {
    proofOwner: boolean;
    submitter: boolean;
    reviewer: boolean;
    orgWide: boolean;
  };
}

/**
 * Generate common dispute notification test scenarios.
 */
export function createDisputeNotificationScenarios(
  organizationId: string
): DisputeNotificationScenario[] {
  const owner1 = `owner_${faker.string.uuid().substring(0, 8)}`;
  const submitter1 = `submitter_${faker.string.uuid().substring(0, 8)}`;
  const reviewer1 = `reviewer_${faker.string.uuid().substring(0, 8)}`;

  return [
    {
      name: "Open dispute filed",
      dispute: createSyntheticOpenDispute(
        `proof_scenario_1_${faker.string.uuid().substring(0, 8)}`,
        organizationId,
        submitter1,
        DisputeCategory.ACCURACY
      ),
      proofOwnerId: owner1,
      expectedNotificationCount: 3, // owner, submitter, org-wide
      expectedParticipants: {
        proofOwner: true,
        submitter: true,
        reviewer: false,
        orgWide: true,
      },
    },
    {
      name: "Dispute assigned to reviewer",
      dispute: createSyntheticAssignedDispute(
        `proof_scenario_2_${faker.string.uuid().substring(0, 8)}`,
        organizationId,
        submitter1,
        reviewer1,
        DisputeCategory.FRAUD
      ),
      proofOwnerId: owner1,
      expectedNotificationCount: 4, // owner, submitter, reviewer, org-wide
      expectedParticipants: {
        proofOwner: true,
        submitter: true,
        reviewer: true,
        orgWide: true,
      },
    },
    {
      name: "Dispute resolved - UPHELD",
      dispute: createSyntheticResolvedDispute(
        `proof_scenario_3_${faker.string.uuid().substring(0, 8)}`,
        organizationId,
        submitter1,
        reviewer1,
        "UPHELD",
        "Proof verified as authentic through issuer confirmation",
        reviewer1,
        DisputeCategory.ACCURACY
      ),
      proofOwnerId: owner1,
      expectedNotificationCount: 4, // owner, submitter, reviewer, org-wide
      expectedParticipants: {
        proofOwner: true,
        submitter: true,
        reviewer: true,
        orgWide: true,
      },
    },
    {
      name: "Dispute resolved - REJECTED",
      dispute: createSyntheticResolvedDispute(
        `proof_scenario_4_${faker.string.uuid().substring(0, 8)}`,
        organizationId,
        submitter1,
        reviewer1,
        "REJECTED",
        "Evidence commitment hash does not match provided evidence",
        reviewer1,
        DisputeCategory.FRAUD
      ),
      proofOwnerId: owner1,
      expectedNotificationCount: 4,
      expectedParticipants: {
        proofOwner: true,
        submitter: true,
        reviewer: true,
        orgWide: true,
      },
    },
    {
      name: "Dispute withdrawn by submitter",
      dispute: createSyntheticWithdrawnDispute(
        `proof_scenario_5_${faker.string.uuid().substring(0, 8)}`,
        organizationId,
        submitter1,
        DisputeCategory.TECHNICAL
      ),
      proofOwnerId: owner1,
      expectedNotificationCount: 3, // owner, submitter, org-wide (no reviewer)
      expectedParticipants: {
        proofOwner: true,
        submitter: true,
        reviewer: false,
        orgWide: true,
      },
    },
    {
      name: "Proof owner is also dispute submitter",
      dispute: createSyntheticResolvedDispute(
        `proof_scenario_6_${faker.string.uuid().substring(0, 8)}`,
        organizationId,
        owner1, // Same person as owner
        reviewer1,
        "UPHELD",
        "Self-dispute resolved",
        reviewer1,
        DisputeCategory.COMPLIANCE
      ),
      proofOwnerId: owner1,
      expectedNotificationCount: 3, // combined owner+submitter, reviewer, org-wide
      expectedParticipants: {
        proofOwner: true,
        submitter: false, // deduplicated with owner
        reviewer: true,
        orgWide: true,
      },
    },
  ];
}

/**
 * Privacy test scenario: verify no sensitive data leaks.
 */
export interface PrivacyTestScenario {
  name: string;
  dispute: SyntheticDisputeData;
  metadata: Record<string, unknown>;
  shouldNotAppear: string[];
}

/**
 * Generate privacy test scenarios.
 */
export function createPrivacyTestScenarios(): PrivacyTestScenario[] {
  return [
    {
      name: "Dispute with employment claims should not leak salary",
      dispute: createSyntheticOpenDispute(
        "proof_employment",
        "org_privacy_1",
        "submitter_1",
        DisputeCategory.ACCURACY
      ),
      metadata: {
        proofClaims: {
          salary: 150000,
          employer: "ACME Corp",
          startDate: "2020-01-01",
        },
      },
      shouldNotAppear: ["150000", "ACME", "salary", "employer"],
    },
    {
      name: "Dispute with issuer secrets should not be included",
      dispute: createSyntheticResolvedDispute(
        "proof_issuer_secret",
        "org_privacy_2",
        "submitter_2",
        "reviewer_2",
        "UPHELD",
        "Issue resolved",
        "reviewer_2"
      ),
      metadata: {
        issuerPrivateKey:
          "SBDJMKEKFIFKWOKFWOKFOWKFOWKFOWKFOWKFOWKFOWKFOWKFOWKFOWK",
        issuerSecret: "super_secret_value",
      },
      shouldNotAppear: [
        "SBDJMKEKFIFKWOKFWOKFOWKFOWKFOWKFOWKFOWKFOWKFOWKFOWKFOWK",
        "super_secret_value",
      ],
    },
    {
      name: "Dispute with credential hashes should not be leaked",
      dispute: createSyntheticOpenDispute(
        "proof_credential",
        "org_privacy_3",
        "submitter_3",
        DisputeCategory.TECHNICAL
      ),
      metadata: {
        credentialHash:
          "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        claimHash:
          "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      },
      shouldNotAppear: [
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      ],
    },
  ];
}
