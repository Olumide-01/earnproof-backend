import { ApiProperty } from "@nestjs/swagger";
import { IsArray, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from "class-validator";

export class CreateSupportAccessGrantDto {
  @ApiProperty({ description: "Target support user ID who receives access" })
  @IsString()
  @IsNotEmpty()
  supportUserId!: string;

  @ApiProperty({ description: "Business reason for support access request" })
  @IsString()
  @IsNotEmpty()
  reason!: string;

  @ApiProperty({ description: "Array of allowed capability scopes (e.g. ['read:audit', 'read:proof'])" })
  @IsArray()
  @IsString({ each: true })
  capabilities!: string[];

  @ApiProperty({ description: "Duration in minutes until grant expires", default: 60, minimum: 5, maximum: 1440 })
  @IsNumber()
  @Min(5)
  @Max(1440)
  durationMinutes!: number;
}

export class RevokeSupportAccessGrantDto {
  @ApiProperty({ description: "Reason for early revocation" })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
