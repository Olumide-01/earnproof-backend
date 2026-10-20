import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ResourceStatus } from "@prisma/client";
import { IsString, Matches, MaxLength, MinLength } from "class-validator";
import {
  DeletionBlockerCode,
  OrganizationLifecycleState,
} from "../organization-lifecycle.policy";

export class PlaceLegalHoldDto {
  @ApiProperty({
    description:
      "Case or matter reference recorded with the hold and in the audit trail. " +
      "Letters, digits, spaces and . _ : / # - only; no personal data.",
    example: "LEGAL-2026-014",
    maxLength: 64,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9 ._:/#-]*$/, {
    message: "reference may contain letters, digits, spaces and . _ : / # - only",
  })
  reference!: string;
}

export class OrganizationLifecycleResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: ResourceStatus, description: "Unchanged by archive and restore" })
  status!: ResourceStatus;

  @ApiProperty({ enum: OrganizationLifecycleState })
  lifecycleState!: OrganizationLifecycleState;

  @ApiProperty({ nullable: true, type: Date })
  archivedAt!: Date | null;

  @ApiProperty()
  legalHold!: boolean;

  @ApiProperty({ nullable: true, type: Date })
  deletedAt!: Date | null;
}

export class DeletionBlockerDto {
  @ApiProperty({ enum: DeletionBlockerCode })
  code!: DeletionBlockerCode;

  @ApiPropertyOptional({ description: "Number of dependent records behind the blocker" })
  count?: number;
}

export class DeletionEligibilityResponseDto {
  @ApiProperty()
  organizationId!: string;

  @ApiProperty({ enum: OrganizationLifecycleState })
  lifecycleState!: OrganizationLifecycleState;

  @ApiProperty()
  eligible!: boolean;

  @ApiProperty({
    type: [DeletionBlockerDto],
    description: "Codes and counts only; never identifiers of the dependent records.",
  })
  blockers!: DeletionBlockerDto[];

  @ApiProperty({
    nullable: true,
    type: Date,
    description: "End of the minimum archive period; deletion is accepted strictly after it.",
  })
  deletableAfter!: Date | null;
}

export class OrganizationDeletionResponseDto extends OrganizationLifecycleResponseDto {
  @ApiProperty()
  apiKeysRevoked!: number;

  @ApiProperty()
  webhooksDeleted!: number;

  @ApiProperty()
  webhookDeliveriesDeleted!: number;

  @ApiProperty()
  idempotencyRecordsDeleted!: number;
}
