import { ApiProperty } from "@nestjs/swagger";
import { IsEnum, IsString, IsUUID } from "class-validator";
import { OrganizationMemberRole } from "@prisma/client";

export class AssignOrganizationMemberDto {
  @ApiProperty({
    description: "User ID to assign to organization",
    example: "clv1234567890abcdef",
  })
  @IsString()
  userId: string;

  @ApiProperty({
    description: "Role to assign to the member",
    enum: ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
    example: "MEMBER",
  })
  @IsEnum(["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const)
  role: OrganizationMemberRole;
}
