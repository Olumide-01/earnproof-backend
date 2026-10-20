import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { PaymentEncryptionKeyringService } from "../common/crypto/payment-encryption-keyring.service";
import { normalizeMemoDetailed } from "../stellar/memo-normalizer";
import {
  MAX_STORED_MEMO_BYTES,
  MemoCipher,
  decodeStoredMemo,
  encodeStoredMemo,
  parseStoredMemo,
} from "./payment-memo";

const cipher: MemoCipher = new PaymentEncryptionKeyringService({
  getOrThrow: (key: string) =>
    key === "paymentEncryptionKey"
      ? "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
      : undefined,
} as never);

const HASH = Buffer.alloc(32, 9).toString("base64");

/** Fixtures from Horizon transaction records, one per Stellar memo type. */
const FIXTURES = {
  text: { memo_type: "text", memo: "Invoice 42" },
  id: { memo_type: "id", memo: "18446744073709551615" },
  hash: { memo_type: "hash", memo: HASH },
  returnHash: { memo_type: "return", memo: HASH },
  empty: { memo_type: "text", memo: "" },
  none: { memo_type: "none" },
  oversized: { memo_type: "text", memo: "x".repeat(29) },
  unsupported: { memo_type: "future", memo: "anything" },
} as const;

function store(fixture: keyof typeof FIXTURES) {
  return encodeStoredMemo(normalizeMemoDetailed(FIXTURES[fixture]), cipher);
}

describe("payment memo persistence (version 2)", () => {
  describe("round trip by memo type", () => {
    it.each([
      ["text", { type: "text", value: "Invoice 42", truncated: false }],
      ["id", { type: "id", value: "18446744073709551615" }],
      ["hash", { type: "hash", value: HASH }],
      ["returnHash", { type: "return_hash", value: HASH }],
    ] as const)("stores a %s memo encrypted and reads it back", (fixture, expected) => {
      const stored = store(fixture);

      expect(stored).toEqual({
        version: 2,
        type: expected.type,
        ciphertext: expect.stringMatching(/^enc:v0:/),
      });
      expect(JSON.stringify(stored)).not.toContain(expected.value);
      expect(decodeStoredMemo(stored as never, cipher)).toEqual(expected);
    });

    it("stores an empty memo as none without an omission", () => {
      expect(store("empty")).toEqual({ version: 2, type: "none" });
      expect(store("none")).toEqual({ version: 2, type: "none" });
    });

    it.each([
      ["oversized", "oversized"],
      ["unsupported", "unsupported"],
    ] as const)("records a %s memo as an omission, never its content", (fixture, reason) => {
      const stored = store(fixture);

      expect(stored).toEqual({ version: 2, type: "none", omitted: reason });
      expect(JSON.stringify(stored)).not.toContain("xxx");
      expect(JSON.stringify(stored)).not.toContain("anything");
      expect(decodeStoredMemo(stored as never, cipher)).toEqual({ type: "none" });
    });
  });

  describe("byte limits before database writes", () => {
    it("keeps every stored fixture under the limit", () => {
      for (const fixture of Object.keys(FIXTURES) as Array<keyof typeof FIXTURES>) {
        expect(
          Buffer.byteLength(JSON.stringify(store(fixture))),
        ).toBeLessThanOrEqual(MAX_STORED_MEMO_BYTES);
      }
    });

    it("replaces a value whose encoding would exceed the limit with an omission", () => {
      const inflating: MemoCipher = {
        encrypt: () => "c".repeat(MAX_STORED_MEMO_BYTES),
        decrypt: () => "",
      };

      expect(
        encodeStoredMemo(
          { memo: { type: "text", value: "short", truncated: false } },
          inflating,
        ),
      ).toEqual({ version: 2, type: "none", omitted: "oversized" });
    });

    it("refuses to read an oversized stored value", () => {
      expect(
        parseStoredMemo({
          version: 2,
          type: "text",
          ciphertext: "c".repeat(MAX_STORED_MEMO_BYTES),
        }),
      ).toBeNull();
    });
  });

  describe("reading untrusted stored JSON", () => {
    it.each([
      ["null", null],
      ["legacy v1 text", { type: "text", value: "Invoice 42", truncated: false }],
      ["legacy v1 none", { type: "none" }],
      ["legacy plaintext string", "Invoice 42"],
      ["a number", 42],
      ["an array", [{ version: 2, type: "none" }]],
      ["wrong version", { version: 3, type: "none" }],
      ["string version", { version: "2", type: "none" }],
      ["unknown type", { version: 2, type: "future", ciphertext: "x" }],
      ["missing ciphertext", { version: 2, type: "text" }],
      ["extra fields", { version: 2, type: "text", ciphertext: "x", value: "Invoice 42" }],
      ["unknown omission", { version: 2, type: "none", omitted: "because" }],
      ["undecryptable ciphertext", { version: 2, type: "text", ciphertext: "enc:v0:bad:bad:bad" }],
    ])("treats %s as no memo", (_label, value) => {
      expect(decodeStoredMemo(value as never, cipher)).toEqual({ type: "none" });
    });

    it("refuses a ciphertext moved to a different memo type", () => {
      const text = store("text") as { ciphertext: string };

      expect(
        decodeStoredMemo(
          { version: 2, type: "id", ciphertext: text.ciphertext } as never,
          cipher,
        ),
      ).toEqual({ type: "none" });
    });

    it("re-validates decrypted values against the memo rules", () => {
      const forged = {
        version: 2,
        type: "id",
        ciphertext: cipher.encrypt("id:not-a-number"),
      };

      expect(decodeStoredMemo(forged as never, cipher)).toEqual({ type: "none" });
    });
  });

  describe("proof eligibility independence", () => {
    // Proof issuance must never read Payment.memo: memo content is
    // unvalidated user input. This scans every non-test source file outside
    // src/payments and src/stellar for any reference to the memo column.
    it("no module outside payments and stellar reads Payment.memo", () => {
      const srcRoot = join(__dirname, "..");
      const offenders: string[] = [];

      const walk = (directory: string) => {
        for (const entry of readdirSync(directory)) {
          const path = join(directory, entry);
          if (statSync(path).isDirectory()) {
            walk(path);
            continue;
          }
          if (!path.endsWith(".ts") || path.endsWith(".spec.ts")) continue;
          const rel = relative(srcRoot, path).replace(/\\/g, "/");
          if (rel.startsWith("payments/") || rel.startsWith("stellar/")) continue;
          const source = readFileSync(path, "utf8");
          if (/\.memo\b|\bmemo\s*:\s*true\b/.test(source)) offenders.push(rel);
        }
      };
      walk(srcRoot);

      expect(offenders).toEqual([]);
    });
  });
});
