import { PaymentAddressCipher } from "./payment-address-cipher";
import { PaymentEncryptionKeyringService } from "./payment-encryption-keyring.service";
import {
  AddressDecryptionError,
  decryptAddress,
  deriveAddressKeys,
  encryptAddress,
  lookupToken,
  lookupTokens,
  normalizeAddress,
  protectionVersion,
} from "./protected-address";
import { encryptProtectedAmount } from "./protected-amount";

const KEY_V0 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const KEY_V1 = "f".repeat(64);
const ADDRESS = "GSYNTHETIC0SENDER000000000000000000000000000000000000000";

const V0 = deriveAddressKeys(new Map([[0, KEY_V0]]));
const V0_V1 = deriveAddressKeys(
  new Map([
    [0, KEY_V0],
    [1, KEY_V1],
  ]),
);

function failure(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AddressDecryptionError);
    return (error as AddressDecryptionError).failure;
  }
  throw new Error("expected a decryption failure");
}

describe("protected addresses", () => {
  it("round-trips an address", () => {
    const stored = encryptAddress(ADDRESS, "source", V0, 0);
    expect(stored).toMatch(/^aenc:v0:/);
    expect(stored).not.toContain(ADDRESS);
    expect(decryptAddress(stored, "source", V0)).toBe(ADDRESS);
  });

  it("uses a fresh IV, so equal addresses do not produce equal ciphertext", () => {
    expect(encryptAddress(ADDRESS, "source", V0, 0)).not.toBe(encryptAddress(ADDRESS, "source", V0, 0));
  });

  it("binds ciphertext to its field, so source and destination cannot be swapped", () => {
    const source = encryptAddress(ADDRESS, "source", V0, 0);
    expect(failure(() => decryptAddress(source, "destination", V0))).toBe("integrity");
  });

  it("detects a tampered ciphertext", () => {
    const stored = encryptAddress(ADDRESS, "source", V0, 0);
    const parts = stored.split(":");
    const body = Buffer.from(parts[4], "base64url");
    body[0] ^= 0xff;
    parts[4] = body.toString("base64url");
    expect(failure(() => decryptAddress(parts.join(":"), "source", V0))).toBe("integrity");
  });

  it.each([
    ["plaintext", ADDRESS],
    ["an amount envelope", encryptProtectedAmount("10", new Map([[0, KEY_V0]]), 0)],
    ["a truncated envelope", "aenc:v0:abc:def"],
    ["an empty string", ""],
  ])("rejects %s as malformed", (_label, value) => {
    expect(failure(() => decryptAddress(value, "source", V0))).toBe("malformed");
  });

  it("reports a retired key version distinctly", () => {
    const stored = encryptAddress(ADDRESS, "source", V0_V1, 1);
    expect(failure(() => decryptAddress(stored, "source", V0))).toBe("unknown_key_version");
  });

  it("never puts the address in an error", () => {
    const source = encryptAddress(ADDRESS, "source", V0, 0);
    try {
      decryptAddress(source, "destination", V0);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(ADDRESS);
      expect(String((error as Error).message)).not.toContain(source);
    }
  });

  it("derives address keys distinct from the root key and from each other", () => {
    const [encryption] = [...V0.encryption.values()];
    const [lookup] = [...V0.lookup.values()];
    const root = Buffer.from(KEY_V0, "base64");
    expect(encryption.equals(root)).toBe(false);
    expect(lookup.equals(root)).toBe(false);
    expect(encryption.equals(lookup)).toBe(false);
  });
});

