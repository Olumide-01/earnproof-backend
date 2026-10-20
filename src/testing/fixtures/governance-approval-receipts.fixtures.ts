/**
 * Synthetic test fixtures for governance approval intent receipts.
 *
 * All fixtures contain only synthetic data: no secrets, wallet material,
 * private proof data, or production credentials.
 */

import { ApprovalRequestStatus, ProposalLifecycleState } from "@prisma/client";
import { ApprovalIntentReceiptV1 } from "../../governance/dto/approval-intent-receipt-v1.dto";
import { ReceiptVerificationKey } from "../../governance/dto/receipt-verification-key.dto";

/**
 * Fixture: Valid approval request (APPROVED status)
 */
export const fixtureApprovedApproval = {
  id: "approval-fixture-001",
  operationType: "organization.residency_policy.override",
  payloadHash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  payload: {
    organizationId: "org-fixture-001",
    allowedRegions: ["eu-west-1", "us-east-1"],
  },
  requestedById: "user-fixture-requester-001",
  status: ApprovalRequestStatus.APPROVED,
  decidedById: "user-fixture-approver-001",
  decidedAt: new Date("2026-10-18T12:00:00Z"),
  decisionReason: "Security compliance review",
  executionLeaseToken: null,
  executionLeasedAt: null,
  executedAt: null,
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  createdAt: new Date("2026-10-18T11:00:00Z"),
  updatedAt: new Date("2026-10-18T12:00:00Z"),
};

/**
 * Fixture: Pending approval request (not yet approved)
 */
export const fixturePendingApproval = {
  id: "approval-fixture-pending-001",
  operationType: "organization.residency_policy.override",
  payloadHash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  payload: {
    organizationId: "org-fixture-001",
    allowedRegions: ["eu-west-1"],
  },
  requestedById: "user-fixture-requester-001",
  status: ApprovalRequestStatus.PENDING,
  decidedById: null,
  decidedAt: null,
  decisionReason: null,
  executionLeaseToken: null,
  executionLeasedAt: null,
  executedAt: null,
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  createdAt: new Date("2026-10-18T11:00:00Z"),
  updatedAt: new Date("2026-10-18T11:00:00Z"),
};

/**
 * Fixture: Valid governance proposal (PROPOSED status)
 */
export const fixtureValidProposal = {
  id: "proposal-fixture-001",
  network: "public",
  contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  proposalId: "proposal-001",
  proposerAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  action: "organization.residency_policy.override",
  actionPayload: {
    organizationId: "org-fixture-001",
    allowedRegions: ["eu-west-1", "us-east-1"],
  },
  rawPayloadHash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  status: ProposalLifecycleState.PROPOSED,
  cooldownUntil: null,
  executedAt: null,
  cancelledAt: null,
  expiresAt: null,
  observedLedger: BigInt("12345"),
  observedAt: new Date("2026-10-18T11:00:00Z"),
  createdAt: new Date("2026-10-18T10:00:00Z"),
  updatedAt: new Date("2026-10-18T11:00:00Z"),
};

/**
 * Fixture: Proposal in terminal state (EXECUTED)
 */
export const fixtureExecutedProposal = {
  id: "proposal-fixture-executed-001",
  network: "public",
  contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  proposalId: "proposal-executed-001",
  proposerAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  action: "organization.residency_policy.override",
  actionPayload: { organizationId: "org-fixture-001" },
  rawPayloadHash: "sha256:abc123",
  status: ProposalLifecycleState.EXECUTED,
  cooldownUntil: null,
  executedAt: new Date("2026-10-18T12:00:00Z"),
  cancelledAt: null,
  expiresAt: null,
  observedLedger: BigInt("12346"),
  observedAt: new Date("2026-10-18T12:00:00Z"),
  createdAt: new Date("2026-10-18T10:00:00Z"),
  updatedAt: new Date("2026-10-18T12:00:00Z"),
};

/**
 * Fixture: Valid receipt data (v1)
 */
export const fixtureReceiptDataV1: ApprovalIntentReceiptV1 = {
  type: "approval-intent-receipt",
  schemaVersion: "v1",
  approvalId: "approval-fixture-001",
  proposalId: "proposal-001",
  contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  network: "public",
  role: "ADMIN",
  actionType: "organization.residency_policy.override",
  payloadHash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  decision: "APPROVED",
  reason: "Security compliance review",
  decidedAt: "2026-10-18T12:00:00Z",
  expiresAt: undefined,
};

/**
 * Fixture: Valid signed receipt
 */
export const fixtureSignedReceipt = {
  id: "receipt-fixture-001",
  approvalRequestId: "approval-fixture-001",
  schemaVersion: "v1",
  receiptData: fixtureReceiptDataV1,
  receiptHash: "sha256:def456789abcdef456789abcdef456789abcdef456789abcdef456789abc",
  signingKeyId: "earnproof-v0",
  signature: "ed25519:dGVzdC1zaWduYXR1cmUtdmFsdWU=",
  credentialHash: "sha256:def456789abcdef456789abcdef456789abcdef456789abcdef456789abc",
  issuedAt: new Date("2026-10-18T12:00:00Z"),
  createdAt: new Date("2026-10-18T12:00:01Z"),
  updatedAt: new Date("2026-10-18T12:00:01Z"),
};

/**
 * Fixture: Valid JWK Set with active and retired keys
 */
export const fixtureVerificationKeySet = {
  keys: [
    {
      alg: "EdDSA" as const,
      crv: "Ed25519" as const,
      kid: "earnproof-v0",
      kty: "OKP" as const,
      use: "sig" as const,
      status: "active" as const,
      x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    },
    {
      alg: "EdDSA" as const,
      crv: "Ed25519" as const,
      kid: "earnproof-v0-retired",
      kty: "OKP" as const,
      use: "sig" as const,
      status: "retired" as const,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      x: "22rbBYLxDsGWWvUAIOgBYKzCiNwgYQHPKKQDzIqrVWr",
    },
  ],
};

