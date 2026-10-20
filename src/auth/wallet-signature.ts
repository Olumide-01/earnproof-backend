import { Keypair, StrKey } from "@stellar/stellar-base";
import { createHash } from "crypto";

/**
 * Wallet message signing, shared by login and wallet rotation so both verify
 * signatures the same way.
 *
 * Messages are hashed SEP-53 style: SHA-256 over `"Stellar Signed Message:\n"`
 * followed by the message, then verified as an Ed25519 signature.
 */

export function sep53MessageHash(message: string): Buffer {
  return createHash("sha256")
    .update("Stellar Signed Message:\n", "utf8")
    .update(message, "utf8")
    .digest();
}

/** Accepts hex or base64; anything else decodes to bytes that will not verify. */
export function decodeSignature(signature: string): Buffer {
  if (/^[a-f0-9]+$/i.test(signature) && signature.length % 2 === 0) {
    return Buffer.from(signature, "hex");
  }
  return Buffer.from(signature, "base64");
}

export function isValidWalletAddress(walletAddress: string): boolean {
  return StrKey.isValidEd25519PublicKey(walletAddress);
}

/**
 * Whether `signature` is `walletAddress`'s signature over `message`.
 *
 * Never throws for a malformed signature: a signature of the wrong length is
 * simply not a valid signature.
 */
export function verifyWalletSignature(
  walletAddress: string,
  message: string,
  signature: string,
): boolean {
  try {
    return Keypair.fromPublicKey(walletAddress).verify(
      sep53MessageHash(message),
      decodeSignature(signature),
    );
  } catch {
    return false;
  }
}
