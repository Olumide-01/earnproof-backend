/**
 * Contract successor migration readiness assessment types.
 *
 * These types model the versioned readiness assessment for contract successor
 * activation. The assessment is deterministic, immutable once computed, and
 * blocked by any finding that cannot be individually acknowledged.
 *
 * Design principles:
 * - Successor identity is network-bound (network + contractId pair)
 * - Stale or incomplete assessments cannot mark migration ready
 * - All findings are explicit and time-bounded (via acknowledgements)
 * - Failure, replay, concurrency, and authorization are deterministic
 */

/**
 * Classification of a contract readiness finding.
 *
 * - "blocking": migration cannot proceed until finding is resolved or acknowledged
 * - "advisory": migration can proceed, but findings should be reviewed
 * - "informational": observations for audit trail, no action required
 */
export type SuccessorFindingSeverity = "blocking" | "advisory" | "informational";

/**
 * A single readiness finding for a successor contract.
 * Safe to expose publicly: never contains secrets, addresses, or raw values.
 */
export interface SuccessorFinding {
  /** Unique key for this finding type (e.g., "schema_version_verified", "successor_not_live") */
  key: string;
  severity: SuccessorFindingSeverity;
  /** Operator-readable description. Never contains secrets or raw configuration values. */
  description: string;
  /** True when an active, non-expired acknowledgement exists for this key. */
  acknowledged: boolean;
  /** Observed value or null if not applicable. Non-identifying safe value only. */
  observedValue?: string;
}

/**
 * Identity of a contract on a specific network.
 * Used to look up and verify successor contracts.
 */
export interface ContractIdentity {
  network: string;
  contractId: string;
  /** SchemaVersion from configuration. Must match live contract state to mark ready. */
  expectedVersion: number;
}

/**
 * Checkpoint tracking for migration progress.
 * Immutable once created; tracks when validations were performed.
 */
export interface MigrationCheckpoint {
  /** ISO-8601 timestamp of when this checkpoint was created */
  createdAt: string;
  /** Ledger sequence observed during checkpoint validation */
  observedLedger: bigint;
  /** Which validation gates were passed (e.g., ["schema_verified", "pause_state_synced"]) */
  passedGates: string[];
  /** Which validation gates failed (e.g., ["schema_version_mismatch"]) */
  failedGates: string[];
}

/**
 * Readiness verdict for a successor contract.
 * This is the main output of the successor migration readiness assessment.
 *
 * Ready iff:
 * 1. All blocking findings are acknowledged (or absent)
 * 2. Live contract identity matches expected (network, contractId, schemaVersion)
 * 3. Assessment is recent (not older than the configured staleness threshold)
 * 4. Pause state is compatible with migration intent
 */
export interface ContractSuccessorReadinessDto {
  /** network + contractId of the successor contract being assessed */
  successor: ContractIdentity;
  /** Readiness verdict: "ready" | "not_ready" */
  status: "ready" | "not_ready";
  /** Reason if not ready. Omitted when status is "ready". */
  reason?: string;
  /** All findings detected during assessment (blocking, advisory, informational) */
  findings: SuccessorFinding[];
  /** Overall severity: worst unacknowledged severity, or "none" when clean */
  overall: SuccessorFindingSeverity | "none";
  /** True when this result was served from cache */
  cached: boolean;
  /** Age of cached result in milliseconds. Omitted if freshly computed. */
  ageMs?: number;
  /** When the assessment was performed (ISO-8601) */
  assessedAt: string;
  /** Checkpoint of most recent passed validation gate */
  latestCheckpoint: MigrationCheckpoint | null;
}

/**
 * Input to acknowledge a successor readiness finding.
 * Acknowledgements are stored with bounded TTL (max 7 days).
 */
export interface AcknowledgeSuccessorFindingInput {
  /** The finding key to acknowledge (e.g., "schema_version_mismatch") */
  findingKey: string;
  /** ActorId from audit system (never raw PII) */
  acknowledgedBy: string;
  /** Human-readable reason for acknowledgement (for audit trail) */
  note: string;
  /** How long the acknowledgement is valid (seconds). Max 7 days. */
  ttlSeconds: number;
}

/**
 * Authorization context for successor migration operations.
 * Must include ORG_ADMIN scope or equivalent.
 */
export interface SuccessorMigrationAuthorization {
  actorId: string;
  scope: "ORG_ADMIN" | "ADMIN";
  organizationId?: string;
}

/**
 * Result of a successor readiness assessment check.
 * Used internally by the service; exposed via DTO.
 */
export interface SuccessorReadinessCheckResult {
  successor: ContractIdentity;
  findings: SuccessorFinding[];
  checkpoint: MigrationCheckpoint;
  isReady: boolean;
  readinessReason: string | null;
}

/**
 * Pause state compatibility check result.
 * Verifies that successor pause state is compatible with migration.
 */
export interface PauseStateCompatibility {
  successorIsPaused: boolean;
  predecessorIsPaused: boolean | null;
  compatible: boolean;
  reason: string;
}

/**
 * Compatibility matrix for contract successor activation.
 * Tracks predecessor → successor readiness across multiple dimensions.
 */
export interface ContractSuccessorCompatibility {
  predecessor: ContractIdentity;
  successor: ContractIdentity;
  /** Schema version compatibility */
  schemaCompatible: boolean;
  /** Pause state compatibility */
  pauseStateCompatible: boolean;
  /** Checkpoint state can migrate without data loss */
  checkpointMigrationSafe: boolean;
  /** No replayed/reordered ledger entries detected */
  ledgerMonotonicityVerified: boolean;
  /** All findings acknowledged or absent */
  readinessComplete: boolean;
  /** When last verified (ISO-8601) */
  verifiedAt: string;
}

/**
 * Deterministic status codes for successor readiness checks.
 * Used in error messages instead of raw error strings.
 */
export const SuccessorReadinessStatusCode = {
  /** Successor contract not found or network unreachable */
  SUCCESSOR_NOT_FOUND: "successor_not_found",
  /** Live contract identity does not match expected */
  IDENTITY_MISMATCH: "identity_mismatch",
  /** Schema version on contract differs from backend config */
  SCHEMA_VERSION_MISMATCH: "schema_version_mismatch",
  /** Live contract is paused, migration blocked */
  SUCCESSOR_PAUSED: "successor_paused",
  /** Pause state incompatible with migration intent */
  PAUSE_STATE_INCOMPATIBLE: "pause_state_incompatible",
  /** Migration checkpoint is stale or incomplete */
  STALE_CHECKPOINT: "stale_checkpoint",
  /** Ledger reorg detected, monotonicity violated */
  LEDGER_REORG_DETECTED: "ledger_reorg_detected",
  /** Blocking finding(s) not acknowledged */
  BLOCKING_FINDINGS_UNACKNOWLEDGED: "blocking_findings_unacknowledged",
  /** Authorization check failed */
  UNAUTHORIZED: "unauthorized",
  /** Assessment is too old to mark migration ready */
  ASSESSMENT_STALE: "assessment_stale",
  /** Live contract state could not be verified in time */
  VERIFICATION_TIMEOUT: "verification_timeout",
} as const;

export type SuccessorReadinessStatusCodeValue =
  (typeof SuccessorReadinessStatusCode)[keyof typeof SuccessorReadinessStatusCode];
