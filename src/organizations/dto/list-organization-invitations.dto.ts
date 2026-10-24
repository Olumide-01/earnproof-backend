import { ApiPropertyOptional } from "@nestjs/swagger";
import { OrganizationInvitationStatus } from "@prisma/client";
import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, Max, Min } from "class-validator";

export class ListOrganizationInvitationsDto {
  @ApiPropertyOptional({
    description: "Filter by invitation status",
    enum: OrganizationInvitationStatus,
  })
  @IsOptional()
  @IsEnum(OrganizationInvitationStatus)
  status?: OrganizationInvitationStatus;

  @ApiPropertyOptional({
    description: "Page number (1-indexed, default 1)",
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: "Page size (default 20, max 100)",
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
