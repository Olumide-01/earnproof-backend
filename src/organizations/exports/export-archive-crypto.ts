import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

/**
 * Authenticated encryption for an export archive.
 *
 * An organization export is a bundle of a tenant's data sitting at rest in a
 * temporary file until it is downloaded or expires. "Temporary" is not
 * "harmless": that file is exactly the payload an attacker who reached the disk
 * would want, so it is encrypted with AES-256-GCM — the same algorithm and key
 * discipline the payment-amount encryption already uses — rather than written in
 * the clear and trusted to be deleted in time.
 *
 * GCM is chosen for its authentication tag: on read, a tampered or truncated
 * archive fails the tag check and throws, so a corrupted download can never be
 * mistaken for a partial-but-valid export. The digest returned alongside the
 * ciphertext is over the *ciphertext*, so integrity can be verified — and
 * audit-logged — without ever holding the key.
 */

/** Envelope: enc:v1:<iv>:<tag>:<ciphertext>, all base64url. */
const ARCHIVE_PATTERN = /^encv1:([^:]+):([^:]+):([^:]+)$/;

export interface EncryptedArchive {
  /** The self-describing ciphertext envelope, safe to write to disk. */
  content: Buffer;
  /** SHA-256 hex digest of the ciphertext, for integrity and the audit record. */
  digest: string;
  /** Byte length of the ciphertext envelope. */
  sizeBytes: number;
}

/** Encrypts a plaintext archive body with the given 32-byte key. */
export function encryptArchive(plaintext: Buffer, key: Buffer): EncryptedArchive {
  assertKey(key);

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope = Buffer.from(
    `encv1:${iv.toString("base64url")}:${tag.toString(
      "base64url",
    )}:${ciphertext.toString("base64url")}`,
    "utf8",
  );

  return {
    content: envelope,
    digest: sha256Hex(envelope),
    sizeBytes: envelope.length,
  };
}

/**
 * Decrypts an archive envelope. Throws if the key is wrong or the ciphertext was
 * tampered with — the GCM tag makes that failure loud rather than silent.
 */
export function decryptArchive(envelope: Buffer, key: Buffer): Buffer {
  assertKey(key);

  const match = ARCHIVE_PATTERN.exec(envelope.toString("utf8"));
  if (!match) {
    throw new Error("Unsupported or corrupt export archive envelope");
  }

  const [, ivValue, tagValue, ciphertextValue] = match;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]);
}

/** Confirms the ciphertext of an envelope matches an expected digest. */
export function archiveDigestMatches(envelope: Buffer, digest: string): boolean {
  return sha256Hex(envelope) === digest;
}

/**
 * Decodes configured key material (hex or base64) into a 32-byte key.
 *
 * Shares the decoding rules with payment encryption so an operator configures
 * export keys the same way they configure every other key — one convention, not
 * a per-feature surprise.
 */
export function decodeArchiveKey(material: string): Buffer {
  const key = /^[a-fA-F0-9]{64}$/.test(material)
    ? Buffer.from(material, "hex")
    : Buffer.from(material, "base64");
  assertKey(key);
  return key;
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new Error("Export encryption key must decode to 32 bytes");
  }
}

function sha256Hex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
