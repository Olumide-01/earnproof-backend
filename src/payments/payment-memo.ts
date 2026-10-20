import { Prisma } from "@prisma/client";
import {
  MemoNormalization,
  isValidNormalizedMemo,
} from "../stellar/memo-normalizer";
import { MemoOmission, NormalizedMemo } from "../stellar/stellar.types";

/**
 * Persisted representation of `Payment.memo` (earnproof-backend#176).
 *
 * Version 2, the only version written and the only version read:
 *
 *   { "version": 2, "type": "none", "omitted"?: <reason> }
 *   { "version": 2, "type": "text" | "id" | "hash" | "return_hash",
 *     "ciphertext": "<AES-256-GCM, payment keyring>" }
 *
 * Memo values are only ever needed to show the owner their own payment, so
 * they are stored encrypted with the payment keyring rather than as
 * plaintext. The memo type is bound into the encrypted payload, so a
 * ciphertext cannot be replayed under another type. Every write is checked
 * against MAX_STORED_MEMO_BYTES before it reaches the database, and the
 * database enforces a looser CHECK constraint as a backstop.
 *
 * See docs/payment-memos.md for the compatibility policy for older rows.
 */

export const STORED_MEMO_VERSION = 2;

/** Upper bound on the serialized JSON written to `Payment.memo`. */
export const MAX_STORED_MEMO_BYTES = 512;

export type StoredMemoOmission = MemoOmission | "legacy";

export type StoredMemo =
  | { version: 2; type: "none"; omitted?: StoredMemoOmission }
  | {
      version: 2;
      type: "text" | "id" | "hash" | "return_hash";
      ciphertext: string;
    };

export interface MemoCipher {
  encrypt(plaintext: string): string;
  decrypt(value: string): string;
}

const VALUE_TYPES = new Set(["text", "id", "hash", "return_hash"]);
const OMISSIONS = new Set(["unsupported", "malformed", "oversized", "legacy"]);

export function encodeStoredMemo(
  normalized: MemoNormalization,
  cipher: MemoCipher,
): StoredMemo {
  const { memo, omitted } = normalized;
  let stored: StoredMemo;

  if (memo.type === "none") {
    stored = omitted
      ? { version: STORED_MEMO_VERSION, type: "none", omitted }
      : { version: STORED_MEMO_VERSION, type: "none" };
  } else {
    stored = {
      version: STORED_MEMO_VERSION,
      type: memo.type,
      ciphertext: cipher.encrypt(boundPlaintext(memo.type, memo.value)),
    };
  }

  if (storedMemoBytes(stored) > MAX_STORED_MEMO_BYTES) {
    return { version: STORED_MEMO_VERSION, type: "none", omitted: "oversized" };
  }
  return stored;
}

/**
 * Reads `Payment.memo` back. Anything that is not a well-formed version-2
 * memo that decrypts under the payment keyring and re-validates against the
 * memo rules is treated as no memo. Arbitrary JSON never reaches a caller.
 */
export function decodeStoredMemo(
  value: Prisma.JsonValue | null,
  cipher: MemoCipher,
): NormalizedMemo {
  const stored = parseStoredMemo(value);
  if (!stored || stored.type === "none") return { type: "none" };

  let plaintext: string;
  try {
    plaintext = cipher.decrypt(stored.ciphertext);
  } catch {
    return { type: "none" };
  }

  const prefix = `${stored.type}:`;
  if (!plaintext.startsWith(prefix)) return { type: "none" };
  const memoValue = plaintext.slice(prefix.length);

  const memo: NormalizedMemo =
    stored.type === "text"
      ? { type: "text", value: memoValue, truncated: false }
      : { type: stored.type, value: memoValue };
  return isValidNormalizedMemo(memo) ? memo : { type: "none" };
}

/** Strict structural check of a persisted memo; null when it is not v2. */
export function parseStoredMemo(
  value: Prisma.JsonValue | null,
): StoredMemo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, Prisma.JsonValue>;
  if (record.version !== STORED_MEMO_VERSION) return null;
  if (storedMemoBytes(record) > MAX_STORED_MEMO_BYTES) return null;

  if (record.type === "none") {
    const keys = Object.keys(record);
    if (record.omitted === undefined) {
      return keys.length === 2 ? { version: 2, type: "none" } : null;
    }
    return typeof record.omitted === "string" &&
      OMISSIONS.has(record.omitted) &&
      keys.length === 3
      ? {
          version: 2,
          type: "none",
          omitted: record.omitted as StoredMemoOmission,
        }
      : null;
  }

  if (
    typeof record.type === "string" &&
    VALUE_TYPES.has(record.type) &&
    typeof record.ciphertext === "string" &&
    Object.keys(record).length === 3
  ) {
    return {
      version: 2,
      type: record.type as "text" | "id" | "hash" | "return_hash",
      ciphertext: record.ciphertext,
    };
  }
  return null;
}

function boundPlaintext(type: string, value: string): string {
  return `${type}:${value}`;
}

function storedMemoBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
