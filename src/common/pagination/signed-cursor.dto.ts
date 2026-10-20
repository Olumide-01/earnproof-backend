import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";

/**
 * Query DTO for paginated list endpoints using signed cursors.
 *
 * Clients pass an opaque cursor token (received from a previous response's nextCursor)
 * along with the same filter parameters used in that request. The service validates
 * that the cursor matches the current filters (tenant, sort order, etc.) before using it.
 */
export class SignedCursorPaginationQueryDto {
  /**
   * Maximum number of items per page (1-100).
   * The service returns up to this many items, plus a nextCursor if there are more.
   */
  @ApiPropertyOptional({
    description: "Maximum number of results (1-100)",
    default: 20,
    example: 20,
  })
  @IsOptional()
  @Transform(({ value }) => {
    const parsed = typeof value === "string" ? parseInt(value, 10) : value;
    return Math.min(Math.max(parsed, 1), 100);
  })
  limit?: number;

  /**
   * Opaque signed cursor token from a previous response.
   *
   * Clients must pass the exact cursor (unchanged) along with the same filter
   * parameters. If filters change, the cursor is rejected.
   *
   * The cursor itself is tamper-proof and time-bound, so clients cannot:
   * - Modify it to skip items or seek to a different position
   * - Use it across different filters (cross-filter protection)
   * - Use it across different tenants (cross-tenant protection)
   * - Use an expired cursor (time-bound validity)
   */
  @ApiPropertyOptional({
    description: "Pagination cursor from a previous response's nextCursor",
    example: "eyJ2ZXJzaW9uIjoiMSIsInNpZ25hdHVyZSI6IjBhMWIyYzNkIn0",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: "cursor must be a valid base64url string",
  })
  cursor?: string;
}

/**
 * Page info returned in paginated list responses.
 *
 * Clients use `nextCursor` to fetch the next page by passing it as the `cursor`
 * parameter in their next request (with the same filters).
 */
export interface PaginationPageInfo {
  /**
   * Whether there are more items after this page.
   * If true, the client should pass `nextCursor` in their next request.
   */
  hasMore: boolean;

  /**
   * Opaque signed cursor for the next page (if hasMore is true).
   * Clients pass this unchanged in the next request along with the same filters.
   * If hasMore is false, this is null.
   */
  nextCursor: string | null;
}

/**
 * Standard paginated list response shape used across all cursor-paginated endpoints.
 *
 * @template T The type of items in the list
 */
export interface PaginatedListResponse<T> {
  /** The items in this page. */
  data: T[];

  /** Pagination metadata and cursor for next page. */
  pageInfo: PaginationPageInfo;
}
