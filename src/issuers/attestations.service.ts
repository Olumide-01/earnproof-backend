import { ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Attestation } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import {
  DEFAULT_ATTESTATION_CLOCK_SKEW_MS,
  EffectiveAttestationStatus,
  canAttestationAuthorizeIssuance,
  computeEffectiveAttestationStatus,
} from "./attestation-status";

/**
 * Attestation policy version marker: captures the signing key and policy state
 * at the time an attestation is created or used for proof issuance (#307).
 */
export const ATTESTATION_POLICY_VERSION = "earnproof.attestation.policy.v1";

/**
 * Read side of issuer attestation status (#207).
 *
 * The effective status is computed on read from the untouched stored fields, so
 * it is correct the instant an attestation expires — even before the
 * reconciliation job has moved the stored `status`. Both readers use the same
 * pure function, so the scheduled job and this API never disagree.
 *
 * Extended to track policy versions for proof verification (#307).
 */
@Injectable()
export class AttestationsService {
  private readonly logger = new Logger(AttestationsService.name);
  private readonly clockSkewMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.clockSkewMs = config.get<number>(
      "attestation.clockSkewMs",
      DEFAULT_ATTESTATION_CLOCK_SKEW_MS,
    );
  }

  /** Effective status of an attestation right now. */
  async getEffectiveStatus(
    attestationId: string,
    now: Date = new Date(),
  ): Promise<EffectiveAttestationStatus> {
    const attestation = await this.prisma.attestation.findUnique({
      where: { id: attestationId },
      select: { status: true, expiresAt: true, revokedAt: true },
    });
    if (!attestation) {
      throw new NotFoundException("Attestation not found");
    }
    return computeEffectiveAttestationStatus(attestation, now, this.clockSkewMs);
  }

  /**
   * Whether an attestation may authorize new issuance right now.
   *
   * Computed from the live fields, so an expired attestation is refused the
   * moment it expires regardless of whether the reconciler has run yet.
   */
  async canAuthorizeIssuance(
    attestationId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const attestation = await this.prisma.attestation.findUnique({
      where: { id: attestationId },
      select: { status: true, expiresAt: true, revokedAt: true },
    });
    if (!attestation) return false;
    return canAttestationAuthorizeIssuance(attestation, now, this.clockSkewMs);
  }

  /**
   * Throw unless an attestation may authorize new issuance.
   *
   * A single guard for issuance call sites, so "expired attestations cannot
   * authorize new issuance" is enforced in one place rather than re-derived at
   * each caller.
   */
  async assertCanAuthorizeIssuance(
    attestationId: string,
    now: Date = new Date(),
  ): Promise<void> {
    if (!(await this.canAuthorizeIssuance(attestationId, now))) {
      throw new ForbiddenException(
        "Attestation is not in an active state and cannot authorize issuance",
      );
    }
  }

  /**
   * Capture the policy version for an attestation at issuance time.
   *
   * Attestations carry signing key versions and other policy state that should
   * be frozen when used for proof issuance. This method computes a deterministic
   * policy version string that represents the attestation state at a point in time.
   *
   * Format: "{ATTESTATION_POLICY_VERSION}:{signingKeyVersionId}:{createdAt}"
   * This enables historical verification: "what was the signing key when this proof was issued?"
   *
   * @param attestation Attestation to capture version for
   * @returns Policy version string
   */
  capturePolicyVersion(attestation: Attestation): string {
    // Deterministic format: version marker + signing key + timestamp
    // This enables proof verification to find the exact attestation state at issuance
    return `${ATTESTATION_POLICY_VERSION}:${attestation.signingKeyVersionId}:${attestation.createdAt.toISOString()}`;
  }

  /**
   * Record a policy version on an attestation after it's been used for proof issuance.
   *
   * Idempotent: if policyVersion is already set, this is a no-op.
   *
   * @param attestationId Attestation to update
   * @param policyVersion Policy version string (from capturePolicyVersion)
   * @returns Updated attestation
   */
  async recordPolicyVersion(
    attestationId: string,
    policyVersion: string,
  ): Promise<Attestation> {
    // Only set policyVersion if not already set (immutable once recorded)
    const attestation = await this.prisma.attestation.findUnique({
      where: { id: attestationId },
      select: { id: true, policyVersion: true },
    });

    if (!attestation) {
      throw new NotFoundException(`Attestation ${attestationId} not found`);
    }

    // Already recorded, return as-is
    if (attestation.policyVersion) {
      this.logger.debug(
        `Attestation ${attestationId} already has policyVersion: ${attestation.policyVersion}`,
      );
      return await this.prisma.attestation.findUniqueOrThrow({
        where: { id: attestationId },
      });
    }

    // Record the version
    const updated = await this.prisma.attestation.update({
      where: { id: attestationId },
      data: { policyVersion },
    });

    this.logger.debug(
      `Recorded policyVersion for attestation ${attestationId}: ${policyVersion}`,
    );

    return updated;
  }

  /**
   * Get the policy version for an attestation, capturing it if not yet recorded.
   *
   * If the attestation already has a policyVersion, returns it.
   * Otherwise, captures and records the current version.
   *
   * @param attestationId Attestation to get/capture version for
   * @returns Policy version string
   */
  async getOrCapturePolicyVersion(attestationId: string): Promise<string> {
    const attestation = await this.prisma.attestation.findUnique({
      where: { id: attestationId },
    });

    if (!attestation) {
      throw new NotFoundException(`Attestation ${attestationId} not found`);
    }

    // Already recorded
    if (attestation.policyVersion) {
      return attestation.policyVersion;
    }

    // Capture and record
    const policyVersion = this.capturePolicyVersion(attestation);
    const updated = await this.recordPolicyVersion(attestationId, policyVersion);
    return updated.policyVersion!;
  }
}
