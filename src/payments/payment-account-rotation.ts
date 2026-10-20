import { StrKey } from "@stellar/stellar-base";
import { STELLAR_SECRET_SEED_PATTERN } from "../stellar/stellar-network";
import { MAX_BACKFILL_LEDGER_SPAN, MIN_BACKFILL_LEDGER } from "./payment-backfill.service";

/**
 * Payment account rotation and checkpoint handoff (earnproof-backend#321).
 *
 * The monitored payment account is the Stellar account whose incoming
 * payments are indexed for a user. Changing it is a handoff between two
 * independent histories, never a merge:
 *
 *   request    → a challenge bound to network, user, both accounts, a nonce
 *                and an expiry
 *   verify     → the NEW account signs the challenge (proof of control);
 *                the challenge is single-use
 *   activate   → the old account's verified checkpoint is captured as its
 *                final checkpoint and removed, so the new account's feed is
 *                read from its own fresh checkpoint and never from the old
 *                account's cursor; a bounded backfill of the new account's
 *                prior history is planned
 *   rollback   → within a window, the old account and its final checkpoint
 *                are restored and the planned backfill is cancelled
 *
 * Only public account ids are ever accepted. Anything that looks like a
 * secret seed is refused without being echoed.
 */

export const PAYMENT_ACCOUNT_ROTATION_ACTIONS = {
  requested: "payment_account.rotation_requested",
  verified: "payment_account.rotation_verified",
  activated: "payment_account.rotation_activated",
  rolledBack: "payment_account.rotation_rolled_back",
  cancelled: "payment_account.rotation_cancelled",
} as const;

/** Bounded failure codes persisted on a consumed rotation. */
export enum PaymentAccountRotationFailure {
  NETWORK_MISMATCH = "network_mismatch",
  IDENTITY_CHANGED = "identity_changed",
  SIGNATURE_INVALID = "signature_invalid",
  ACCOUNT_UNAVAILABLE = "account_unavailable",
}

export const ROLLBACK_REASONS = ["operator_request", "wrong_account", "incident"] as const;
export type PaymentAccountRollbackReason = (typeof ROLLBACK_REASONS)[number];

/** Raised for input that must never be processed further. */
export class SecretMaterialError extends Error {
  constructor() {
    super("secret_material_refused");
    this.name = "SecretMaterialError";
  }
}

/**
 * Refuses any value that looks like a Stellar secret seed. Checked before any
 * other validation, so the refusal is the same whatever field it arrived in,
 * and the value is never logged, stored or echoed.
 */
export function assertNoSecretMaterial(values: readonly unknown[]): void {
  for (const value of values) {
    if (typeof value === "string" && STELLAR_SECRET_SEED_PATTERN.test(value)) {
      throw new SecretMaterialError();
    }
  }
}

/** A plain Ed25519 account (G…): not muxed (M…), not a contract (C…). */
export function isPublicAccountId(value: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(value) && StrKey.isValidEd25519PublicKey(value);
}

export interface RotationBinding {
  appUrl: string;
  networkPassphrase: string;
  userId: string;
  fromAccountId: string;
  toAccountId: string;
  rotationId: string;
  nonce: string;
  expiresAt: Date;
}

/**
 * The message the new account signs. Every field that must not be
 * transplanted to another rotation, user, account pair, network or deployment
 * is in it, and its first line differs from login and wallet-rotation
 * messages, so a signature over one can never be replayed as another.
 */
export function buildRotationMessage(binding: RotationBinding): string {
  return [
    "EarnProof payment account rotation",
    `Domain: ${binding.appUrl}`,
    `Network: ${binding.networkPassphrase}`,
    `Account: ${binding.userId}`,
    `Current Payment Account: ${binding.fromAccountId}`,
    `New Payment Account: ${binding.toAccountId}`,
    `Rotation: ${binding.rotationId}`,
    `Nonce: ${binding.nonce}`,
    `Expires At: ${binding.expiresAt.toISOString()}`,
  ].join("\n");
}

/**
 * The new account's backfill plan: an inclusive ledger range ending at the
 * old account's final checkpoint ledger (the handoff boundary).
 *
 * - No requested lower bound, or no final checkpoint → no backfill.
 * - The range is clamped to the backfill worker's maximum span, keeping the
 *   most recent ledgers, and to its minimum ledger.
 * - A lower bound above the boundary → no backfill.
 *
 * Deterministic: the same inputs always produce the same plan.
 */
export function planBackfill(
  backfillFromLedger: number | null,
  finalLedgerSequence: number | null,
  maxSpan: number = MAX_BACKFILL_LEDGER_SPAN,
): { startLedger: number; endLedger: number } | null {
  if (backfillFromLedger === null || finalLedgerSequence === null) return null;
  const endLedger = finalLedgerSequence;
  const startLedger = Math.max(backfillFromLedger, endLedger - maxSpan + 1, MIN_BACKFILL_LEDGER);
  if (startLedger > endLedger) return null;
  return { startLedger, endLedger };
}

/** Exact boundary: a rollback at the deadline itself is still allowed. */
export function withinRollbackWindow(nowMs: number, deadline: Date | null): boolean {
  return deadline !== null && nowMs <= deadline.getTime();
}

/** Unique-key values that make "one active account" a database invariant. */
export function activeUserKey(userId: string, network: string): string {
  return `${userId}:${network}`;
}

export function activeAccountKey(network: string, accountId: string): string {
  return `${network}:${accountId}`;
}
