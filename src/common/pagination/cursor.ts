import { BadRequestException } from "@nestjs/common";

/**
 * Bump this when the cursor payload shape changes. Cursors carrying an older
 * or newer version are rejected rather than guessed at, so a deploy that
 * changes the shape can never silently misinterpret a client's stale cursor.
 */
export const CURRENT_CURSOR_VERSION = 1;

export interface CursorPayload {
  v: number;
  /** ISO-8601 value of the row's ordering date field at the page boundary. */
  k: string;
  /** Unique id tiebreaker for rows that share the same ordering date value. */
  id: string;
}

export function encodeCursor(orderValue: Date, id: string): string {
  const payload: CursorPayload = {
    v: CURRENT_CURSOR_VERSION,
    k: orderValue.toISOString(),
    id,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * Decodes and validates an opaque pagination cursor. Throws
 * `BadRequestException` for malformed payloads or an unsupported version,
 * so callers can propagate a 4xx without duplicating the validation.
 */
export function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new BadRequestException("Invalid pagination cursor");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as CursorPayload).v !== "number" ||
    typeof (parsed as CursorPayload).k !== "string" ||
    typeof (parsed as CursorPayload).id !== "string" ||
    (parsed as CursorPayload).id.length === 0 ||
    Number.isNaN(Date.parse((parsed as CursorPayload).k))
  ) {
    throw new BadRequestException("Invalid pagination cursor");
  }

  if ((parsed as CursorPayload).v !== CURRENT_CURSOR_VERSION) {
    throw new BadRequestException("Unsupported pagination cursor version");
  }

  return parsed as CursorPayload;
}
