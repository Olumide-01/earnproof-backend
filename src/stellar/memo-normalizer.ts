import {
  HorizonTransactionRecord,
  MemoOmission,
  NormalizedMemo,
} from "./stellar.types";

/**
 * Stellar protocol limits (XDR `Memo`). Anything outside them cannot have come
 * from a valid transaction and is omitted rather than stored.
 */
export const MAX_MEMO_TEXT_BYTES = 28;
export const MEMO_HASH_BYTES = 32;
const MAX_MEMO_ID = 18_446_744_073_709_551_615n; // 2^64 - 1

/** Canonical padded base64 of exactly 32 bytes. */
const HASH_BASE64 = /^[A-Za-z0-9+/]{43}=$/;
const MEMO_ID = /^(0|[1-9]\d{0,19})$/;

export type MemoNormalization = {
  memo: NormalizedMemo;
  /** Why a present memo was dropped; absent when nothing was dropped. */
  omitted?: MemoOmission;
};

/**
 * Allowlisted, byte-bounded memo normalization, keyed by Stellar memo type.
 *
 * Unsupported types and malformed or oversized values are never passed
 * through: they become `{ type: "none" }` with the reason recorded, so no
 * caller ever sees unvalidated Horizon data.
 */
export function normalizeMemoDetailed(
  transaction: HorizonTransactionRecord | null | undefined,
): MemoNormalization {
  if (
    !transaction ||
    transaction.memo_type === undefined ||
    transaction.memo_type === "none"
  ) {
    return { memo: { type: "none" } };
  }

  const value = transaction.memo;
  switch (transaction.memo_type) {
    case "text":
      return normalizeTextMemo(value);
    case "id":
      return normalizeIdMemo(value);
    case "hash":
      return normalizeHashMemo("hash", value);
    case "return":
      return normalizeHashMemo("return_hash", value);
    default:
      return omit("unsupported");
  }
}

export function normalizeMemo(
  transaction: HorizonTransactionRecord | null | undefined,
): NormalizedMemo {
  return normalizeMemoDetailed(transaction).memo;
}

/**
 * Re-validates an already-normalized memo value against the same rules. Used
 * when reading persisted memos back, so stored data is never trusted blindly.
 */
export function isValidNormalizedMemo(memo: NormalizedMemo): boolean {
  switch (memo.type) {
    case "none":
      return true;
    case "text":
      return (
        typeof memo.value === "string" &&
        Buffer.byteLength(memo.value, "utf8") <= MAX_MEMO_TEXT_BYTES * 3
      );
    case "id":
      return normalizeIdMemo(memo.value).memo.type === "id";
    case "hash":
    case "return_hash":
      return typeof memo.value === "string" && HASH_BASE64.test(memo.value);
    default:
      return false;
  }
}

function omit(reason: MemoOmission): MemoNormalization {
  return { memo: { type: "none" }, omitted: reason };
}

function normalizeTextMemo(value: unknown): MemoNormalization {
  let bytes: Buffer;
  if (typeof value === "string") {
    bytes = Buffer.from(value, "utf8");
  } else if (value instanceof Uint8Array) {
    bytes = Buffer.from(value);
  } else {
    return omit("malformed");
  }

  if (bytes.length === 0) return { memo: { type: "none" } };
  if (bytes.length > MAX_MEMO_TEXT_BYTES) return omit("oversized");

  // Invalid UTF-8 sequences decode to U+FFFD; the byte bound above is applied
  // to the original bytes, so the replacement cannot smuggle in extra data.
  return {
    memo: { type: "text", value: bytes.toString("utf8"), truncated: false },
  };
}

function normalizeIdMemo(value: unknown): MemoNormalization {
  if (typeof value !== "string" || !MEMO_ID.test(value)) {
    return omit("malformed");
  }
  if (BigInt(value) > MAX_MEMO_ID) return omit("malformed");
  return { memo: { type: "id", value } };
}

function normalizeHashMemo(
  type: "hash" | "return_hash",
  value: unknown,
): MemoNormalization {
  let bytes: Buffer;
  if (typeof value === "string") {
    // Buffer.from(..., "base64") silently skips invalid characters, so the
    // encoding itself is checked first.
    if (!HASH_BASE64.test(value)) return omit("malformed");
    bytes = Buffer.from(value, "base64");
  } else if (value instanceof Uint8Array) {
    bytes = Buffer.from(value);
  } else {
    return omit("malformed");
  }

  if (bytes.length !== MEMO_HASH_BYTES) {
    return omit(bytes.length > MEMO_HASH_BYTES ? "oversized" : "malformed");
  }
  return { memo: { type, value: bytes.toString("base64") } };
}
