import { createHmac } from "crypto";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import { safeEqual } from "../common/crypto/timing-safe";
import { STELLAR_SECRET_SEED_PATTERN } from "../stellar/stellar-network";

/**
 * Immutable, signed configuration snapshots and semantic diffs
 * (earnproof-backend#329).
 *
 * A snapshot is the effective configuration of one environment at one
 * instant, minus anything that is or could be a secret. It is identified by a
 * content hash and signed, so a snapshot read back later — or imported from
 * another environment — can be proven unaltered.
 *
 * Secret exclusion is deliberately over-eager. A non-secret value that is
 * excluded costs a line in a diff; a secret that is included is a leak into
 * every place snapshots are stored, displayed and compared. Excluded entries
 * are recorded by path and reason only — never by value, length or hash.
 */

export const CONFIG_SNAPSHOT_SCHEMA = "earnproof.config-snapshot.v1";

export type ConfigScalar = string | number | boolean | null;
export type ConfigValue = ConfigScalar | ConfigScalar[];

export type ExclusionReason = "secret_name" | "secret_value";

export interface ExcludedEntry {
  path: string;
  reason: ExclusionReason;
}

export interface ConfigSnapshotContent {
  schema: typeof CONFIG_SNAPSHOT_SCHEMA;
  environment: string;
  /** Flattened dot-path → value, sorted by path. */
  entries: Record<string, ConfigValue>;
  /** Paths withheld from the snapshot, sorted by path. */
  excluded: ExcludedEntry[];
}

export interface ConfigSnapshotSignature {
  alg: "HMAC-SHA256";
  keyId: string;
  value: string;
}

export interface ConfigSnapshotDocument extends ConfigSnapshotContent {
  capturedAt: string;
  contentHash: string;
  signature: ConfigSnapshotSignature;
}

/**
 * Words that mark a configuration key as secret-bearing, matched against the
 * camelCase / snake_case words of every path segment.
 */
const SECRET_WORDS = new Set([
  "secret",
  "secrets",
  "password",
  "passwd",
  "pwd",
  "token",
  "tokens",
  "key",
  "keys",
  "salt",
  "salts",
  "seed",
  "seeds",
  "mnemonic",
  "private",
  "credential",
  "credentials",
  "dsn",
  "cookie",
  "certificate",
  "cert",
]);

/** Connection URLs routinely embed credentials even when they look benign. */
const CONNECTION_URL_KEY = /^(database|redis|db|testDatabase|cache|queue|broker)Url$/i;

/** Splits `credentialSigningKeyId` / `SESSION_SECRET` into lowercase words. */
function wordsOf(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** Whether a key path names something secret-bearing. Exported for tests. */
export function isSecretPath(path: string): boolean {
  return path.split(".").some((segment) => {
    if (CONNECTION_URL_KEY.test(segment)) return true;
    return wordsOf(segment).some((word) => SECRET_WORDS.has(word));
  });
}

/** Whether a value looks like key material regardless of its key. Exported for tests. */
export function isSecretValue(value: ConfigScalar): boolean {
  if (typeof value !== "string") return false;
  if (STELLAR_SECRET_SEED_PATTERN.test(value)) return true;
  if (value.includes("-----BEGIN")) return true;
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) return true; // JWT
  if (/^[a-f0-9]{40,}$/i.test(value)) return true; // hex key material
  // Mixed-case base64 of key length. Stellar public keys and contract ids are
  // upper-case base32 and therefore kept.
  if (/^[A-Za-z0-9+/_-]{40,}={0,2}$/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value)) {
    return true;
  }
  try {
    const url = new URL(value);
    if (url.username || url.password) return true;
  } catch {
    // not a URL
  }
  return false;
}

/**
 * Flattens a configuration object into dot paths, withholding secrets.
 *
 * Objects recurse; arrays of scalars are kept whole (a list is one setting);
 * arrays containing objects recurse by index. `undefined` and functions are
 * dropped, because they have no JSON form and are not configuration.
 */
export function flattenConfig(config: Record<string, unknown>): {
  entries: Record<string, ConfigValue>;
  excluded: ExcludedEntry[];
} {
  const entries: Record<string, ConfigValue> = {};
  const excluded: ExcludedEntry[] = [];

  const visit = (value: unknown, path: string): void => {
    if (value === undefined || typeof value === "function") return;

    if (path !== "" && isSecretPath(path)) {
      excluded.push({ path, reason: "secret_name" });
      return;
    }

    if (Array.isArray(value)) {
      if (value.every(isScalar)) {
        const scalars = value.map(normaliseScalar);
        if (scalars.some(isSecretValue)) {
          excluded.push({ path, reason: "secret_value" });
        } else {
          entries[path] = scalars;
        }
        return;
      }
      value.forEach((item, index) => visit(item, `${path}.${index}`));
      return;
    }

    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        visit((value as Record<string, unknown>)[key], path === "" ? key : `${path}.${key}`);
      }
      return;
    }

    const scalar = normaliseScalar(value);
    if (isSecretValue(scalar)) {
      excluded.push({ path, reason: "secret_value" });
      return;
    }
    entries[path] = scalar;
  };

  visit(config, "");

  const sortedEntries: Record<string, ConfigValue> = {};
  for (const path of Object.keys(entries).sort()) sortedEntries[path] = entries[path];
  excluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries: sortedEntries, excluded };
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof Date
  );
}

/** Non-finite numbers have no canonical JSON form; they are recorded as strings. */
function normaliseScalar(value: unknown): ConfigScalar {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}

/** Content hash: environment, entries and exclusions — not the capture time. */
export function contentHashOf(content: ConfigSnapshotContent): string {
  return `sha256:${sha256(
    canonicalize({
      schema: content.schema,
      environment: content.environment,
      entries: content.entries,
      excluded: content.excluded,
    }),
  )}`;
}

