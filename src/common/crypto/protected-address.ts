import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "crypto";

/**
 * Application-layer protection for payment account addresses.
 *
 * Two things are stored per protected address:
 *
 * - **Ciphertext** — `aenc:v<N>:<iv>:<tag>:<ciphertext>`, AES-256-GCM under
 *   key version N. The field name ("source" / "destination") is bound in as
 *   additional authenticated data, so a source ciphertext copied into the
 *   destination column fails to decrypt instead of silently swapping them.
 * - **Lookup token** (source only) — `hmac:v<N>:<mac>`, a keyed HMAC of the
 *   normalised address. It supports the one equality query payments need
 *   ("payments from this sender") without storing or indexing plaintext, and
 *   reveals nothing without the key.
 *
 * Keys are not new secrets: each purpose derives its own 32-byte key from the
 * payment-encryption key of the same version with HKDF-SHA256, so rotating
 * PAYMENT_ENCRYPTION_KEY_V<N> rotates address protection with it. Tokens carry
 * their version, and lookups query every loaded version, so rows written under
 * a retiring key stay findable until the backfill re-tokens them.
 *
 * Errors never carry plaintext, ciphertext, or key material.
 */

export type AddressField = "source" | "destination";

const CIPHERTEXT_PREFIX = "aenc:";
const TOKEN_PREFIX = "hmac:";
const CIPHERTEXT_PATTERN = /^aenc:v(\d+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/;
const TOKEN_PATTERN = /^hmac:v(\d+):[A-Za-z0-9_-]+$/;

const ENCRYPTION_INFO = "earnproof/payment-address/encryption/v1";
const LOOKUP_INFO = "earnproof/payment-address/lookup/v1";

export type AddressDecryptionFailure = "malformed" | "unknown_key_version" | "integrity";

export class AddressDecryptionError extends Error {
  constructor(readonly failure: AddressDecryptionFailure) {
    super(`Payment address could not be decrypted (${failure})`);
    this.name = "AddressDecryptionError";
  }
}

export interface AddressKeys {
  encryption: ReadonlyMap<number, Buffer>;
  lookup: ReadonlyMap<number, Buffer>;
}

/** Derives per-purpose address keys from the payment-encryption root keys. */
export function deriveAddressKeys(rootKeys: ReadonlyMap<number, string>): AddressKeys {
  const encryption = new Map<number, Buffer>();
  const lookup = new Map<number, Buffer>();
  for (const [version, material] of rootKeys) {
    const root = decodeRootKey(material, version);
    encryption.set(version, derive(root, ENCRYPTION_INFO));
    lookup.set(version, derive(root, LOOKUP_INFO));
  }
  return { encryption, lookup };
}

/** Canonical form used for lookup tokens. Stellar addresses are upper-case. */
export function normalizeAddress(address: string): string {
  return address.trim().toUpperCase();
}

export function encryptAddress(
  address: string,
  field: AddressField,
  keys: AddressKeys,
  version: number,
): string {
  const key = keys.encryption.get(version);
  if (!key) throw new AddressDecryptionError("unknown_key_version");

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(field));
  const ciphertext = Buffer.concat([cipher.update(address, "utf8"), cipher.final()]);
  return `${CIPHERTEXT_PREFIX}v${version}:${iv.toString("base64url")}:${cipher
    .getAuthTag()
    .toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptAddress(value: string, field: AddressField, keys: AddressKeys): string {
  const match = CIPHERTEXT_PATTERN.exec(value);
  if (!match) throw new AddressDecryptionError("malformed");

  const [, versionRaw, ivValue, tagValue, ciphertextValue] = match;
  const key = keys.encryption.get(Number(versionRaw));
  if (!key) throw new AddressDecryptionError("unknown_key_version");

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
    decipher.setAAD(aad(field));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong field, wrong key, or tampered bytes: GCM cannot tell which, and
    // the caller must not either.
    throw new AddressDecryptionError("integrity");
  }
}

export function lookupToken(address: string, keys: AddressKeys, version: number): string {
  const key = keys.lookup.get(version);
  if (!key) throw new AddressDecryptionError("unknown_key_version");
  const mac = createHmac("sha256", key).update(normalizeAddress(address)).digest("base64url");
  return `${TOKEN_PREFIX}v${version}:${mac}`;
}

/** Tokens under every loaded version, for `lookup IN (...)` during rotation. */
export function lookupTokens(address: string, keys: AddressKeys): string[] {
  return [...keys.lookup.keys()].sort((a, b) => a - b).map((v) => lookupToken(address, keys, v));
}

/** Key version recorded in a ciphertext or token, or `null` if it has none. */
export function protectionVersion(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = CIPHERTEXT_PATTERN.exec(value) ?? (TOKEN_PATTERN.test(value) ? /^hmac:v(\d+):/.exec(value) : null);
  return match ? Number(match[1]) : null;
}

function aad(field: AddressField): Buffer {
  return Buffer.from(`earnproof:payment-address:${field}`, "utf8");
}

function derive(root: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), info, 32));
}

function decodeRootKey(material: string, version: number): Buffer {
  const key = /^[a-fA-F0-9]{64}$/.test(material)
    ? Buffer.from(material, "hex")
    : Buffer.from(material, "base64");
  if (key.length !== 32) {
    throw new Error(`Payment encryption key version ${version} must decode to 32 bytes`);
  }
  return key;
}
