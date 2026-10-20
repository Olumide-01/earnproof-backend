import { ApiProperty } from "@nestjs/swagger";
import { ResourceStatus, UserRole } from "@prisma/client";

/**
 * The caller's own profile.
 *
 * The wallet address is the caller's own identity and is returned to them;
 * the wallet hash is an internal join key and is never part of a profile.
 */
export class UserProfileResponseDto {
  @ApiProperty({ description: "User unique ID" })
  id: string;

  @ApiProperty({ description: "The caller's own Stellar wallet address" })
  walletAddress: string;

  @ApiProperty({ description: "Self-managed display label", nullable: true, type: String })
  displayName: string | null;

  @ApiProperty({ enum: UserRole })
  role: UserRole;

  @ApiProperty({ enum: ResourceStatus })
  status: ResourceStatus;

  @ApiProperty({ description: "ISO 8601 timestamp of account creation" })
  createdAt: Date;

  @ApiProperty({ description: "ISO 8601 timestamp of the last profile change" })
  updatedAt: Date;

  @ApiProperty({ description: "ISO 8601 timestamp of the last login", nullable: true, type: Date })
  lastLoginAt: Date | null;
}

/**
 * An account as an administrator sees it.
 *
 * Carries neither the wallet address nor the wallet hash: account state is
 * managed by user id, and an administrative view has no need for the
 * re-identifying wallet material.
 */
export class AdminUserResponseDto {
  @ApiProperty({ description: "User unique ID" })
  id: string;

  @ApiProperty({ description: "Self-managed display label", nullable: true, type: String })
  displayName: string | null;

  @ApiProperty({ enum: UserRole })
  role: UserRole;

  @ApiProperty({ enum: ResourceStatus })
  status: ResourceStatus;

  @ApiProperty({ description: "ISO 8601 timestamp of account creation" })
  createdAt: Date;

  @ApiProperty({ description: "ISO 8601 timestamp of the last account change" })
  updatedAt: Date;

  @ApiProperty({ description: "ISO 8601 timestamp of the last login", nullable: true, type: Date })
  lastLoginAt: Date | null;
}

export class AccountStatusChangeResponseDto extends AdminUserResponseDto {
  @ApiProperty({ enum: ResourceStatus, description: "Status before this change" })
  previousStatus: ResourceStatus;

  @ApiProperty({ description: "Number of live sessions revoked by this change" })
  sessionsRevoked: number;
}

export class UserRoleChangeResponseDto extends AdminUserResponseDto {
  @ApiProperty({ enum: UserRole, description: "Role before this change" })
  previousRole: UserRole;
}