/** A signing key bound to this purpose. */
export interface SnapshotSigningKey {
  keyId: string;
  secret: string;
}

/**
 * Resolves the snapshot signing key. A dedicated secret is preferred; without
 * one, a key is derived from the credential signing secret under a fixed
 * purpose label, so the raw credential key never signs anything but
 * credentials.
 */
export function resolveSigningKey(options: {
  dedicatedSecret?: string;
  credentialSigningSecret?: string;
}): SnapshotSigningKey | null {
  if (options.dedicatedSecret && options.dedicatedSecret.trim() !== "") {
    return { keyId: "dedicated", secret: options.dedicatedSecret };
  }
  if (options.credentialSigningSecret && options.credentialSigningSecret.trim() !== "") {
    return {
      keyId: "derived-credential",
      secret: createHmac("sha256", options.credentialSigningSecret)
        .update("earnproof.config-snapshot.signing-key.v1")
        .digest("hex"),
    };
  }
  return null;
}

function signaturePayload(document: Omit<ConfigSnapshotDocument, "signature">): string {
  return canonicalize({
    schema: document.schema,
    environment: document.environment,
    capturedAt: document.capturedAt,
    contentHash: document.contentHash,
  });
}

/** Builds a signed snapshot document from raw configuration. */
export function buildSnapshot(
  config: Record<string, unknown>,
  environment: string,
  capturedAt: Date,
  key: SnapshotSigningKey,
): ConfigSnapshotDocument {
  const { entries, excluded } = flattenConfig(config);
  const content: ConfigSnapshotContent = { schema: CONFIG_SNAPSHOT_SCHEMA, environment, entries, excluded };
  const unsigned = { ...content, capturedAt: capturedAt.toISOString(), contentHash: contentHashOf(content) };
  return {
    ...unsigned,
    signature: {
      alg: "HMAC-SHA256",
      keyId: key.keyId,
      value: createHmac("sha256", key.secret).update(signaturePayload(unsigned)).digest("hex"),
    },
  };
}

export type SnapshotVerification =
  | { valid: true }
  | { valid: false; reason: "schema_unsupported" | "content_hash_mismatch" | "signature_invalid" | "secret_present" };

/**
 * Proves a snapshot document is unaltered: its hash matches its content, its
 * signature matches its hash, and it still contains nothing secret-looking.
 */
export function verifySnapshot(document: ConfigSnapshotDocument, key: SnapshotSigningKey): SnapshotVerification {
  if (document.schema !== CONFIG_SNAPSHOT_SCHEMA || document.signature?.alg !== "HMAC-SHA256") {
    return { valid: false, reason: "schema_unsupported" };
  }
  if (contentHashOf(document) !== document.contentHash) {
    return { valid: false, reason: "content_hash_mismatch" };
  }
  const expected = createHmac("sha256", key.secret).update(signaturePayload(document)).digest("hex");
  if (document.signature.keyId !== key.keyId || !safeEqual(expected, document.signature.value)) {
    return { valid: false, reason: "signature_invalid" };
  }
  // Re-applied on read: an imported document must not smuggle a secret past
  // the exclusion rules, even when correctly signed by a peer.
  for (const [path, value] of Object.entries(document.entries)) {
    const values = Array.isArray(value) ? value : [value];
    if (isSecretPath(path) || values.some(isSecretValue)) {
      return { valid: false, reason: "secret_present" };
    }
  }
  return { valid: true };
}

export interface ConfigDiff {
  identical: boolean;
  added: Array<{ path: string; value: ConfigValue }>;
  removed: Array<{ path: string; value: ConfigValue }>;
  changed: Array<{ path: string; before: ConfigValue; after: ConfigValue }>;
  /** Excluded paths present only in the target / only in the base. Values are never compared. */
  excludedAdded: string[];
  excludedRemoved: string[];
}

/**
 * Semantic diff between two snapshots: per setting, not per line. Values are
 * compared canonically, so `[1, 2]` vs `[1, 2]` is equal and `1` vs `"1"` is
 * a change of type that is reported. Output is sorted by path.
 */
export function diffSnapshots(
  base: Pick<ConfigSnapshotContent, "entries" | "excluded">,
  target: Pick<ConfigSnapshotContent, "entries" | "excluded">,
): ConfigDiff {
  const paths = [...new Set([...Object.keys(base.entries), ...Object.keys(target.entries)])].sort();
  const added: ConfigDiff["added"] = [];
  const removed: ConfigDiff["removed"] = [];
  const changed: ConfigDiff["changed"] = [];

  for (const path of paths) {
    const inBase = Object.prototype.hasOwnProperty.call(base.entries, path);
    const inTarget = Object.prototype.hasOwnProperty.call(target.entries, path);
    if (inBase && !inTarget) removed.push({ path, value: base.entries[path] });
    else if (!inBase && inTarget) added.push({ path, value: target.entries[path] });
    else if (canonicalize(base.entries[path]) !== canonicalize(target.entries[path])) {
      changed.push({ path, before: base.entries[path], after: target.entries[path] });
    }
  }

  const baseExcluded = new Set(base.excluded.map((entry) => entry.path));
  const targetExcluded = new Set(target.excluded.map((entry) => entry.path));
  const excludedAdded = [...targetExcluded].filter((path) => !baseExcluded.has(path)).sort();
  const excludedRemoved = [...baseExcluded].filter((path) => !targetExcluded.has(path)).sort();

  return {
    identical:
      added.length === 0 &&
      removed.length === 0 &&
      changed.length === 0 &&
      excludedAdded.length === 0 &&
      excludedRemoved.length === 0,
    added,
    removed,
    changed,
    excludedAdded,
    excludedRemoved,
  };
}
