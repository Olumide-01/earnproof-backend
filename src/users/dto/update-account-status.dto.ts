import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ResourceStatus } from "@prisma/client";
import { IsEnum, IsIn, IsOptional } from "class-validator";
import {
  ASSIGNABLE_ACCOUNT_STATUSES,
  AccountStatusReason,
} from "../../auth/account-status.policy";

export class UpdateAccountStatusDto {
  @ApiProperty({
    description:
      "Target status. SUSPENDED is reversible; REVOKED is terminal. Both revoke every live session.",
    enum: ASSIGNABLE_ACCOUNT_STATUSES,
  })
  @IsEnum(ResourceStatus)
  @IsIn(ASSIGNABLE_ACCOUNT_STATUSES)
  status: ResourceStatus;

  @ApiPropertyOptional({
    description: "Bounded reason code recorded in the audit trail",
    enum: AccountStatusReason,
  })
  @IsOptional()
  @IsEnum(AccountStatusReason)
  reason?: AccountStatusReason;
}
