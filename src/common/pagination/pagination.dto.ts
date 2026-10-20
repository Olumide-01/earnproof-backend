import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

/**
 * Shared query fields for keyset (cursor-based) list endpoints. Module-specific
 * list DTOs extend this alongside their own filters.
 */
export class CursorPaginationQueryDto {
  @ApiPropertyOptional({
    description:
      "Opaque cursor from a previous page's `pageInfo.nextCursor`. Omit for the first page.",
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    description: "Maximum number of items to return.",
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export interface PageInfo {
  hasMore: boolean;
  nextCursor: string | null;
}
