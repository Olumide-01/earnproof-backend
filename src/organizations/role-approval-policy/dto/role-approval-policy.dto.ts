import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { OrganizationMemberRole } from "@prisma/client";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import {
  MAX_APPROVAL_EXPIRY_MINUTES,
  MAX_REQUIRED_APPROVALS,
  MIN_APPROVAL_EXPIRY_MINUTES,
  MIN_REQUIRED_APPROVALS,
  ORGANIZATION_ROLES,
} from "../role-approval-policy.rules";

/**
 * Settable policy fields.
 *
 * Structural problems (wrong type, unknown role) are rejected by validation
 * with 400 before the service runs. Platform-minimum problems (too few
 * approvals, OWNER missing from protected roles, ...) are reported by the
 * service as violation codes, so a preview can list them all.
 */
export class RoleApprovalPolicyRulesDto {
  @ApiProperty({
    enum: ORGANIZATION_ROLES,
    isArray: true,
    description: "Roles whose grant or removal requires approval. Must include OWNER and ADMIN.",
    example: ["OWNER", "ADMIN"],
  })
  @IsArray()
  @ArrayMaxSize(ORGANIZATION_ROLES.length)
  @ArrayUnique()
  @IsIn(ORGANIZATION_ROLES as string[], { each: true })
  protectedRoles!: OrganizationMemberRole[];

  @ApiProperty({
    enum: ORGANIZATION_ROLES,
    isArray: true,
    description: "Roles allowed to approve. Only OWNER and ADMIN are permitted.",
    example: ["OWNER", "ADMIN"],
  })
  @IsArray()
  @ArrayMaxSize(ORGANIZATION_ROLES.length)
  @ArrayUnique()
  @IsIn(ORGANIZATION_ROLES as string[], { each: true })
  approverRoles!: OrganizationMemberRole[];

  @ApiProperty({
    minimum: MIN_REQUIRED_APPROVALS,
    maximum: MAX_REQUIRED_APPROVALS,
    example: 2,
  })
  @IsInt()
  requiredApprovals!: number;

  @ApiProperty({
    minimum: MIN_APPROVAL_EXPIRY_MINUTES,
    maximum: MAX_APPROVAL_EXPIRY_MINUTES,
    description: "How long an approval request stays open before it expires.",
    example: 1440,
  })
  @IsInt()
  approvalExpiryMinutes!: number;

  @ApiProperty({
    description: "When true, a change that grants or removes OWNER needs an OWNER approver.",
    example: true,
  })
  @IsBoolean()
  ownerChangesRequireOwnerApproval!: boolean;

  @ApiPropertyOptional({
    description:
      "Platform invariant. Accepted only as `true`; `false` is reported as a violation.",
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  selfApprovalProhibited?: boolean;

  @ApiPropertyOptional({
    description:
      "Platform invariant. Accepted only as `true`; `false` is reported as a violation.",
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  targetApprovalProhibited?: boolean;
}

export class UpdateRoleApprovalPolicyDto extends RoleApprovalPolicyRulesDto {
  @ApiProperty({
    minimum: 0,
    description:
      "Version the update was based on (0 when the platform default is in force). " +
      "A mismatch with the active version is rejected with 409.",
    example: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class SampleRoleChangeDto {
  @ApiPropertyOptional({
    enum: ORGANIZATION_ROLES,
    nullable: true,
    description: "Current role; omit or null when the change grants membership.",
  })
  @IsOptional()
  @IsIn(ORGANIZATION_ROLES as string[])
  fromRole?: OrganizationMemberRole | null;

  @ApiPropertyOptional({
    enum: ORGANIZATION_ROLES,
    nullable: true,
    description: "New role; omit or null when the change removes membership.",
  })
  @IsOptional()
  @IsIn(ORGANIZATION_ROLES as string[])
  toRole?: OrganizationMemberRole | null;
}

export class PreviewRoleApprovalPolicyDto extends RoleApprovalPolicyRulesDto {
  @ApiPropertyOptional({
    minimum: 0,
    description: "When given, the preview also reports whether an update would be stale.",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;

  @ApiPropertyOptional({
    type: SampleRoleChangeDto,
    description: "Evaluate what the proposed policy would demand for this role change.",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SampleRoleChangeDto)
  sampleChange?: SampleRoleChangeDto;
}

export class ListRoleApprovalPolicyHistoryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({
    minimum: 1,
    description: "Return versions strictly older than this one (cursor).",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  beforeVersion?: number;
}

export class SeparationOfDutiesDto {
  @ApiProperty({ example: true })
  selfApprovalProhibited!: boolean;

  @ApiProperty({ example: true })
  targetApprovalProhibited!: boolean;

  @ApiProperty({ example: true })
  distinctApproversRequired!: boolean;
}

export class RoleApprovalPolicyResponseDto {
  @ApiProperty()
  organizationId!: string;

  @ApiProperty({ description: "0 when no policy has been stored and the platform default applies." })
  version!: number;

  @ApiProperty({ enum: ["ACTIVE", "SUPERSEDED"] })
  status!: "ACTIVE" | "SUPERSEDED";

  @ApiProperty({ description: "True when this is the implicit platform default." })
  isDefault!: boolean;

  @ApiProperty({ enum: ORGANIZATION_ROLES, isArray: true })
  protectedRoles!: OrganizationMemberRole[];

  @ApiProperty({ enum: ORGANIZATION_ROLES, isArray: true })
  approverRoles!: OrganizationMemberRole[];

  @ApiProperty()
  requiredApprovals!: number;

  @ApiProperty()
  approvalExpiryMinutes!: number;

  @ApiProperty()
  ownerChangesRequireOwnerApproval!: boolean;

  @ApiProperty({ type: SeparationOfDutiesDto })
  separationOfDuties!: SeparationOfDutiesDto;

  @ApiProperty({ nullable: true, type: String })
  supersedesId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  createdById!: string | null;

  @ApiProperty({ nullable: true, type: String, format: "date-time" })
  createdAt!: string | null;
}

export class RoleApprovalPolicyHistoryResponseDto {
  @ApiProperty({ type: RoleApprovalPolicyResponseDto, isArray: true })
  items!: RoleApprovalPolicyResponseDto[];

  @ApiProperty({
    nullable: true,
    type: Number,
    description: "Pass as beforeVersion to fetch the next page; null on the last page.",
  })
  nextBeforeVersion!: number | null;
}
