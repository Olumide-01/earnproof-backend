/**
 * Versioned receipt data structure for schema v1.
 *
 * A canonical, deterministic receipt binding an approval decision to the exact
 * proposal, contract, network, role, and payload hash. The receipt is signed
 * using EdDSA/Ed25519 and includes explicit domain separation to prevent replay.
 */
export interface ApprovalIntentReceiptV1 {
  /** Type field for domain separation. Hardcoded to prevent replay across contexts. */
  type: "approval-intent-receipt";

  /** Explicit schema version for forward-compatible verification. */
  schemaVersion: "v1";

  /** Unique identifier for this approval decision (from ApprovalRequest). */
  approvalId: string;

  /** On-chain proposal identifier. */
  proposalId: string;

  /** On-chain contract identifier. */
  contractId: string;

  /** On-chain network identifier (e.g., "public", "testnet"). */
  network: string;

  /** Approver role (e.g., "ADMIN", "REVIEWER"). User's role at decision time. */
  role: string;

  /** Operation type (e.g., "organization.residency_policy.override"). */
  actionType: string;

  /** Canonical deterministic hash of the proposal payload. Format: "sha256:<hex>". */
  payloadHash: string;

  /** Approval outcome: APPROVED or REJECTED. Embedded for outcome binding. */
  decision: "APPROVED" | "REJECTED";

  /** Optional decision reason (if provided by approver). */
  reason?: string;

  /** Timestamp when the approval decision was recorded (UTC, ISO-8601). */
  decidedAt: string;

  /** Optional proposal expiry timestamp (UTC, ISO-8601) if applicable. */
  expiresAt?: string;
}
