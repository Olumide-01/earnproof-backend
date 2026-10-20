import { createHash } from "crypto";

/**
 * Tamper-evidence chain primitives for AuditLog.
 *
 * These functions are pure and deterministic so they can be exercised with
 * fixed vectors in tests, reused by the migration backfill script, and by
 * the verification service, without any of them drifting relative to each
 * other. Anything that decides what goes into a hash lives here — nowhere
 * else should construct the canonical payload by hand.
 */

/** Current hash algorithm version. Bump this (and add a branch in
 * {@link computeAuditHash}) whenever the canonicalization or digest changes,
 * so records written under an older algorithm keep verifying correctly. */
export const CURRENT_HASH_VERSION = 1;

/** chainKey used for records with no organization (legacy/system actions). */
export const SYSTEM_CHAIN_KEY = "SYSTEM";

/** Sentinel hashed in place of `prevHash` at chain genesis (sequence 1). */
export const GENESIS_SENTINEL = "GENESIS";

/** Resolves the chain partition key for a record. Postgres unique
 * constraints do not deduplicate NULLs, so a stable sentinel is used instead
 * of leaving organization-less records unpartitioned. */
export function resolveChainKey(organizationId?: string | null): string {
  return organizationId && organizationId.length > 0
    ? organizationId
    : SYSTEM_CHAIN_KEY;
}

/** The mutable/presentation-only fields that must never affect the hash,
 * plus the fields that are themselves part of the chain envelope. Listed
 * explicitly so a reviewer can see exactly what canonicalization excludes. */
export interface AuditHashInput {
  chainKey: string;
  sequence: bigint;
  hashVersion: number;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: unknown;
  createdAt: Date;
}

/**
 * Deep, key-sorted canonical JSON. Object keys are sorted recursively so two
 * semantically identical objects with different key insertion order always
 * serialize identically. Arrays keep their order (order is meaningful).
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sorted: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      sorted[key] = sortKeysDeep(val);
    }
    return sorted;
  }
  return value;
}

/**
 * Builds the canonical (hash-input) representation of an audit record.
 *
 * Deliberately excludes `id` (a storage artifact, not content), `hash`
 * itself (would be circular), and any other mutable/derived/presentation
 * field. `sequence` is serialized as a decimal string because JSON has no
 * native bigint, and `createdAt` as an ISO string for a stable, unambiguous
 * representation.
 */
export function buildCanonicalRecord(input: AuditHashInput): string {
  return canonicalStringify({
    chainKey: input.chainKey,
    sequence: input.sequence.toString(),
    hashVersion: input.hashVersion,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    metadata: input.metadata ?? null,
    createdAt: input.createdAt.toISOString(),
  });
}

/**
 * Computes `hash = sha256(prevHashOrGenesis + "|" + canonicalJSON)` for the
 * given hash algorithm version. Version 1 is the only version today;
 * verification dispatches on the record's own stored `hashVersion` so a
 * future version can be added here without invalidating older records.
 */
export function computeAuditHash(
  prevHash: string | null,
  input: AuditHashInput,
  hashVersion: number = CURRENT_HASH_VERSION,
): string {
  switch (hashVersion) {
    case 1: {
      const canonical = buildCanonicalRecord({ ...input, hashVersion });
      const linked = `${prevHash ?? GENESIS_SENTINEL}|${canonical}`;
      return createHash("sha256").update(linked).digest("hex");
    }
    default:
      throw new Error(`Unsupported audit hash version: ${hashVersion}`);
  }
}
