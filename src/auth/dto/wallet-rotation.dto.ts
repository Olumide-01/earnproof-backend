import { ApiProperty } from "@nestjs/swagger";
import { IsString, Length, MaxLength } from "class-validator";

/**
 * Upper bound on an encoded signature. An ed25519 signature is 64 bytes:
 * 88 characters of base64 or 128 of hex. The bound leaves room for either
 * without letting an unbounded string reach the verifier.
 */
const MAX_SIGNATURE_LENGTH = 256;

export class InitiateWalletRotationDto {
  @ApiProperty({
    description: "The Stellar address that will replace the account's current wallet.",
    example: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  })
  @IsString()
  @Length(56, 56)
  newWalletAddress!: string;
}

export class CompleteWalletRotationDto {
  @ApiProperty({
    description: "Signature by the current wallet over `currentMessage` (base64 or hex).",
  })
  @IsString()
  @MaxLength(MAX_SIGNATURE_LENGTH)
  currentSignature!: string;

  @ApiProperty({
    description: "Signature by the replacement wallet over `newMessage` (base64 or hex).",
  })
  @IsString()
  @MaxLength(MAX_SIGNATURE_LENGTH)
  newSignature!: string;
}

export class WalletRotationChallengeResponseDto {
  @ApiProperty({ description: "Single-use rotation id" })
  rotationId!: string;

  @ApiProperty({ description: "Message the current wallet must sign" })
  currentMessage!: string;

  @ApiProperty({ description: "Message the replacement wallet must sign" })
  newMessage!: string;

  @ApiProperty({ description: "ISO 8601 deadline for completing the rotation" })
  expiresAt!: Date;
}

export class WalletRotationResultResponseDto {
  @ApiProperty({ description: "The account's wallet address after rotation" })
  walletAddress!: string;

  @ApiProperty({
    description:
      "Sessions revoked by the rotation, including the one that completed it. Sign in again with the replacement wallet.",
  })
  sessionsRevoked!: number;
}
