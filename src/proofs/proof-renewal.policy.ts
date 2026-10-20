import { Prisma, ProofStatus, ProofType } from "@prisma/client";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";

/**
 * Proof renewal and supersession rules.
 *
 * Kept free of I/O so every rule can be exercised directly, and so the
 * eligibility endpoint and the renewal endpoint cannot drift apart: both call
 * {@link evaluateRenewalEligibility}.
 */

/**
 * How long after expiry a proof may still be renewed.
 *
 * A proof that lapsed yesterday should be renewable without the owner having
 * to rebuild the claim from scratch; one that lapsed months ago describes a
 * situation nobody has looked at since and must be re-issued normally.
 */
export const RENEWAL_GRACE_PERIOD_DAYS = 30;

/**
 * Upper bound on predecessor-chain traversal during cycle detection. Chains
 * are one link per renewal, so this is far beyond any legitimate history and
 * only exists so a corrupted chain cannot turn a request into an unbounded
 * walk.
 */
export const MAX_SUPERSESSION_CHAIN_DEPTH = 256;

/** Longest accepted `Idempotency-Key` header value. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * The only issuer this backend signs credentials as. Proofs carry no per-row
 * issuer column; every credential is rebuilt with this issuer, so issuer
 * compatibility is checked against it explicitly rather than assumed.
 */
export const PROOF_CREDENTIAL_ISSUER = "earnproof-backend";

/** Stable, non-identifying reason codes. Callers branch on these. */
export const RenewalIneligibility = {
  REVOKED: "revoked",
  INVALID: "invalid",
  EXPIRED_BEYOND_GRACE: "expired_beyond_grace",
  ALREADY_SUPERSEDED: "already_superseded",
} as const;

export type RenewalIneligibilityValue =
  (typeof RenewalIneligibility)[keyof typeof RenewalIneligibility];

export const SupersessionIncompatibility = {
  SAME_PROOF: "same_proof",
  OWNER_MISMATCH: "owner_mismatch",
  PROOF_TYPE_MISMATCH: "proof_type_mismatch",
  ISSUER_MISMATCH: "issuer_mismatch",
  ASSET_MISMATCH: "asset_mismatch",
  NETWORK_MISMATCH: "network_mismatch",
  POLICY_MISMATCH: "policy_mismatch",
  SUCCESSOR_NOT_ACTIVE: "successor_not_active",
  SUCCESSOR_EXPIRED: "successor_expired",
  SUCCESSOR_ALREADY_LINKED: "successor_already_linked",
  SUCCESSOR_SUPERSEDED: "successor_superseded",
  SUCCESSOR_PREDATES_PREDECESSOR: "successor_predates_predecessor",
  CYCLE: "supersession_cycle",
} as const;

export type SupersessionIncompatibilityValue =
  (typeof SupersessionIncompatibility)[keyof typeof SupersessionIncompatibility];

/** The proof fields renewal rules read. */
export interface RenewableProof {
  id: string;
  userId: string;
  proofType: ProofType;
  schemaVersion: string;
  status: ProofStatus;
  network: string;
  assetCode: string;
  assetIssuer: string | null;
  expiresAt: Date;
  createdAt: Date;
  supersedesId: string | null;
  supersededAt: Date | null;
  /**
   * Credential issuer. Proof rows carry no issuer column today, so this is
   * normally absent and {@link PROOF_CREDENTIAL_ISSUER} applies.
   */
  issuer?: string | null;
  claim: {
    operator: string;
    frequency: string | null;
    disclosurePolicy: Prisma.JsonValue;
  } | null;
}

export interface RenewalEligibility {
  eligible: boolean;
  reasons: RenewalIneligibilityValue[];
}

/**
 * Whether `proof` may be renewed at `now`.
 *
 * Ownership is deliberately NOT part of this: it is checked before this runs,
 * and a non-owner must never learn anything about eligibility.
 */
export function evaluateRenewalEligibility(
  proof: Pick<RenewableProof, "status" | "expiresAt" | "supersededAt">,
  now: Date,
  hasSuccessor: boolean,
): RenewalEligibility {
  const reasons: RenewalIneligibilityValue[] = [];

  if (proof.status === ProofStatus.REVOKED) {
    reasons.push(RenewalIneligibility.REVOKED);
  } else if (proof.status === ProofStatus.INVALID) {
    reasons.push(RenewalIneligibility.INVALID);
  } else if (
    proof.expiresAt.getTime() + RENEWAL_GRACE_PERIOD_DAYS * 86_400_000 <=
    now.getTime()
  ) {
    // EXPIRED status and a past expiresAt are treated alike: the grace window
    // is measured from expiresAt either way.
    reasons.push(RenewalIneligibility.EXPIRED_BEYOND_GRACE);
  }

  if (hasSuccessor || proof.supersededAt) {
    reasons.push(RenewalIneligibility.ALREADY_SUPERSEDED);
  }

  return { eligible: reasons.length === 0, reasons };
}

/**
 * Disclosure-policy flags that change what a verifier learns. A successor that
 * disclosed more (or less) than its predecessor is a different policy, not a
 * renewal of the same one.
 */
const POLICY_FLAGS = [
  "senderHidden",
  "amountHidden",
  "exactIncomeHidden",
  "sourceTransactionsHidden",
] as const;

