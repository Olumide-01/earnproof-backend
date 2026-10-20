import { ApiProperty } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { IsEnum } from "class-validator";

export class UpdateUserRoleDto {
  @ApiProperty({ enum: UserRole, description: "Target role" })
  @IsEnum(UserRole)
  role: UserRole;
}
