import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ProofShareScope } from "@prisma/client";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export class CreateProofShareTokenDto {
  @ApiProperty({
    enum: ProofShareScope,
    description:
      "What the token discloses. VERIFY_STATUS returns the verification result and public proof metadata only; " +
      "VERIFY_CREDENTIAL additionally returns the signed credential. Immutable after issuance.",
  })
  @IsEnum(ProofShareScope)
  scope!: ProofShareScope;

  @ApiPropertyOptional({
    description:
      "Token lifetime in minutes. Defaults to the configured default; capped by the configured maximum and by the proof's own expiry.",
    minimum: 5,
    example: 1440,
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  expiresInMinutes?: number;

  @ApiPropertyOptional({
    description:
      "Optional maximum number of successful uses. Omit for unlimited uses until expiry.",
    minimum: 1,
    maximum: 1000,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxUses?: number;

  @ApiPropertyOptional({
    description: "Owner-facing label, e.g. who the link was sent to.",
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label?: string;
}

export class ResolveProofShareTokenDto {
  @ApiProperty({
    description:
      "Raw share token. Sent in the request body — never in a URL — so it does not reach access logs or referrers.",
  })
  @IsString()
  @MaxLength(128)
  token!: string;
}
