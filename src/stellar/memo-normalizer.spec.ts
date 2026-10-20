import {
  MAX_MEMO_TEXT_BYTES,
  normalizeMemo,
  normalizeMemoDetailed,
} from "./memo-normalizer";

const HASH = Buffer.alloc(32, 7).toString("base64");

describe("normalizeMemo", () => {
  it.each([
    [undefined, { type: "none" }],
    [{ memo_type: "none" }, { type: "none" }],
    [{ memo_type: "id", memo: "18446744073709551615" }, { type: "id", value: "18446744073709551615" }],
    [{ memo_type: "id", memo: "0" }, { type: "id", value: "0" }],
  ])("normalizes supported scalar memo values", (transaction, expected) => {
    expect(normalizeMemo(transaction)).toEqual(expected);
  });

  it("normalizes text memos", () => {
    expect(normalizeMemo({ memo_type: "text", memo: "Salary June" })).toEqual({
      type: "text",
      value: "Salary June",
      truncated: false,
    });
  });

  it.each([
    ["hash", "hash"],
    ["return", "return_hash"],
  ] as const)("normalizes %s memos", (memoType, expectedType) => {
    expect(normalizeMemo({ memo_type: memoType, memo: HASH })).toEqual({
      type: expectedType,
      value: HASH,
    });
  });

  it("accepts raw 32-byte hash memos", () => {
    expect(
      normalizeMemo({ memo_type: "hash", memo: new Uint8Array(32).fill(7) }),
    ).toEqual({ type: "hash", value: HASH });
  });

  it("replaces invalid UTF-8 bytes", () => {
    const memo = normalizeMemo({
      memo_type: "text",
      memo: Uint8Array.from([0x66, 0x80, 0x6f]),
    });

    expect(memo).toEqual({ type: "text", value: "f�o", truncated: false });
  });

  describe("byte limits", () => {
    it("accepts a text memo of exactly 28 UTF-8 bytes", () => {
      const value = "a".repeat(MAX_MEMO_TEXT_BYTES);
      expect(normalizeMemoDetailed({ memo_type: "text", memo: value })).toEqual({
        memo: { type: "text", value, truncated: false },
      });
    });

    it("measures bytes, not characters", () => {
      // 7 four-byte emoji are 28 bytes; 8 are 32.
      expect(normalizeMemo({ memo_type: "text", memo: "\u{1F600}".repeat(7) }).type).toBe("text");
      expect(
        normalizeMemoDetailed({ memo_type: "text", memo: "\u{1F600}".repeat(8) }),
      ).toEqual({ memo: { type: "none" }, omitted: "oversized" });
    });

    it.each([
      ["a 29-byte text memo", { memo_type: "text", memo: "a".repeat(29) }],
      ["a 501-character text memo", { memo_type: "text", memo: "x".repeat(501) }],
      ["a 33-byte hash memo", { memo_type: "hash", memo: new Uint8Array(33) }],
    ])("omits %s as oversized", (_label, transaction) => {
      expect(normalizeMemoDetailed(transaction)).toEqual({
        memo: { type: "none" },
        omitted: "oversized",
      });
    });
  });

  describe("empty memos", () => {
    it.each([
      ["an empty text memo", { memo_type: "text", memo: "" }],
      ["an empty byte text memo", { memo_type: "text", memo: new Uint8Array(0) }],
      ["memo type none with a stray value", { memo_type: "none", memo: "ignored" }],
    ])("treats %s as no memo without an omission", (_label, transaction) => {
      expect(normalizeMemoDetailed(transaction)).toEqual({ memo: { type: "none" } });
    });
  });

  describe("malformed and unsupported memos", () => {
    it.each([
      ["a non-numeric id", { memo_type: "id", memo: "12a" }],
      ["an id with a leading zero", { memo_type: "id", memo: "007" }],
      ["an id above 2^64-1", { memo_type: "id", memo: "18446744073709551616" }],
      ["a negative id", { memo_type: "id", memo: "-1" }],
      ["a missing id", { memo_type: "id" }],
      ["a non-base64 hash", { memo_type: "hash", memo: "not-a-hash" }],
      ["unpadded base64 hash", { memo_type: "hash", memo: HASH.slice(0, -1) }],
      ["a 31-byte return hash", { memo_type: "return", memo: Buffer.alloc(31).toString("base64") }],
      ["a non-string text value", { memo_type: "text", memo: 42 as unknown as string }],
    ])("omits %s as malformed", (_label, transaction) => {
      expect(normalizeMemoDetailed(transaction)).toEqual({
        memo: { type: "none" },
        omitted: "malformed",
      });
    });

    it("omits an unsupported memo type", () => {
      expect(normalizeMemoDetailed({ memo_type: "future", memo: "secret" })).toEqual({
        memo: { type: "none" },
        omitted: "unsupported",
      });
    });
  });
});
