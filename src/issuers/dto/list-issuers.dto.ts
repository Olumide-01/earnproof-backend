import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsEnum } from "class-validator";
import { ResourceStatus } from "@prisma/client";
import { CursorPaginationQueryDto } from "../../common/pagination/pagination.dto";

export class ListIssuersDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({
    description: "Filter by issuer status",
    enum: ["ACTIVE", "PENDING", "SUSPENDED", "REVOKED", "DELETED"],
  })
  @IsOptional()
  @IsEnum(ResourceStatus)
  status?: ResourceStatus;

  @ApiPropertyOptional({
    description: "Filter by organization ID",
    example: "cuid123",
  })
  @IsOptional()
  organizationId?: string;
}
