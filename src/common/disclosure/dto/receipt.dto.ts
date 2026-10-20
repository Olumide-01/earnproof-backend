import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsOptional, IsDateString, IsUUID, MaxLength, IsIn } from "class-validator";
import { Type } from "class-transformer";

/**
 * DTO for generating a disclosure receipt
 */
export class GenerateDisclosureReceiptDto {
  @ApiProperty({
    description: "ID of the proof being disclosed",
    example: "proof_12345678-1234-5678-9abc-123456789012",
  })
  @IsUUID()
  proofId: string;

  @ApiProperty({
    description: "Purpose of the disclosure request",
    example: "Employment verification for background check",
    maxLength: 500,
  })
  @IsString()
  @MaxLength(500)
  purpose: string;

  @ApiProperty({
    description: "Optional receipt expiration date (ISO 8601). Defaults to 30 days or proof expiry, whichever is sooner.",
    example: "2024-02-01T00:00:00.000Z",
    required: false,
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiProperty({
    description: "Optional policy version for consent tracking",
    example: "privacy-policy-v2.1",
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  policyVersion?: string;
}

/**
 * Requester information in receipt
 */
export class RequesterDto {
  @ApiProperty({ example: "user_12345678-1234-5678-9abc-123456789012" })
  @IsUUID()
  userId: string;

  @ApiProperty({
    example: "Employment verification for background check",
    maxLength: 500,
  })
  @IsString()
  @MaxLength(500)
  purpose: string;
}

/**
 * Disclosure metadata in receipt
 */
export class DisclosureDto {
  @ApiProperty({ example: "2024-01-15T10:30:00.000Z" })
  @IsDateString()
  approvedAt: string;

  @ApiProperty({ example: "privacy-policy-v2.1" })
  @IsString()
  policyVersion: string;

  @ApiProperty({ example: "2024-02-15T10:30:00.000Z" })
  @IsDateString()
  expiresAt: string;
}

/**
 * Receipt payload structure
 */
export class ReceiptPayloadDto {
  @ApiProperty({ example: "1.0" })
  @IsString()
  version: string;

  @ApiProperty({ example: "org_12345678-1234-5678-9abc-123456789012" })
  @IsUUID()
  organizationId: string;

  @ApiProperty({ example: "proof_12345678-1234-5678-9abc-123456789012" })
  @IsUUID()
  proofId: string;

  @ApiProperty({ example: "EMPLOYMENT_VERIFICATION" })
  @IsString()
  proofType: string;

  @ApiProperty({
    description: "Requester information",
  })
  @Type(() => RequesterDto)
  requester: RequesterDto;

  @ApiProperty({
    description: "Disclosure metadata",
  })
  @Type(() => DisclosureDto)
  disclosure: DisclosureDto;

  @ApiProperty({ example: "2024-01-15T10:30:00.000Z" })
  @IsDateString()
  issuedAt: string;
}

/**
 * Receipt signature structure
 */
export class ReceiptSignatureDto {
  @ApiProperty({ example: "EdDSA" })
  @IsString()
  @IsIn(["EdDSA"])
  algorithm: "EdDSA";

  @ApiProperty({ example: "credential-key-0" })
  @IsString()
  keyId: string;

  @ApiProperty({
    example: "ed25519:base64url_encoded_signature",
    description: "EdDSA signature in ed25519:base64url format",
  })
  @IsString()
  signature: string;

  @ApiProperty({
    example: "sha256_hash_of_canonical_payload",
    description: "SHA256 hash of the canonicalized receipt payload",
  })
  @IsString()
  credentialHash: string;
}

/**
 * DTO for receipt verification request
 */
export class VerifyReceiptDto {
  @ApiProperty({
    description: "Complete receipt payload to verify",
  })
  receipt: ReceiptPayloadDto;

  @ApiProperty({
    description: "Receipt signature data",
  })
  signature: ReceiptSignatureDto;
}

/**
 * Response DTO for successful receipt generation
 */
export class DisclosureReceiptResponseDto {
  @ApiProperty({
    description: "Unique receipt identifier",
    example: "receipt_12345678-1234-5678-9abc-123456789012",
  })
  receiptId: string;

  @ApiProperty({
    description: "Complete receipt payload",
  })
  receipt: ReceiptPayloadDto;

  @ApiProperty({
    description: "Receipt signature for verification",
  })
  signature: ReceiptSignatureDto;

  @ApiProperty({
    description: "Receipt creation timestamp",
    example: "2024-01-15T10:30:00.000Z",
  })
  createdAt: string;
}

/**
 * Response DTO for receipt verification
 */
export class ReceiptVerificationResponseDto {
  @ApiProperty({
    description: "Whether the receipt is valid",
    example: true,
  })
  isValid: boolean;

  @ApiProperty({
    description: "Verification status",
    enum: ["valid", "expired", "invalid_signature", "unknown_key", "malformed"],
    example: "valid",
  })
  status: "valid" | "expired" | "invalid_signature" | "unknown_key" | "malformed";

  @ApiProperty({
    description: "When the verification was performed",
    example: "2024-01-15T10:30:00.000Z",
  })
  verifiedAt: string;

  @ApiProperty({
    description: "Receipt expiration date (if available)",
    example: "2024-02-15T10:30:00.000Z",
    required: false,
  })
  expiresAt?: string;
}

/**
 * Query parameters for listing receipts
 */
export class ListReceiptsQueryDto {
  @ApiProperty({
    description: "Filter by specific proof ID",
    required: false,
  })
  @IsOptional()
  @IsUUID()
  proofId?: string;

  @ApiProperty({
    description: "Maximum number of receipts to return",
    example: 50,
    minimum: 1,
    maximum: 100,
    required: false,
  })
  @IsOptional()
  @Type(() => Number)
  limit?: number;

  @ApiProperty({
    description: "Include expired receipts in results",
    example: false,
    required: false,
  })
  @IsOptional()
  @Type(() => Boolean)
  includeExpired?: boolean;
}

/**
 * Response DTO for receipt listing
 */
export class ReceiptListItemDto {
  @ApiProperty({
    description: "Receipt identifier",
    example: "receipt_12345678-1234-5678-9abc-123456789012",
  })
  id: string;

  @ApiProperty({
    description: "Associated proof ID",
    example: "proof_12345678-1234-5678-9abc-123456789012",
  })
  proofId: string;

  @ApiProperty({
    description: "Receipt content hash",
    example: "sha256_hash_of_receipt_content",
  })
  receiptHash: string;

  @ApiProperty({
    description: "When the receipt was issued",
    example: "2024-01-15T10:30:00.000Z",
  })
  issuedAt: string;

  @ApiProperty({
    description: "Receipt expiration date",
    example: "2024-02-15T10:30:00.000Z",
  })
  expiresAt: string;

  @ApiProperty({
    description: "Signing key ID used for this receipt",
    example: "credential-key-0",
  })
  signatureKeyId: string;
}
