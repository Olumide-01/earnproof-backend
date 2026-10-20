import { ApiProperty } from "@nestjs/swagger";
import { OrganizationMemberRole, ResourceStatus } from "@prisma/client";

export class OrganizationMemberResponseDto {
  @ApiProperty({
    description: "Organization member record ID",
    example: "clv1234567890abcdef",
  })
  id: string;

  @ApiProperty({
    description: "Organization ID",
    example: "clv0987654321fedcba",
  })
  organizationId: string;

  @ApiProperty({
    description: "User ID",
    example: "clv1234567890abcdef",
  })
  userId: string;

  @ApiProperty({
    description: "User wallet address",
    example: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  })
  walletAddress: string;

  @ApiProperty({
    description: "Member role in the organization",
    enum: ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
    example: "MEMBER",
  })
  role: OrganizationMemberRole;

  @ApiProperty({
    description: "Member status",
    enum: ["ACTIVE", "PENDING", "SUSPENDED", "REVOKED", "DELETED"],
    example: "ACTIVE",
  })
  status: ResourceStatus;

  @ApiProperty({
    description: "When user joined the organization",
    example: "2026-09-25T12:34:56.789Z",
    type: String,
    nullable: true,
  })
  joinedAt: Date | null;

  @ApiProperty({
    description: "When membership record was created",
    example: "2026-09-25T12:34:56.789Z",
  })
  createdAt: Date;

  @ApiProperty({
    description: "When membership record was last updated",
    example: "2026-09-25T12:34:56.789Z",
  })
  updatedAt: Date;
}
