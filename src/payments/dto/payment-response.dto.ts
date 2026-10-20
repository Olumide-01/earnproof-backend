import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { PaymentClassification } from "@prisma/client";

/**
 * Public representation of a Payment record.
 *
 * `amountEncrypted` is intentionally excluded — the raw ciphertext carries no
 * useful information for API consumers and would be confusing noise. The
 * classification and eligibility fields give clients the signal they need
 * without leaking the encrypted value.
 */
export class PaymentResponseDto {
  @ApiProperty({ example: "clx1abc2def3ghi4" })
  id!: string;

  @ApiProperty({
    description: "SHA-256 hash of the Stellar transaction that contains this operation.",
    example: "a1b2c3d4e5f6...",
  })
  stellarTransactionHash!: string;

  @ApiProperty({
    description: "Unique Stellar operation ID.",
    example: "123456789012345",
  })
  operationId!: string;

  @ApiProperty({
    description:
      "Stellar public key of the payment sender. Stored encrypted at rest and decrypted only " +
      "for the owner; null if the stored ciphertext cannot be decrypted.",
    example: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    nullable: true,
    type: String,
  })
  sourceAddress!: string | null;

  @ApiProperty({
    description:
      "Stellar public key of the payment recipient (the authenticated user). Stored encrypted " +
      "at rest; null if the stored ciphertext cannot be decrypted.",
    example: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    nullable: true,
    type: String,
  })
  destinationAddress!: string | null;

  @ApiProperty({ example: "USDC" })
  assetCode!: string;

  @ApiPropertyOptional({
    description: "Stellar issuer address for the asset, or null for native XLM.",
    example: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGLA1PIC4CEXLRTKHB0EGB",
    nullable: true,
  })
  assetIssuer!: string | null;

  @ApiProperty({
    description: "ISO-8601 UTC timestamp of when the payment occurred on the Stellar network.",
    example: "2025-01-01T10:00:00.000Z",
  })
  occurredAt!: string;

  @ApiProperty({
    description:
      "Bounded transaction memo context visible only to the authenticated payment owner.",
    example: { type: "text", value: "Salary June", truncated: false },
  })
  memoContext!: {
    type: "none" | "text" | "id" | "hash" | "return_hash";
    value?: string;
    truncated?: boolean;
  };

  @ApiProperty({
    description: "User-assigned classification for this payment.",
    enum: PaymentClassification,
    example: PaymentClassification.INCOME,
  })
  classification!: PaymentClassification;

  @ApiProperty({
    description: "Classification revision number for tracking changes.",
    example: 1,
  })
  classificationRevision!: number;

  @ApiProperty({
    description:
      "Whether this payment's asset is on the supported-asset list and therefore eligible to be used in proofs.",
    example: true,
  })
  isEligible!: boolean;

  @ApiProperty({
    description:
      "True while the ledger view this payment was read from is being reconciled after a Horizon checkpoint divergence, or after reconciliation could not find it again. Held payments cannot be used in proofs.",
    example: false,
  })
  finalityHeld!: boolean;

  @ApiProperty({ example: "2025-01-01T09:00:00.000Z" })
  createdAt!: string;

  @ApiProperty({ example: "2025-01-01T09:00:00.000Z" })
  updatedAt!: string;
}
