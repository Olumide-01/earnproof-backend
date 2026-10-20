import { CursorPayload, decodeCursor, encodeCursor } from "./cursor";
import { PageInfo } from "./pagination.dto";

/**
 * Builds the `where` fragment that resumes a keyset-ordered query after the
 * given cursor. Caller merges the result into its own Prisma `where` clause.
 *
 * Ordering is always `[orderField desc, idField desc]`, so "after the cursor"
 * means strictly less than the cursor's order value, or equal with a strictly
 * lesser id.
 */
export function cursorWhereFragment(
  cursor: string | undefined,
  orderField: string,
  idField = "id",
): Record<string, unknown> | undefined {
  if (!cursor) {
    return undefined;
  }

  const decoded = decodeCursor(cursor);
  const orderValue = new Date(decoded.k);

  return {
    OR: [
      { [orderField]: { lt: orderValue } },
      { [orderField]: orderValue, [idField]: { lt: decoded.id } },
    ],
  };
}

/** `orderBy` fragment matching the ordering assumed by `cursorWhereFragment`. */
export function cursorOrderBy(orderField: string, idField = "id") {
  return [{ [orderField]: "desc" as const }, { [idField]: "desc" as const }];
}

/**
 * Splits an over-fetched (`limit + 1`) row set into the page to return plus
 * `pageInfo`, encoding the next cursor from the last row of the page.
 */
export function buildPage<T, K extends keyof T & string>(
  rows: T[],
  limit: number,
  orderField: K,
  idField: K = "id" as K,
): { data: T[]; pageInfo: PageInfo } {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);

  const nextCursor =
    hasMore && last
      ? encodeCursor(last[orderField] as unknown as Date, String(last[idField]))
      : null;

  return { data, pageInfo: { hasMore, nextCursor } };
}

export type { CursorPayload };