/** The policy fingerprint two proofs must share to supersede one another. */
export function policyFingerprint(proof: RenewableProof): string {
  const policy =
    proof.claim?.disclosurePolicy &&
    typeof proof.claim.disclosurePolicy === "object" &&
    !Array.isArray(proof.claim.disclosurePolicy)
      ? (proof.claim.disclosurePolicy as Record<string, unknown>)
      : {};

  return canonicalize({
    schemaVersion: proof.schemaVersion,
    operator: proof.claim?.operator ?? null,
    frequency: proof.claim?.frequency ?? null,
    flags: Object.fromEntries(
      POLICY_FLAGS.map((flag) => [flag, policy[flag] ?? null]),
    ),
  });
}

/**
 * Compatibility of an existing proof as the successor of `predecessor`.
 *
 * Every mismatch is reported rather than the first, so a client sees the full
 * picture in one round trip.
 */
export function evaluateSupersessionCompatibility(
  predecessor: RenewableProof,
  successor: RenewableProof,
  now: Date,
  successorHasSuccessor: boolean,
): SupersessionIncompatibilityValue[] {
  if (predecessor.id === successor.id) {
    return [SupersessionIncompatibility.SAME_PROOF];
  }

  const reasons: SupersessionIncompatibilityValue[] = [];

  if (predecessor.userId !== successor.userId) {
    reasons.push(SupersessionIncompatibility.OWNER_MISMATCH);
  }
  if (predecessor.proofType !== successor.proofType) {
    reasons.push(SupersessionIncompatibility.PROOF_TYPE_MISMATCH);
  }
  if (credentialIssuer(predecessor) !== credentialIssuer(successor)) {
    reasons.push(SupersessionIncompatibility.ISSUER_MISMATCH);
  }
  if (
    predecessor.assetCode !== successor.assetCode ||
    (predecessor.assetIssuer ?? null) !== (successor.assetIssuer ?? null)
  ) {
    reasons.push(SupersessionIncompatibility.ASSET_MISMATCH);
  }
  if (predecessor.network !== successor.network) {
    reasons.push(SupersessionIncompatibility.NETWORK_MISMATCH);
  }
  if (policyFingerprint(predecessor) !== policyFingerprint(successor)) {
    reasons.push(SupersessionIncompatibility.POLICY_MISMATCH);
  }
  if (successor.status !== ProofStatus.ACTIVE) {
    reasons.push(SupersessionIncompatibility.SUCCESSOR_NOT_ACTIVE);
  } else if (successor.expiresAt <= now) {
    reasons.push(SupersessionIncompatibility.SUCCESSOR_EXPIRED);
  }
  if (successor.supersedesId) {
    reasons.push(SupersessionIncompatibility.SUCCESSOR_ALREADY_LINKED);
  }
  if (successor.supersededAt || successorHasSuccessor) {
    reasons.push(SupersessionIncompatibility.SUCCESSOR_SUPERSEDED);
  }
  if (successor.createdAt < predecessor.createdAt) {
    reasons.push(SupersessionIncompatibility.SUCCESSOR_PREDATES_PREDECESSOR);
  }

  return reasons;
}

/**
 * The issuer a proof's credential is signed as. Every proof is currently
 * issued by this backend; reading an explicit issuer first means a future
 * per-proof issuer is enforced here rather than becoming a silent gap.
 */
function credentialIssuer(proof: RenewableProof): string {
  return proof.issuer ?? PROOF_CREDENTIAL_ISSUER;
}

/**
 * Walk `predecessorId`'s ancestry (via `loadPredecessorId`) and report
 * whether `candidateSuccessorId` already appears in it. Linking an ancestor
 * as a successor would close a loop.
 *
 * A chain longer than {@link MAX_SUPERSESSION_CHAIN_DEPTH}, or one that
 * revisits a node, is itself treated as a cycle: it can only mean the stored
 * chain is already corrupt, and extending it would make things worse.
 */
export async function wouldCreateCycle(
  predecessorId: string,
  candidateSuccessorId: string,
  loadPredecessorId: (proofId: string) => Promise<string | null>,
): Promise<boolean> {
  const seen = new Set<string>();
  let current: string | null = predecessorId;

  for (let depth = 0; current; depth++) {
    if (current === candidateSuccessorId || seen.has(current)) return true;
    if (depth >= MAX_SUPERSESSION_CHAIN_DEPTH) return true;
    seen.add(current);
    current = await loadPredecessorId(current);
  }

  return false;
}

/**
 * Stable hash identifying a renewal request.
 *
 * Two requests with the same hash are the same request: the second is a
 * replay and receives the first one's successor. The owner is part of the
 * hash, so one user's key can never replay another user's renewal.
 */
export function renewalRequestHash(input: {
  userId: string;
  predecessorId: string;
  successorProofId?: string | null;
  expiresInDays?: number | null;
  idempotencyKey?: string | null;
}): string {
  return `sha256:${sha256(
    canonicalize({
      userId: input.userId,
      predecessorId: input.predecessorId,
      successorProofId: input.successorProofId ?? null,
      expiresInDays: input.expiresInDays ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    }),
  )}`;
}
