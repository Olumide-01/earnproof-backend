import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class InspectOrganizationInvitationDto {
  @ApiProperty({
    description: "The raw invitation secret token to inspect",
  })
  @IsString()
  @IsNotEmpty()
  token: string;
}
