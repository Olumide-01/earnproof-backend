import { randomBytes } from "crypto";
import {
  archiveDigestMatches,
  decodeArchiveKey,
  decryptArchive,
  encryptArchive,
} from "./export-archive-crypto";

describe("export archive crypto", () => {
  const key = randomBytes(32);

  it("round-trips a plaintext archive", () => {
    const plaintext = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
    const encrypted = encryptArchive(plaintext, key);

    expect(encrypted.content.toString("utf8")).toMatch(/^encv1:/);
    expect(decryptArchive(encrypted.content, key)).toEqual(plaintext);
    expect(encrypted.sizeBytes).toBe(encrypted.content.length);
  });

  it("produces a digest over the ciphertext that verifies", () => {
    const encrypted = encryptArchive(Buffer.from("data"), key);
    expect(archiveDigestMatches(encrypted.content, encrypted.digest)).toBe(true);
    expect(archiveDigestMatches(encrypted.content, "deadbeef")).toBe(false);
  });

  it("uses a fresh IV per encryption, so identical inputs differ", () => {
    const a = encryptArchive(Buffer.from("same"), key);
    const b = encryptArchive(Buffer.from("same"), key);
    expect(a.content.equals(b.content)).toBe(false);
  });

  it("fails loudly when the archive is tampered with (GCM tag)", () => {
    const encrypted = encryptArchive(Buffer.from("secret"), key);
    const tampered = Buffer.from(
      encrypted.content.toString("utf8").slice(0, -2) + "AA",
      "utf8",
    );
    expect(() => decryptArchive(tampered, key)).toThrow();
  });

  it("fails to decrypt with the wrong key", () => {
    const encrypted = encryptArchive(Buffer.from("secret"), key);
    expect(() => decryptArchive(encrypted.content, randomBytes(32))).toThrow();
  });

  it("rejects a key that does not decode to 32 bytes", () => {
    expect(() => decodeArchiveKey("00")).toThrow(/32 bytes/);
    expect(() => encryptArchive(Buffer.from("x"), randomBytes(16))).toThrow(
      /32 bytes/,
    );
  });

  it("accepts hex and base64 key material", () => {
    const raw = randomBytes(32);
    expect(decodeArchiveKey(raw.toString("hex"))).toEqual(raw);
    expect(decodeArchiveKey(raw.toString("base64"))).toEqual(raw);
  });
});
