import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsOptional,
  IsInt,
  Min,
  Max,
  IsEnum,
} from "class-validator";
import { Type } from "class-transformer";
import { OrganizationMemberRole, ResourceStatus } from "@prisma/client";

export class ListOrganizationMembersDto {
  @ApiPropertyOptional({
    description: "Page number (1-indexed)",
    example: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: "Items per page (max 100)",
    example: 20,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: "Filter by role",
    enum: ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
    example: "MEMBER",
  })
  @IsOptional()
  @IsEnum(["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const)
  role?: OrganizationMemberRole;

  @ApiPropertyOptional({
    description: "Filter by status",
    enum: ["ACTIVE", "PENDING", "SUSPENDED", "REVOKED", "DELETED"],
    example: "ACTIVE",
  })
  @IsOptional()
  @IsEnum(["ACTIVE", "PENDING", "SUSPENDED", "REVOKED", "DELETED"] as const)
  status?: ResourceStatus;
}
