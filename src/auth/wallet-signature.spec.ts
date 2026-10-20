import { Keypair } from "@stellar/stellar-base";
import {
  decodeSignature,
  isValidWalletAddress,
  sep53MessageHash,
  verifyWalletSignature,
} from "./wallet-signature";

const key = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 21));
const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 22));
const message = "EarnProof wallet rotation\nNonce: abc";

describe("wallet signatures", () => {
  it("verifies a SEP-53 signature in base64 and in hex", () => {
    const signature = key.sign(sep53MessageHash(message));

    expect(verifyWalletSignature(key.publicKey(), message, signature.toString("base64"))).toBe(true);
    expect(verifyWalletSignature(key.publicKey(), message, signature.toString("hex"))).toBe(true);
  });

  it("rejects a signature over the raw message rather than its SEP-53 hash", () => {
    const signature = key.sign(Buffer.from(message, "utf8")).toString("base64");

    expect(verifyWalletSignature(key.publicKey(), message, signature)).toBe(false);
  });

  it("rejects another key's signature and a signature over another message", () => {
    const byOther = other.sign(sep53MessageHash(message)).toString("base64");
    const otherMessage = key.sign(sep53MessageHash(`${message}!`)).toString("base64");

    expect(verifyWalletSignature(key.publicKey(), message, byOther)).toBe(false);
    expect(verifyWalletSignature(key.publicKey(), message, otherMessage)).toBe(false);
  });

  it.each(["", "not-a-signature", "00", "A".repeat(200)])(
    "returns false instead of throwing for the malformed signature %p",
    (signature) => {
      expect(verifyWalletSignature(key.publicKey(), message, signature)).toBe(false);
    },
  );

  it("decodes even-length hex as hex and anything else as base64", () => {
    expect(decodeSignature("0a0b")).toEqual(Buffer.from([10, 11]));
    expect(decodeSignature("AQI=")).toEqual(Buffer.from([1, 2]));
  });

  it("accepts only Ed25519 account addresses", () => {
    expect(isValidWalletAddress(key.publicKey())).toBe(true);
    expect(isValidWalletAddress(key.secret())).toBe(false);
    expect(isValidWalletAddress("GABC")).toBe(false);
  });
});