/**
 * Fixture: Rejected approval
 */
export const fixtureRejectedApproval = {
  id: "approval-fixture-rejected-001",
  operationType: "organization.residency_policy.override",
  payloadHash: "sha256:abc123",
  payload: { organizationId: "org-fixture-001" },
  requestedById: "user-fixture-requester-001",
  status: ApprovalRequestStatus.REJECTED,
  decidedById: "user-fixture-approver-001",
  decidedAt: new Date("2026-10-18T12:30:00Z"),
  decisionReason: "Policy conflict detected",
  executionLeaseToken: null,
  executionLeasedAt: null,
  executedAt: null,
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  createdAt: new Date("2026-10-18T11:00:00Z"),
  updatedAt: new Date("2026-10-18T12:30:00Z"),
};

/**
 * Fixture: Expired approval
 */
export const fixtureExpiredApproval = {
  id: "approval-fixture-expired-001",
  operationType: "organization.residency_policy.override",
  payloadHash: "sha256:abc123",
  payload: { organizationId: "org-fixture-001" },
  requestedById: "user-fixture-requester-001",
  status: ApprovalRequestStatus.EXPIRED,
  decidedById: null,
  decidedAt: null,
  decisionReason: null,
  executionLeaseToken: null,
  executionLeasedAt: null,
  executedAt: null,
  expiresAt: new Date(Date.now() - 1000), // Already expired
  createdAt: new Date("2026-10-16T11:00:00Z"),
  updatedAt: new Date("2026-10-18T00:00:00Z"),
};

/**
 * Fixture: Cancelled proposal
 */
export const fixtureCancelledProposal = {
  id: "proposal-fixture-cancelled-001",
  network: "public",
  contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  proposalId: "proposal-cancelled-001",
  proposerAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  action: "organization.residency_policy.override",
  actionPayload: { organizationId: "org-fixture-001" },
  rawPayloadHash: "sha256:abc123",
  status: ProposalLifecycleState.CANCELLED,
  cooldownUntil: null,
  executedAt: null,
  cancelledAt: new Date("2026-10-18T13:00:00Z"),
  expiresAt: null,
  observedLedger: BigInt("12347"),
  observedAt: new Date("2026-10-18T13:00:00Z"),
  createdAt: new Date("2026-10-18T10:00:00Z"),
  updatedAt: new Date("2026-10-18T13:00:00Z"),
};

/**
 * Fixture: Expired proposal
 */
export const fixtureExpiredProposalState = {
  id: "proposal-fixture-expired-state-001",
  network: "public",
  contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  proposalId: "proposal-expired-001",
  proposerAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  action: "organization.residency_policy.override",
  actionPayload: { organizationId: "org-fixture-001" },
  rawPayloadHash: "sha256:abc123",
  status: ProposalLifecycleState.EXPIRED,
  cooldownUntil: null,
  executedAt: null,
  cancelledAt: null,
  expiresAt: new Date(Date.now() - 1000),
  observedLedger: BigInt("12348"),
  observedAt: new Date(Date.now() - 500),
  createdAt: new Date("2026-10-18T10:00:00Z"),
  updatedAt: new Date(Date.now() - 500),
};

/**
 * Fixture: Concurrent approval scenario (two approvers on same request)
 */
export const fixtureConcurrentApprovalScenario = {
  approver1: {
    id: "user-fixture-approver-001",
    walletHash: "walletHash001",
    role: "ADMIN",
  },
  approver2: {
    id: "user-fixture-approver-002",
    walletHash: "walletHash002",
    role: "ADMIN",
  },
  approval: fixtureApprovedApproval,
};

/**
 * Helper: Create a receipt fixture for a given approval
 */
export function createReceiptForApproval(approval: any): any {
  return {
    id: `receipt-${approval.id}`,
    approvalRequestId: approval.id,
    schemaVersion: "v1",
    receiptData: {
      type: "approval-intent-receipt",
      schemaVersion: "v1",
      approvalId: approval.id,
      proposalId: "proposal-001",
      contractId: "CONTRACT123",
      network: "public",
      role: "ADMIN",
      actionType: approval.operationType,
      payloadHash: approval.payloadHash,
      decision: approval.status === ApprovalRequestStatus.APPROVED ? "APPROVED" : "REJECTED",
      reason: approval.decisionReason,
      decidedAt: approval.decidedAt?.toISOString() ?? new Date().toISOString(),
    },
    receiptHash: `sha256:${Math.random().toString(16).slice(2)}`,
    signingKeyId: "earnproof-v0",
    signature: `ed25519:${Buffer.from("test-signature").toString("base64url")}`,
    credentialHash: `sha256:${Math.random().toString(16).slice(2)}`,
    issuedAt: approval.decidedAt ?? new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Helper: Create an expired key fixture
 */
export function createExpiredKeyFixture(): ReceiptVerificationKey {
  return {
    alg: "EdDSA",
    crv: "Ed25519",
    kid: "earnproof-v0-expired",
    kty: "OKP",
    use: "sig",
    status: "retired",
    expiresAt: new Date(Date.now() - 1000).toISOString(), // Expired
    x: "expiredPublicKeyValue123",
  };
}

/**
 * Helper: Create a not-yet-expired key fixture
 */
export function createValidRetiredKeyFixture(): ReceiptVerificationKey {
  return {
    alg: "EdDSA",
    crv: "Ed25519",
    kid: "earnproof-v0-retired",
    kty: "OKP",
    use: "sig",
    status: "retired",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    x: "validRetiredPublicKeyValue123",
  };
}
