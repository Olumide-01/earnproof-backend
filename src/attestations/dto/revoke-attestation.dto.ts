import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsOptional, MaxLength } from "class-validator";

export class RevokeAttestationDto {
  @ApiPropertyOptional({
    description: "Optional reason for revocation",
    example: "Attestation no longer valid due to policy change",
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  revocationReason?: string;
}
