import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsInt,
  IsOptional,
  MaxLength,
  MinLength,
  Matches,
  Min,
  Max,
  IsIn,
} from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";

export class CreateSupportedAssetDto {
  @ApiProperty({
    description: "Organization ID this asset belongs to",
    example: "cuid123",
  })
  @IsString()
  @MaxLength(FIELD_LIMITS.id)
  organizationId: string;

  @ApiProperty({
    description: "Asset code (1-12 alphanumeric characters)",
    example: "USDC",
    minLength: 1,
    maxLength: 12,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(12)
  @Matches(/^[A-Z0-9]+$/, {
    message: "Asset code must contain only uppercase letters and numbers",
  })
  code: string;

  @ApiPropertyOptional({
    description:
      "Stellar issuer public key address (56 characters, starting with G). Null for native XLM.",
    example: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTBTQUGS7SEEDS23ABC123DEF45",
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(56)
  @Matches(/^G[A-Z2-7]{55}$/, {
    message: "Issuer must be a valid Stellar public key (G... format)",
  })
  issuer?: string | null;

  @ApiProperty({
    description: "Stellar network identifier",
    example: "testnet",
    enum: ["testnet", "pubnet"],
  })
  @IsString()
  @IsIn(["testnet", "pubnet"], {
    message: "Network must be either 'testnet' or 'pubnet'",
  })
  network: string;

  @ApiPropertyOptional({
    description: "Number of decimal places (0-7, Stellar constraint). Default: 7",
    example: 7,
    minimum: 0,
    maximum: 7,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(7)
  decimals?: number = 7;
}
