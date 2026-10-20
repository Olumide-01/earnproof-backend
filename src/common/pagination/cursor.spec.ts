import { BadRequestException } from "@nestjs/common";
import { decodeCursor, encodeCursor, CURRENT_CURSOR_VERSION } from "./cursor";

describe("pagination cursor", () => {
  it("round-trips a value through encode and decode", () => {
    const date = new Date("2026-08-24T12:00:00.000Z");
    const cursor = encodeCursor(date, "row_1");

    const decoded = decodeCursor(cursor);

    expect(decoded).toEqual({
      v: CURRENT_CURSOR_VERSION,
      k: date.toISOString(),
      id: "row_1",
    });
  });

  it("produces an opaque, non-reversible-by-inspection string", () => {
    const cursor = encodeCursor(new Date(), "secret-looking-id");

    expect(cursor).not.toContain("secret-looking-id");
  });

  it("rejects a cursor that is not valid base64url JSON", () => {
    expect(() => decodeCursor("not-base64url-json")).toThrow(
      BadRequestException,
    );
  });

  it("rejects a cursor missing required fields", () => {
    const malformed = Buffer.from(JSON.stringify({ v: 1 })).toString(
      "base64url",
    );

    expect(() => decodeCursor(malformed)).toThrow(BadRequestException);
  });

  it("rejects a cursor with a non-date `k` value", () => {
    const malformed = Buffer.from(
      JSON.stringify({ v: 1, k: "not-a-date", id: "x" }),
    ).toString("base64url");

    expect(() => decodeCursor(malformed)).toThrow(BadRequestException);
  });

  it("rejects a cursor with an empty id", () => {
    const malformed = Buffer.from(
      JSON.stringify({ v: 1, k: new Date().toISOString(), id: "" }),
    ).toString("base64url");

    expect(() => decodeCursor(malformed)).toThrow(BadRequestException);
  });

  it("rejects a cursor with an unsupported version, even if otherwise well-formed", () => {
    const futureVersion = Buffer.from(
      JSON.stringify({
        v: CURRENT_CURSOR_VERSION + 1,
        k: new Date().toISOString(),
        id: "row_1",
      }),
    ).toString("base64url");

    expect(() => decodeCursor(futureVersion)).toThrow(BadRequestException);
  });
});
