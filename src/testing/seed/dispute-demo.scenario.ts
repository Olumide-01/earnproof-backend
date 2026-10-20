import { PrismaClient } from "@prisma/client";
import { DisputeStatus, DisputeCategory, ResourceStatus } from "@prisma/client";

/**
 * Dispute Demo Scenario
 * 
 * Idempotent setup for testing dispute notification workflows.
 * Creates:
 * - Demo organization
 * - Demo users (owner, submitter, reviewer, admin)
 * - Demo proofs
 * - Disputes in various states
 * - Associated audit logs
 * 
 * Safe to run multiple times; uses upserts with deterministic IDs.
 */

export interface DisputeDemoScenarioOptions {
  organizationName?: string;
  skipNotificationEvents?: boolean;
}

export async function applySyntheticDisputeDemoScenario(
  prisma: PrismaClient,
  options: DisputeDemoScenarioOptions = {}
): Promise<{ organizationId: string; proofIds: string[]; disputeIds: string[] }> {
  const orgName = options.organizationName || "Demo Org - Disputes";

  // Step 1: Create organization
  const organization = await prisma.organization.upsert({
    where: { name: orgName },
    update: {},
    create: {
      id: `org_demo_disputes_${Date.now()}`,
      name: orgName,
      status: ResourceStatus.ACTIVE,
      createdAt: new Date(),
    },
  });

  const organizationId = organization.id;

  // Step 2: Create demo users
  const ownerUser = await prisma.user.upsert({
    where: { email: "demo-proof-owner@example.com" },
    update: {},
    create: {
      id: `user_demo_owner_disputes`,
      email: "demo-proof-owner@example.com",
      name: "Demo Proof Owner",
      status: ResourceStatus.ACTIVE,
    },
  });

  const submitterUser = await prisma.user.upsert({
    where: { email: "demo-dispute-submitter@example.com" },
    update: {},
    create: {
      id: `user_demo_submitter_disputes`,
      email: "demo-dispute-submitter@example.com",
      name: "Demo Dispute Submitter",
      status: ResourceStatus.ACTIVE,
    },
  });

  const reviewerUser = await prisma.user.upsert({
    where: { email: "demo-dispute-reviewer@example.com" },
    update: {},
    create: {
      id: `user_demo_reviewer_disputes`,
      email: "demo-dispute-reviewer@example.com",
      name: "Demo Dispute Reviewer",
      status: ResourceStatus.ACTIVE,
    },
  });

  const adminUser = await prisma.user.upsert({
    where: { email: "demo-admin-disputes@example.com" },
    update: {},
    create: {
      id: `user_demo_admin_disputes`,
      email: "demo-admin-disputes@example.com",
      name: "Demo Admin",
      status: ResourceStatus.ACTIVE,
    },
  });

  // Step 3: Add users to organization
  await prisma.organizationMember.upsert({
    where: {
      organizationId_userId: {
        organizationId,
        userId: ownerUser.id,
      },
    },
    update: { status: "ACTIVE" },
    create: {
      organizationId,
      userId: ownerUser.id,
      status: "ACTIVE",
    },
  });

  await prisma.organizationMember.upsert({
    where: {
      organizationId_userId: {
        organizationId,
        userId: submitterUser.id,
      },
    },
    update: { status: "ACTIVE" },
    create: {
      organizationId,
      userId: submitterUser.id,
      status: "ACTIVE",
    },
  });

  await prisma.organizationMember.upsert({
    where: {
      organizationId_userId: {
        organizationId,
        userId: reviewerUser.id,
      },
    },
    update: { status: "ACTIVE" },
    create: {
      organizationId,
      userId: reviewerUser.id,
      status: "ACTIVE",
    },
  });

  await prisma.organizationMember.upsert({
    where: {
      organizationId_userId: {
        organizationId,
        userId: adminUser.id,
      },
    },
    update: { status: "ACTIVE" },
    create: {
      organizationId,
      userId: adminUser.id,
      status: "ACTIVE",
    },
  });

  // Step 4: Create demo proofs
  const proofIds: string[] = [];

  const proof1 = await prisma.proof.upsert({
    where: {
      id: `proof_demo_disputes_1`,
    },
    update: {},
    create: {
      id: `proof_demo_disputes_1`,
      userId: ownerUser.id,
      proofType: "EMPLOYMENT",
      status: ResourceStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      canonicalForm:
        "employment_canonical_form_demo_1_synth_deterministic_hash",
      claimHash:
        "sha256:0000000000000000000000000000000000000000000000000000000000000001",
      createdAt: new Date(),
    },
  });
  proofIds.push(proof1.id);

  const proof2 = await prisma.proof.upsert({
    where: {
      id: `proof_demo_disputes_2`,
    },
    update: {},
    create: {
      id: `proof_demo_disputes_2`,
      userId: ownerUser.id,
      proofType: "INCOME",
      status: ResourceStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      canonicalForm:
        "income_canonical_form_demo_2_synth_deterministic_hash",
      claimHash:
        "sha256:0000000000000000000000000000000000000000000000000000000000000002",
      createdAt: new Date(),
    },
  });
  proofIds.push(proof2.id);

  const proof3 = await prisma.proof.upsert({
    where: {
      id: `proof_demo_disputes_3`,
    },
    update: {},
    create: {
      id: `proof_demo_disputes_3`,
      userId: ownerUser.id,
      proofType: "EMPLOYMENT",
      status: ResourceStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      canonicalForm:
        "employment_canonical_form_demo_3_synth_deterministic_hash",
      claimHash:
        "sha256:0000000000000000000000000000000000000000000000000000000000000003",
      createdAt: new Date(),
    },
  });
  proofIds.push(proof3.id);

  const proof4 = await prisma.proof.upsert({
    where: {
      id: `proof_demo_disputes_4`,
    },
    update: {},
    create: {
      id: `proof_demo_disputes_4`,
      userId: ownerUser.id,
      proofType: "INCOME",
      status: ResourceStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      canonicalForm:
        "income_canonical_form_demo_4_synth_deterministic_hash",
      claimHash:
        "sha256:0000000000000000000000000000000000000000000000000000000000000004",
      createdAt: new Date(),
    },
  });
  proofIds.push(proof4.id);

  const proof5 = await prisma.proof.upsert({
    where: {
      id: `proof_demo_disputes_5`,
    },
    update: {},
    create: {
      id: `proof_demo_disputes_5`,
      userId: ownerUser.id,
      proofType: "EMPLOYMENT",
      status: ResourceStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      canonicalForm:
        "employment_canonical_form_demo_5_synth_deterministic_hash",
      claimHash:
        "sha256:0000000000000000000000000000000000000000000000000000000000000005",
      createdAt: new Date(),
    },
  });
  proofIds.push(proof5.id);

  // Step 5: Create disputes in various states
  const disputeIds: string[] = [];
  const now = new Date();

  // Dispute 1: OPEN
  const dispute1 = await prisma.proofDispute.upsert({
    where: {
      id: `disp_demo_disputes_1`,
    },
    update: {},
    create: {
      id: `disp_demo_disputes_1`,
      organizationId,
      proofId: proof1.id,
      category: DisputeCategory.ACCURACY,
      status: DisputeStatus.OPEN,
      evidenceCommitment:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      submittedBy: submitterUser.id,
      metadata: {
        testScenario: "demo_open_dispute",
      },
      submittedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000), // 2 days ago
    },
  });
  disputeIds.push(dispute1.id);

  // Dispute 2: ASSIGNED
  const dispute2 = await prisma.proofDispute.upsert({
    where: {
      id: `disp_demo_disputes_2`,
    },
    update: {},
    create: {
      id: `disp_demo_disputes_2`,
      organizationId,
      proofId: proof2.id,
      category: DisputeCategory.FRAUD,
      status: DisputeStatus.ASSIGNED,
      evidenceCommitment:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      submittedBy: submitterUser.id,
      assignedTo: reviewerUser.id,
      metadata: {
        testScenario: "demo_assigned_dispute",
      },
      submittedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000), // 1 day ago
      assignedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000), // 12 hours ago
    },
  });
  disputeIds.push(dispute2.id);

  // Dispute 3: RESOLVED (UPHELD)
  const dispute3 = await prisma.proofDispute.upsert({
    where: {
      id: `disp_demo_disputes_3`,
    },
    update: {},
    create: {
      id: `disp_demo_disputes_3`,
      organizationId,
      proofId: proof3.id,
      category: DisputeCategory.ACCURACY,
      status: DisputeStatus.RESOLVED,
      evidenceCommitment:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      submittedBy: submitterUser.id,
      assignedTo: reviewerUser.id,
      resolutionOutcome: "UPHELD",
      resolutionReason:
        "Proof data verified as accurate through issuer confirmation records",
      resolvedBy: reviewerUser.id,
      metadata: {
        testScenario: "demo_resolved_upheld_dispute",
      },
      submittedAt: new Date(now.getTime() - 72 * 60 * 60 * 1000), // 3 days ago
      assignedAt: new Date(now.getTime() - 60 * 60 * 60 * 1000), // 60 hours ago
      resolvedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000), // 12 hours ago
    },
  });
  disputeIds.push(dispute3.id);

  // Dispute 4: RESOLVED (REJECTED)
  const dispute4 = await prisma.proofDispute.upsert({
    where: {
      id: `disp_demo_disputes_4`,
    },
    update: {},
    create: {
      id: `disp_demo_disputes_4`,
      organizationId,
      proofId: proof4.id,
      category: DisputeCategory.FRAUD,
      status: DisputeStatus.RESOLVED,
      evidenceCommitment:
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      submittedBy: submitterUser.id,
      assignedTo: reviewerUser.id,
      resolutionOutcome: "REJECTED",
      resolutionReason:
        "Insufficient evidence provided; claim cannot be substantiated",
      resolvedBy: reviewerUser.id,
      metadata: {
        testScenario: "demo_resolved_rejected_dispute",
      },
      submittedAt: new Date(now.getTime() - 96 * 60 * 60 * 1000), // 4 days ago
      assignedAt: new Date(now.getTime() - 84 * 60 * 60 * 1000), // 84 hours ago
      resolvedAt: new Date(now.getTime() - 6 * 60 * 60 * 1000), // 6 hours ago
    },
  });
  disputeIds.push(dispute4.id);

  // Dispute 5: WITHDRAWN
  const dispute5 = await prisma.proofDispute.upsert({
    where: {
      id: `disp_demo_disputes_5`,
    },
    update: {},
    create: {
      id: `disp_demo_disputes_5`,
      organizationId,
      proofId: proof5.id,
      category: DisputeCategory.TECHNICAL,
      status: DisputeStatus.WITHDRAWN,
      evidenceCommitment:
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      submittedBy: submitterUser.id,
      metadata: {
        testScenario: "demo_withdrawn_dispute",
      },
      submittedAt: new Date(now.getTime() - 36 * 60 * 60 * 1000), // 36 hours ago
      withdrawnAt: new Date(now.getTime() - 24 * 60 * 60 * 1000), // 24 hours ago
    },
  });
  disputeIds.push(dispute5.id);

  // Step 6: Create audit logs for visibility
  const auditRecords = [
    {
      actorType: "User" as const,
      actorId: submitterUser.id,
      action: "DISPUTE_SUBMITTED",
      resourceType: "ProofDispute",
      resourceId: dispute1.id,
    },
    {
      actorType: "User" as const,
      actorId: adminUser.id,
      action: "DISPUTE_ASSIGNED",
      resourceType: "ProofDispute",
      resourceId: dispute2.id,
    },
    {
      actorType: "User" as const,
      actorId: reviewerUser.id,
      action: "DISPUTE_RESOLVED",
      resourceType: "ProofDispute",
      resourceId: dispute3.id,
    },
    {
      actorType: "User" as const,
      actorId: reviewerUser.id,
      action: "DISPUTE_RESOLVED",
      resourceType: "ProofDispute",
      resourceId: dispute4.id,
    },
    {
      actorType: "User" as const,
      actorId: submitterUser.id,
      action: "DISPUTE_WITHDRAWN",
      resourceType: "ProofDispute",
      resourceId: dispute5.id,
    },
  ];

  for (const audit of auditRecords) {
    await prisma.auditLog.create({
      data: {
        ...audit,
        metadata: {
          organizationId,
          testScenario: "demo_dispute",
        },
      },
    });
  }

  console.log(
    `[DisputeDemoScenario] Created demo dispute scenario in ${organizationId}`
  );
  console.log(
    `  - Organization: ${organization.name} (${organizationId})`
  );
  console.log(`  - Users: owner, submitter, reviewer, admin`);
  console.log(`  - Proofs: ${proofIds.length} synthetic proofs`);
  console.log(`  - Disputes: ${disputeIds.length} in various states`);
  console.log(`    - 1 OPEN (awaiting review)`);
  console.log(`    - 1 ASSIGNED (under review)`);
  console.log(`    - 1 RESOLVED (upheld)`);
  console.log(`    - 1 RESOLVED (rejected)`);
  console.log(`    - 1 WITHDRAWN`);

  return {
    organizationId,
    proofIds,
    disputeIds,
  };
}

/**
 * Clean up demo dispute scenario (for testing).
 */
export async function cleanupSyntheticDisputeDemoScenario(
  prisma: PrismaClient,
  organizationId: string
): Promise<void> {
  // Delete in dependency order
  await prisma.proofDispute.deleteMany({
    where: { organizationId },
  });

  await prisma.proof.deleteMany({
    where: {
      user: {
        organizationMemberships: {
          some: { organizationId },
        },
      },
    },
  });

  await prisma.organizationMember.deleteMany({
    where: { organizationId },
  });

  await prisma.organization.delete({
    where: { id: organizationId },
  });

  console.log(`[DisputeDemoScenario] Cleaned up demo scenario ${organizationId}`);
}
