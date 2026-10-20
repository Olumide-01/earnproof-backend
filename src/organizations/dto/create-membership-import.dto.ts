import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsArray, IsOptional, IsString, ValidateNested, ArrayMaxSize, ArrayNotEmpty } from "class-validator";
import { OrganizationMemberRole } from "@prisma/client";

export class MembershipImportRowDto {
  @ApiProperty({
    description: "Wallet address of the member to import",
    example: "GCEXAMPLE1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  })
  @IsString()
  walletAddress!: string;

  @ApiProperty({
    description: "Requested role for the member",
    enum: OrganizationMemberRole,
    example: OrganizationMemberRole.MEMBER
  })
  role!: OrganizationMemberRole;
}

export class CreateMembershipImportDto {
  @ApiProperty({
    description: "Version of the import format",
    example: "1.0"
  })
  @IsOptional()
  @IsString()
  version?: string;

  @ApiProperty({
    description: "Optional filename for reference",
    example: "members.csv"
  })
  @IsOptional()
  @IsString()
  filename?: string;

  @ApiProperty({
    description: "Array of membership rows to import",
    type: [MembershipImportRowDto],
    maxItems: 1000
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(1000, { message: "Cannot import more than 1000 members at once" })
  @ValidateNested({ each: true })
  @Type(() => MembershipImportRowDto)
  members!: MembershipImportRowDto[];
}