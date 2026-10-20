/**
 * Provenance decision builder.
 *
 * Assembles verification decision inputs from various observations
 * (credential, backend, contract, Stellar) into a complete provenance record.
 *
 * Designed to capture lineage without exposing private payloads.
 */

import { createHash } from "crypto";
import { VerificationResult, ProofStatus } from "@prisma/client";
import {
  VerificationProvenanceInput,
  VerificationProvenanceSourceInput,
  VERIFICATION_PROVENANCE_SCHEMA_VERSION,
  ProvenanceSourceType,
} from "./provenance.types";
import { SignedCredentialDto } from "./dto/proof-created.dto";
import { VerificationProvenanceSourceType } from "@prisma/client";

/**
 * Hashes credential data without storing raw payload.
 */
function hashCredential(credential: SignedCredentialDto): string {
  const canonical = JSON.stringify({
    id: credential.id,
    issuedAt: credential.issuedAt,
    expiresAt: credential.expiresAt,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Hashes decision inputs for deterministic provenance.
 */
function hashDecisionInputs(
  credential: SignedCredentialDto,
  policyVersion: string,
  proofStatus: ProofStatus,
  contractStatus: any,
): string {
  const canonical = JSON.stringify({
    credential: hashCredential(credential),
    policy: policyVersion,
    status: proofStatus,
    contractValid: contractStatus?.valid ?? null,
    contractRevoked: contractStatus?.revoked ?? null,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Builder for assembling complete provenance records during verification.
 */
export class ProvenanceDecisionBuilder {
  private sources: VerificationProvenanceSourceInput[] = [];
  private credentialHash: string | null = null;
  private policyVersion: string | null = null;

  /**
   * Track a credential source observation (payment, attestation, trusted source).
   */
  recordCredentialSource(
    sourceId: string,
    sourceLabel?: string,
    missingLinkReason?: string,
  ): this {
    this.sources.push({
      sourceType: VerificationProvenanceSourceType.CREDENTIAL_SOURCE,
      sourceId,
      sourceLabel,
      observedAt: new Date(),
      sourceHash: this.hashSourceId(sourceId),
      observationOrder: this.sources.length,
      missingLinkReason,
    });
    return this;
  }

  /**
   * Track a backend observation (policy, checkpoint, classification).
   */
  recordBackendObservation(
    sourceId: string,
    sourceLabel?: string,
    missingLinkReason?: string,
  ): this {
    this.sources.push({
      sourceType: VerificationProvenanceSourceType.BACKEND_OBSERVATION,
      sourceId,
      sourceLabel,
      observedAt: new Date(),
      sourceHash: this.hashSourceId(sourceId),
      observationOrder: this.sources.length,
      missingLinkReason,
    });
    return this;
  }

  /**
   * Track a contract observation (on-chain proof status check).
   */
  recordContractObservation(
    contractTxHash: string,
    isValid: boolean,
    isRevoked: boolean,
    missingLinkReason?: string,
  ): this {
    this.sources.push({
      sourceType: VerificationProvenanceSourceType.CONTRACT_OBSERVATION,
      sourceId: contractTxHash,
      sourceLabel: isRevoked ? "PROOF_REVOKED" : isValid ? "PROOF_VALID" : "PROOF_INVALID",
      observedAt: new Date(),
      sourceHash: this.hashSourceId(contractTxHash),
      observationOrder: this.sources.length,
      missingLinkReason,
    });
    return this;
  }

  /**
   * Track a Stellar observation (operation, ledger finality, payment).
   */
  recordStellarObservation(
    operationId: string,
    sourceLabel?: string,
    missingLinkReason?: string,
  ): this {
    this.sources.push({
      sourceType: VerificationProvenanceSourceType.STELLAR_OBSERVATION,
      sourceId: operationId,
      sourceLabel,
      observedAt: new Date(),
      sourceHash: this.hashSourceId(operationId),
      observationOrder: this.sources.length,
      missingLinkReason,
    });
    return this;
  }

  /**
   * Set the reconstructed credential for provenance.
   */
  setCredential(credential: SignedCredentialDto): this {
    this.credentialHash = hashCredential(credential);
    return this;
  }

  /**
   * Set the policy version applied to this decision.
   */
  setPolicyVersion(version: string): this {
    this.policyVersion = version;
    return this;
  }

  /**
   * Build complete provenance record ready for persistence.
   */
  build(
    proofId: string,
    proofStatus: ProofStatus,
    verificationResult: VerificationResult,
    credential: SignedCredentialDto,
    contractStatus?: any,
    failureReason?: string,
    boundaryContext?: string,
  ): VerificationProvenanceInput {
    const decisionInputHash = hashDecisionInputs(
      credential,
      this.policyVersion || "unknown",
      proofStatus,
      contractStatus,
    );

    return {
      proofId,
      schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
      decisionInputHash,
      credentialHash: this.credentialHash || hashCredential(credential),
      policyVersion: this.policyVersion || "unknown",
      proofStatus: proofStatus.toString(),
      verificationResult,
      failureReason,
      boundaryContext,
      sources: this.sources,
    };
  }

  /**
   * Hash a source ID without exposing its contents.
   */
  private hashSourceId(sourceId: string): string {
    return `sha256:${createHash("sha256").update(sourceId).digest("hex")}`;
  }
}
