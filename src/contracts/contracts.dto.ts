/**
 * Data Transfer Objects for contract successor migration operations.
 * These are used in API responses and maintain a public contract surface.
 */

import {
  ContractSuccessorReadinessDto,
  SuccessorFinding,
  MigrationCheckpoint,
  ContractIdentity,
} from "./contracts.types";

/**
 * DTO for assessing successor contract readiness.
 * Returned by GET /contracts/:network/:contractId/successor/readiness
 */
export class AssessSuccessorReadinessResponse implements ContractSuccessorReadinessDto {
  successor: ContractIdentity;
  status: "ready" | "not_ready";
  reason?: string;
  findings: SuccessorFinding[];
  overall: "blocking" | "advisory" | "informational" | "none";
  cached: boolean;
  ageMs?: number;
  assessedAt: string;
  latestCheckpoint: MigrationCheckpoint | null;
}

/**
 * DTO for acknowledging a successor readiness finding.
 * Used in POST /contracts/:network/:contractId/successor/findings/:key/acknowledge
 */
export class AcknowledgeSuccessorFindingRequest {
  /** Human-readable reason for acknowledgement (for audit trail) */
  note: string;
  /** How long the acknowledgement is valid (seconds). Max 7 days. */
  ttlSeconds: number;
}

/**
 * DTO for finding acknowledgement response.
 */
export class AcknowledgeSuccessorFindingResponse {
  /** The finding key that was acknowledged */
  findingKey: string;
  /** When it was acknowledged (ISO-8601) */
  acknowledgedAt: string;
  /** When it will expire (ISO-8601) */
  expiresAt: string;
  /** Who acknowledged it (actorId) */
  acknowledgedBy: string;
}

/**
 * DTO for compatibility matrix between predecessor and successor.
 */
export class ContractSuccessorCompatibilityResponse {
  predecessor: ContractIdentity;
  successor: ContractIdentity;
  schemaCompatible: boolean;
  pauseStateCompatible: boolean;
  checkpointMigrationSafe: boolean;
  ledgerMonotonicityVerified: boolean;
  readinessComplete: boolean;
  verifiedAt: string;
}

/**
 * DTO for listing contract successors.
 */
export class ListContractSuccessorsResponse {
  total: number;
  successors: ContractSuccessorReadinessDto[];
}

/**
 * DTO for successor contract identity lookup.
 */
export class ContractIdentityResponse implements ContractIdentity {
  network: string;
  contractId: string;
  expectedVersion: number;
}

/**
 * DTO for migration checkpoint details.
 */
export class MigrationCheckpointResponse implements MigrationCheckpoint {
  createdAt: string;
  observedLedger: bigint;
  passedGates: string[];
  failedGates: string[];
}
