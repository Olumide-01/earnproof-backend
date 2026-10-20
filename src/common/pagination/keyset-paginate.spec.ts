import { BadRequestException } from "@nestjs/common";
import { encodeCursor } from "./cursor";
import {
  buildPage,
  cursorOrderBy,
  cursorWhereFragment,
} from "./keyset-paginate";

describe("keyset pagination helpers", () => {
  describe("cursorWhereFragment", () => {
    it("returns undefined when there is no cursor (first page)", () => {
      expect(cursorWhereFragment(undefined, "createdAt")).toBeUndefined();
    });

    it("builds an OR fragment that resumes strictly after the cursor", () => {
      const date = new Date("2026-08-24T12:00:00.000Z");
      const cursor = encodeCursor(date, "row_5");

      const fragment = cursorWhereFragment(cursor, "createdAt");

      expect(fragment).toEqual({
        OR: [
          { createdAt: { lt: date } },
          { createdAt: date, id: { lt: "row_5" } },
        ],
      });
    });

    it("propagates BadRequestException for an invalid cursor", () => {
      expect(() => cursorWhereFragment("garbage", "createdAt")).toThrow(
        BadRequestException,
      );
    });
  });

  describe("cursorOrderBy", () => {
    it("orders by the date field then id, both descending", () => {
      expect(cursorOrderBy("occurredAt")).toEqual([
        { occurredAt: "desc" },
        { id: "desc" },
      ]);
    });
  });

  describe("buildPage", () => {
    const row = (id: string, createdAt: string) => ({
      id,
      createdAt: new Date(createdAt),
    });

    it("returns hasMore=false and no cursor when rows fit within the limit", () => {
      const rows = [row("a", "2026-01-03"), row("b", "2026-01-02")];

      const { data, pageInfo } = buildPage(rows, 2, "createdAt");

      expect(data).toHaveLength(2);
      expect(pageInfo).toEqual({ hasMore: false, nextCursor: null });
    });

    it("trims the over-fetched row and encodes nextCursor from the last kept row", () => {
      const rows = [
        row("a", "2026-01-03"),
        row("b", "2026-01-02"),
        row("c", "2026-01-01"),
      ];

      const { data, pageInfo } = buildPage(rows, 2, "createdAt");

      expect(data.map((r) => r.id)).toEqual(["a", "b"]);
      expect(pageInfo.hasMore).toBe(true);
      expect(pageInfo.nextCursor).toBe(
        encodeCursor(new Date("2026-01-02"), "b"),
      );
    });

    it("handles an empty result set", () => {
      const { data, pageInfo } = buildPage([], 20, "createdAt");

      expect(data).toEqual([]);
      expect(pageInfo).toEqual({ hasMore: false, nextCursor: null });
    });
  });
});
