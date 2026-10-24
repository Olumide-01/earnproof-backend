import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { OrganizationMemberRole } from "@prisma/client";
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from "class-validator";

export class CreateOrganizationInvitationDto {
  @ApiProperty({
    description: "Stellar wallet address of the invited user (G...)",
    example: "GA2C5RFPE6GCKMY3Z4BDTJNNCYDCPQDZJNO5ZPBG6R7CQBFE5QDKQ6Y7",
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^G[A-Z2-7]{55}$/, {
    message: "recipientWalletAddress must be a valid Stellar public key (G...)",
  })
  recipientWalletAddress: string;

  @ApiProperty({
    description: "Organization member role to grant upon acceptance",
    enum: OrganizationMemberRole,
    example: OrganizationMemberRole.MEMBER,
  })
  @IsEnum(OrganizationMemberRole)
  role: OrganizationMemberRole;

  @ApiPropertyOptional({
    description:
      "Bounded invitation time-to-live in seconds (min: 300 / 5 min, max: 2592000 / 30 days, default: 604800 / 7 days)",
    example: 604800,
  })
  @IsOptional()
  @IsInt()
  @Min(300, { message: "Invitation TTL cannot be less than 300 seconds (5 minutes)" })
  @Max(2592000, { message: "Invitation TTL cannot exceed 2592000 seconds (30 days)" })
  ttlSeconds?: number;
}
