import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsObject,
  IsOptional,
  MaxLength,
  IsEnum,
  IsISO8601,
} from "class-validator";
import { AttestationType } from "@prisma/client";
import { FIELD_LIMITS } from "../../common/limits/request-limits";
import { MaxBytes, MaxDepth } from "../../common/validation/payload-limits";

export class CreateAttestationDto {
  @ApiProperty({
    description: "Subject wallet address hash (privacy-preserving)",
    example: "sha256:abcd1234...",
  })
  @IsString()
  @MaxLength(FIELD_LIMITS.hash)
  subjectWalletHash: string;

  @ApiProperty({
    description: "Attestation type (PAYMENT, EMPLOYMENT, INVOICE)",
    enum: ["PAYMENT", "EMPLOYMENT", "INVOICE"],
  })
  @IsEnum(AttestationType)
  type: AttestationType;

  @ApiPropertyOptional({
    description: "Optional reference to a specific payment",
    example: "sha256:payment123...",
  })
  @IsOptional()
  @IsString()
  @MaxLength(FIELD_LIMITS.hash)
  paymentReferenceHash?: string;

  @ApiProperty({
    description:
      "Signed credential payload containing attestation claims (encrypted/hashed sensitive data)",
    example: {
      claim: {
        type: "PAYMENT",
        amount: "encrypted",
        currency: "USD",
      },
      signature: "hmac-sha256:...",
    },
  })
  @IsObject()
  @MaxBytes(FIELD_LIMITS.credentialBytes)
  @MaxDepth(FIELD_LIMITS.credentialDepth)
  signedPayload: Record<string, any>;

  @ApiPropertyOptional({
    description:
      "ISO 8601 datetime when attestation expires (optional, for time-bound attestations)",
    example: "2025-12-31T23:59:59Z",
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({
    description: "Schema version for this attestation",
    example: "1.0",
    default: "1.0",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  schemaVersion?: string;

  @ApiPropertyOptional({
    description: "Signing key version used to create this attestation",
    example: "1",
    default: "1",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  signingKeyVersionId?: string;
}
