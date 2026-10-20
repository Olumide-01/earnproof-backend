import { PaymentClassification } from "@prisma/client";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";

/**
 * Versioned payment eligibility policy.
 *
 * `Payment.isEligible` used to be written without any record of why. A
 * decision under this policy stores the policy version, the factors it
 * evaluated, and a reason code for each factor, so the owner and operators
 * can see which rule produced the result.
 *
 * v1 keeps the rule `isEligible` has always had: a payment is eligible when
 * its asset is on the active supported-asset list. Classification and trust are
 * evaluated and explained too, because they decide which proofs a payment can
 * back (`usage`), but in v1 they do not change `eligible` itself — changing that
 * would silently change which proofs existing clients can issue.
 *
 * Factors are booleans and enums only: never a memo, an amount, or a
 * counterparty address.
 */

export const ELIGIBILITY_POLICY_VERSION = "payment-eligibility.v1";

export type ReasonEffect = "allow" | "deny" | "info";

export const REASON_CODES = {
  ASSET_SUPPORTED: {
    effect: "allow",
    message: "The payment's asset is on the supported-asset list.",
  },
  ASSET_NOT_SUPPORTED: {
    effect: "deny",
    message: "The payment's asset is not on the supported-asset list, so it cannot back any proof.",
  },
  CLASSIFICATION_INCOME: {
    effect: "info",
    message: "Classified as income, so it can back income proofs.",
  },
  CLASSIFICATION_NOT_INCOME: {
    effect: "info",
    message: "Not classified as income, so it cannot back income proofs until reclassified.",
  },
  CLASSIFICATION_EXCLUDED: {
    effect: "info",
    message: "Classified as excluded, so it cannot back any proof until reclassified.",
  },
  SOURCE_TRUSTED: {
    effect: "info",
    message: "The sender is one of your active trusted sources.",
  },
  SOURCE_ISSUER_VERIFIED: {
    effect: "info",
    message: "The trusted source is linked to an active registered issuer.",
  },
  SOURCE_NOT_TRUSTED: {
    effect: "info",
    message: "The sender is not one of your active trusted sources.",
  },
} as const satisfies Record<string, { effect: ReasonEffect; message: string }>;

export type ReasonCode = keyof typeof REASON_CODES;

export const DECISION_TRIGGERS = [
  "sync",
  "classification_changed",
  "trusted_source_changed",
  "asset_policy_changed",
  "policy_migration",
] as const;
export type DecisionTrigger = (typeof DECISION_TRIGGERS)[number];

export interface EligibilityFactors {
  assetSupported: boolean;
  classification: PaymentClassification;
  sourceTrusted: boolean;
  /** Only meaningful when `sourceTrusted`; false otherwise. */
  sourceIssuerVerified: boolean;
}

export interface EligibilityDecision {
  policyVersion: typeof ELIGIBILITY_POLICY_VERSION;
  eligible: boolean;
  factors: EligibilityFactors;
  /** In a fixed order: asset, classification, source. */
  reasonCodes: ReasonCode[];
  /** Identifies (policy, factors); equal hashes mean an identical decision. */
  inputsHash: string;
}

export function evaluateEligibility(input: EligibilityFactors): EligibilityDecision {
  const factors: EligibilityFactors = {
    assetSupported: input.assetSupported,
    classification: input.classification,
    sourceTrusted: input.sourceTrusted,
    sourceIssuerVerified: input.sourceTrusted && input.sourceIssuerVerified,
  };

  const reasonCodes: ReasonCode[] = [
    factors.assetSupported ? "ASSET_SUPPORTED" : "ASSET_NOT_SUPPORTED",
    factors.classification === PaymentClassification.INCOME
      ? "CLASSIFICATION_INCOME"
      : factors.classification === PaymentClassification.EXCLUDED
        ? "CLASSIFICATION_EXCLUDED"
        : "CLASSIFICATION_NOT_INCOME",
    factors.sourceTrusted ? "SOURCE_TRUSTED" : "SOURCE_NOT_TRUSTED",
  ];
  if (factors.sourceIssuerVerified) reasonCodes.push("SOURCE_ISSUER_VERIFIED");

  return {
    policyVersion: ELIGIBILITY_POLICY_VERSION,
    eligible: factors.assetSupported,
    factors,
    reasonCodes,
    inputsHash: `sha256:${sha256(canonicalize({ policyVersion: ELIGIBILITY_POLICY_VERSION, factors }))}`,
  };
}

/** Which proof families a decision permits, mirroring the issuance checks. */
export function proofUsage(eligible: boolean, classification: PaymentClassification) {
  return {
    paymentReceipt: eligible && classification !== PaymentClassification.EXCLUDED,
    incomeProofs: eligible && classification === PaymentClassification.INCOME,
  };
}

/** Parses stored reason codes, dropping any this build does not know. */
export function knownReasonCodes(codes: readonly string[]): ReasonCode[] {
  return codes.filter((code): code is ReasonCode => code in REASON_CODES);
}
