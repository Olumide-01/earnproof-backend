import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { OrganizationInvitationStatus, OrganizationMemberRole } from "@prisma/client";

export class OrganizationInvitationResponseDto {
  @ApiProperty({ description: "Unique invitation ID" })
  id: string;

  @ApiProperty({ description: "Organization ID (tenant binding)" })
  organizationId: string;

  @ApiProperty({
    description: "Role offered upon acceptance",
    enum: OrganizationMemberRole,
  })
  role: OrganizationMemberRole;

  @ApiProperty({ description: "ID of the inviting administrator" })
  inviterId: string;

  @ApiProperty({ description: "Target recipient Stellar wallet address" })
  recipientWalletAddress: string;

  @ApiProperty({ description: "SHA-256 hash of recipient wallet address" })
  recipientWalletHash: string;

  @ApiProperty({
    description: "Invitation lifecycle status",
    enum: OrganizationInvitationStatus,
  })
  status: OrganizationInvitationStatus;

  @ApiProperty({ description: "Invitation expiration timestamp" })
  expiresAt: Date;

  @ApiPropertyOptional({ description: "Timestamp when accepted" })
  acceptedAt?: Date | null;

  @ApiPropertyOptional({ description: "ID of user who accepted" })
  acceptedById?: string | null;

  @ApiPropertyOptional({ description: "Timestamp when declined" })
  declinedAt?: Date | null;

  @ApiPropertyOptional({ description: "ID of user who declined" })
  declinedById?: string | null;

  @ApiPropertyOptional({ description: "Timestamp when revoked" })
  revokedAt?: Date | null;

  @ApiPropertyOptional({ description: "ID of user who revoked" })
  revokedById?: string | null;

  @ApiProperty({ description: "Invitation creation timestamp" })
  createdAt: Date;

  @ApiProperty({ description: "Invitation last update timestamp" })
  updatedAt: Date;
}

export class CreateOrganizationInvitationResponseDto extends OrganizationInvitationResponseDto {
  @ApiProperty({
    description:
      "Plaintext invitation token. Issued once upon creation; never stored or returned again.",
  })
  token: string;
}

export class InspectOrganizationInvitationResponseDto {
  @ApiProperty({ description: "Invitation ID" })
  id: string;

  @ApiProperty({ description: "Organization ID" })
  organizationId: string;

  @ApiProperty({ description: "Organization name" })
  organizationName: string;

  @ApiProperty({
    description: "Role offered upon acceptance",
    enum: OrganizationMemberRole,
  })
  role: OrganizationMemberRole;

  @ApiProperty({ description: "Intended recipient wallet address" })
  recipientWalletAddress: string;

  @ApiProperty({
    description: "Invitation status (computed as EXPIRED if past expiry date)",
    enum: OrganizationInvitationStatus,
  })
  status: OrganizationInvitationStatus;

  @ApiProperty({ description: "Expiration timestamp" })
  expiresAt: Date;

  @ApiProperty({ description: "Creation timestamp" })
  createdAt: Date;

  @ApiProperty({ description: "Inviter ID" })
  inviterId: string;
}

export class PaginatedOrganizationInvitationsDto {
  @ApiProperty({
    type: [OrganizationInvitationResponseDto],
    description: "List of invitations",
  })
  items: OrganizationInvitationResponseDto[];

  @ApiProperty({ description: "Total count of invitations matching query" })
  total: number;

  @ApiProperty({ description: "Current page number" })
  page: number;

  @ApiProperty({ description: "Page limit" })
  limit: number;
}
