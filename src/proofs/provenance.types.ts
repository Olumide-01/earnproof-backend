/**
 * Verification source provenance types.
 *
 * Captures complete lineage of credential, backend, contract, and Stellar
 * observations that contributed to a verification decision. Immutable after
 * creation. Contains no private source payloads, only identity and hashes.
 *
 * Tenant-isolated and privacy-safe by design.
 */

import { VerificationProvenanceSourceType, VerificationResult } from "@prisma/client";

/**
 * Decision-time snapshot of a single source observation.
 * Captures identity, timestamp, hash, and ordering for audit trail.
 */
export interface VerificationProvenanceSourceInput {
  /** Type of source (credential, backend, contract, Stellar) */
  sourceType: VerificationProvenanceSourceType;

  /** Specific source identity (e.g., paymentId, attestationId, operationId) */
  sourceId: string;

  /** Optional human-readable source label (e.g., "PAYMENT_RECEIVED") */
  sourceLabel?: string;

  /** When this source was observed/queried */
  observedAt: Date;

  /** SHA-256 hash of source metadata (never the raw payload) */
  sourceHash: string;

  /** Sequential position in decision lineage (0-indexed) */
  observationOrder: number;

  /** Reason if source was unavailable or excluded */
  missingLinkReason?: string;
}

/**
 * Complete verification decision lineage.
 * Immutable snapshot captured at verification time.
 */
export interface VerificationProvenanceInput {
  /** Proof being verified */
  proofId: string;

  /** Versioned decision schema (e.g., "earnproof.verification.provenance.v1") */
  schemaVersion: string;

  /** Complete hash of all decision inputs (credential, policy, proof state) */
  decisionInputHash: string;

  /** Hashed snapshot of reconstructed credential */
  credentialHash: string;

  /** Policy version applied (e.g., "earnproof.minimum-income.policy.v1") */
  policyVersion: string;

  /** Proof status at verification time */
  proofStatus: string;

  /** Final verification result */
  verificationResult: VerificationResult;

  /** High-level reason if verification failed */
  failureReason?: string;

  /** Optional context about missing links or boundary conditions */
  boundaryContext?: string;

  /** All source observations in order */
  sources: VerificationProvenanceSourceInput[];
}

/**
 * Immutable provenance record persisted after verification.
 */
export interface VerificationProvenanceRecord {
  id: string;
  proofId: string;
  schemaVersion: string;
  decisionInputHash: string;
  credentialHash: string;
  policyVersion: string;
  proofStatus: string;
  verificationResult: VerificationResult;
  failureReason?: string;
  boundaryContext?: string;
  sources: {
    sourceType: VerificationProvenanceSourceType;
    sourceId: string;
    observedAt: Date;
    sourceHash: string;
    observationOrder: number;
    missingLinkReason?: string;
  }[];
  sourceCount: number;
  decidedAt: Date;
  createdAt: Date;
}

/**
 * Public-facing provenance response DTO.
 * Excludes internal hashes; includes only auditable lineage metadata.
 */
export interface VerificationProvenanceResponseDto {
  /** Decision timestamp */
  decidedAt: string;

  /** Policy version applied */
  policyVersion: string;

  /** Proof status at verification time */
  proofStatus: string;

  /** Final verification result */
  verificationResult: string;

  /** Failure reason if any */
  failureReason?: string;

  /** Boundary context if any */
  boundaryContext?: string;

  /** Sources and observation order */
  sources: {
    sourceType: string;
    sourceId: string;
    sourceLabel?: string;
    observedAt: string;
    observationOrder: number;
    missingLinkReason?: string;
  }[];

  /** Total number of sources */
  sourceCount: number;
}

/**
 * Source types contributing to verification.
 */
export enum ProvenanceSourceType {
  CREDENTIAL_SOURCE = "CREDENTIAL_SOURCE",
  BACKEND_OBSERVATION = "BACKEND_OBSERVATION",
  CONTRACT_OBSERVATION = "CONTRACT_OBSERVATION",
  STELLAR_OBSERVATION = "STELLAR_OBSERVATION",
}

/**
 * Current versioned schema for provenance decisions.
 */
export const VERIFICATION_PROVENANCE_SCHEMA_VERSION = "earnproof.verification.provenance.v1";

/**
 * Reasons for missing or excluded sources.
 */
export enum ProvenanceMissingLinkReason {
  STALE_CHECKPOINT = "STALE_CHECKPOINT",
  NETWORK_TIMEOUT = "NETWORK_TIMEOUT",
  ATTESTATION_EXPIRED = "ATTESTATION_EXPIRED",
  AUTHORIZATION_DENIED = "AUTHORIZATION_DENIED",
  SOURCE_REVOKED = "SOURCE_REVOKED",
  PAYMENT_INELIGIBLE = "PAYMENT_INELIGIBLE",
  CONTRACT_UNAVAILABLE = "CONTRACT_UNAVAILABLE",
  CREDENTIAL_MISMATCH = "CREDENTIAL_MISMATCH",
}
