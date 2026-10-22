import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString } from "class-validator";

export class DeclineOrganizationInvitationDto {
  @ApiProperty({
    description: "The raw invitation secret token provided to the invitee",
  })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiPropertyOptional({
    description: "Optional organization ID to enforce tenant binding",
  })
  @IsOptional()
  @IsString()
  organizationId?: string;
}
