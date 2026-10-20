import { ApiProperty } from "@nestjs/swagger";
import { IsEnum, IsOptional, IsString, ValidateIf } from "class-validator";
import { AccessReviewDecision, OrganizationMemberRole } from "@prisma/client";

export class ReviewEntryDecisionDto {
  @ApiProperty({ enum: AccessReviewDecision })
  @IsEnum(AccessReviewDecision)
  decision!: AccessReviewDecision;

  @ApiProperty({ 
    enum: OrganizationMemberRole, 
    required: false,
    description: "Required when decision is ROLE_CHANGE" 
  })
  @ValidateIf(o => o.decision === AccessReviewDecision.ROLE_CHANGE)
  @IsEnum(OrganizationMemberRole)
  recommendedRole?: OrganizationMemberRole;

  @ApiProperty({ 
    required: false,
    description: "Optional notes about the decision" 
  })
  @IsOptional()
  @IsString()
  notes?: string;
}