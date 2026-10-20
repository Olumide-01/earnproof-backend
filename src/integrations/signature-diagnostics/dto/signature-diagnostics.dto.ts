import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { MaxBytes } from "../../../common/validation/payload-limits";
import {
  COVERED_COMPONENTS,
  DIAGNOSTICS_CANONICALIZATION_VERSION,
} from "../../../common/crypto/request-signing-diagnostics";

/** Largest synthetic body accepted. Diagnostics are for test requests, not payloads. */
export const MAX_DIAGNOSTIC_BODY_BYTES = 16 * 1024;

/**
 * The three signing headers of the synthetic request, as the client sent them.
 * Lengths are bounded generously above the valid formats so a malformed value
 * is diagnosed rather than rejected outright.
 */
export class SignatureDiagnosticHeadersDto {
  @ApiPropertyOptional({ description: "X-EarnProof-Signature value, e.g. `v1=<64 hex>`." })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  signature?: string;

  @ApiPropertyOptional({ description: "X-EarnProof-Timestamp value (Unix seconds)." })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  timestamp?: string;

  @ApiPropertyOptional({ description: "X-EarnProof-Nonce value. Consumed when well-formed and in window." })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  nonce?: string;
}

export class SignatureDiagnosticsRequestDto {
  @ApiProperty({ description: "HTTP method the synthetic request was signed for.", example: "POST" })
  @Matches(/^[A-Za-z]{1,10}$/, { message: "method must be 1-10 letters" })
  method!: string;

  @ApiProperty({
    description: "Path that was signed, without query string.",
    example: "/api/v1/proofs/minimum-income",
  })
  @Matches(/^\/[^\s]*$/, { message: "path must start with / and contain no whitespace" })
  @MaxLength(2048)
  path!: string;

  @ApiPropertyOptional({
    description: `Raw body exactly as signed (at most ${MAX_DIAGNOSTIC_BODY_BYTES} bytes). Omit with bodySha256.`,
  })
  @IsOptional()
  @IsString()
  @MaxBytes(MAX_DIAGNOSTIC_BODY_BYTES)
  body?: string;

  @ApiPropertyOptional({ description: "Lowercase hex SHA-256 of the body, instead of the body itself." })
  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/, { message: "bodySha256 must be a lowercase hex SHA-256 digest" })
  bodySha256?: string;

  @ApiProperty({ type: SignatureDiagnosticHeadersDto })
  @ValidateNested()
  @Type(() => SignatureDiagnosticHeadersDto)
  headers!: SignatureDiagnosticHeadersDto;

  @ApiPropertyOptional({
    description:
      "The canonical string the client built (five lines joined by LF). When given, " +
      "each covered component is reported as MATCH or MISMATCH.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  declaredCanonical?: string;
}

export class SignatureDiagnosticsResponseDto {
  @ApiProperty({ enum: ["VALID", "INVALID"] })
  result!: "VALID" | "INVALID";

  @ApiProperty({
    nullable: true,
    enum: [
      "MISSING_HEADERS",
      "MALFORMED_TIMESTAMP",
      "STALE_TIMESTAMP",
      "MALFORMED_NONCE",
      "MALFORMED_SIGNATURE",
      "SIGNATURE_INVALID",
      "NONCE_REPLAYED",
    ],
    description: "First failure in RequestSigningGuard order. Null when valid.",
  })
  failureCategory!: string | null;

  @ApiProperty({ example: DIAGNOSTICS_CANONICALIZATION_VERSION })
  canonicalizationVersion!: string;

  @ApiProperty({ enum: COVERED_COMPONENTS, isArray: true })
  coveredComponents!: string[];

  @ApiProperty({ description: "PRESENT, MISSING or MALFORMED per signing header." })
  headers!: Record<string, string>;

  @ApiProperty({ description: "Status (WITHIN, TOO_OLD, TOO_NEW, MALFORMED, MISSING), skew and window." })
  timestampWindow!: Record<string, unknown>;

  @ApiProperty({ enum: ["OK", "NOT_DECLARED", "CRLF_LINE_ENDINGS", "TRAILING_NEWLINE", "WRONG_LINE_COUNT"] })
  canonicalStructure!: string;

  @ApiProperty({ description: "MATCH, MISMATCH or NOT_DECLARED per covered component." })
  components!: Record<string, string>[];

  @ApiProperty({ nullable: true, type: Boolean })
  signatureMatches!: boolean | null;

  @ApiProperty({ enum: ["CONSUMED", "REPLAYED", "MALFORMED", "MISSING", "NOT_EVALUATED"] })
  nonceStatus!: string;
}
