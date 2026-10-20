import { ApiProperty } from "@nestjs/swagger";
import { IsEnum } from "class-validator";
import { OrganizationMemberRole } from "@prisma/client";

export class UpdateOrganizationMemberRoleDto {
  @ApiProperty({
    description: "New role to assign to the member",
    enum: ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
    example: "ADMIN",
  })
  @IsEnum(["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const)
  role: OrganizationMemberRole;
}