describe("lookup tokens", () => {
  it("is deterministic and versioned", () => {
    expect(lookupToken(ADDRESS, V0, 0)).toBe(lookupToken(ADDRESS, V0, 0));
    expect(lookupToken(ADDRESS, V0, 0)).toMatch(/^hmac:v0:[A-Za-z0-9_-]+$/);
    expect(lookupToken(ADDRESS, V0, 0)).not.toContain(ADDRESS);
  });

  it("matches the same address regardless of case and surrounding whitespace", () => {
    expect(lookupToken(`  ${ADDRESS.toLowerCase()} `, V0, 0)).toBe(lookupToken(ADDRESS, V0, 0));
    expect(normalizeAddress(" gabc ")).toBe("GABC");
  });

  it("differs between addresses and between key versions", () => {
    expect(lookupToken(ADDRESS, V0, 0)).not.toBe(lookupToken(`${ADDRESS}X`, V0, 0));
    expect(lookupToken(ADDRESS, V0_V1, 0)).not.toBe(lookupToken(ADDRESS, V0_V1, 1));
  });

  it("offers a token for every loaded version so lookups survive rotation", () => {
    expect(lookupTokens(ADDRESS, V0_V1)).toEqual([
      lookupToken(ADDRESS, V0_V1, 0),
      lookupToken(ADDRESS, V0_V1, 1),
    ]);
  });

  it("reads the key version from ciphertext and tokens", () => {
    expect(protectionVersion(encryptAddress(ADDRESS, "source", V0_V1, 1))).toBe(1);
    expect(protectionVersion(lookupToken(ADDRESS, V0_V1, 1))).toBe(1);
    expect(protectionVersion(null)).toBeNull();
    expect(protectionVersion(ADDRESS)).toBeNull();
  });
});

describe("PaymentAddressCipher", () => {
  const cipherV0 = new PaymentAddressCipher(V0, 0);
  const cipherV1 = new PaymentAddressCipher(V0_V1, 1);

  it("protects both addresses and never returns plaintext columns", () => {
    const columns = cipherV0.protect(ADDRESS, "GDEST");
    expect(columns.sourceAddress).toBeNull();
    expect(columns.destinationAddress).toBeNull();
    expect(JSON.stringify(columns)).not.toContain(ADDRESS);
    expect(cipherV0.reveal({ encrypted: columns.destinationAddressEncrypted, plaintext: null }, "destination")).toBe(
      "GDEST",
    );
  });

  it("prefers ciphertext and falls back to legacy plaintext", () => {
    const encrypted = encryptAddress(ADDRESS, "source", V0, 0);
    expect(cipherV0.reveal({ encrypted, plaintext: "GSTALE" }, "source")).toBe(ADDRESS);
    expect(cipherV0.reveal({ encrypted: null, plaintext: "GLEGACY" }, "source")).toBe("GLEGACY");
  });

  it("returns null from tryReveal for a corrupt or empty value", () => {
    expect(cipherV0.tryReveal({ encrypted: "aenc:v0:x:y:z", plaintext: null }, "source")).toBeNull();
    expect(cipherV0.tryReveal({ encrypted: null, plaintext: null }, "source")).toBeNull();
  });

  it("decrypts data from the previous key version after rotation, and flags it stale", () => {
    const old = cipherV0.protect(ADDRESS, "GDEST");
    expect(cipherV1.reveal({ encrypted: old.sourceAddressEncrypted, plaintext: null }, "source")).toBe(ADDRESS);
    expect(cipherV1.isStale(old.sourceAddressEncrypted)).toBe(true);
    expect(cipherV1.isStale(old.sourceAddressLookup)).toBe(true);
    expect(cipherV1.sourceLookupTokens(ADDRESS)).toContain(old.sourceAddressLookup);
    expect(cipherV1.isStale(cipherV1.protect(ADDRESS, "GDEST").sourceAddressEncrypted)).toBe(false);
  });

  it("is exposed by the keyring service on its active version", () => {
    const keyring = new PaymentEncryptionKeyringService({
      get: (key: string) =>
        ({
          paymentEncryptionKey: KEY_V0,
          "paymentEncryptionKeyVersions.1": KEY_V1,
          paymentEncryptionKeyVersion: 1,
        })[key],
    } as never);

    const cipher = keyring.addressCipher();
    expect(cipher.writeVersion).toBe(1);
    expect(cipher).toBe(keyring.addressCipher());
    expect(cipher.protect(ADDRESS, "GDEST").sourceAddressEncrypted).toMatch(/^aenc:v1:/);
  });
});
