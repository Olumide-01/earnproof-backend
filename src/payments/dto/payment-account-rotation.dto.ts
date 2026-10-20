import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import { STELLAR_NETWORK_NAMES } from "../../stellar/stellar-network";
import { MAX_BACKFILL_LEDGER, MIN_BACKFILL_LEDGER } from "../payment-backfill.service";
import { ROLLBACK_REASONS, type PaymentAccountRollbackReason } from "../payment-account-rotation";

/**
 * Request bodies for payment account rotation (#321).
 *
 * Validation never echoes submitted values, and the global ValidationPipe
 * rejects unknown properties, so a body that carries a `secret` or `seed`
 * field is refused outright rather than silently dropped.
 */

export class RequestPaymentAccountRotationDto {
  @ApiProperty({ enum: STELLAR_NETWORK_NAMES, description: "Must equal this deployment's network." })
  @IsIn(STELLAR_NETWORK_NAMES)
  network!: string;

  @ApiProperty({
    description: "Public Stellar account id (G...) to index payments from. Never a secret key.",
    example: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
  })
  @IsString()
  @MaxLength(56)
  newAccountId!: string;

  @ApiPropertyOptional({
    description:
      "Backfill the new account's history from this ledger up to the handoff boundary. " +
      "Clamped to the backfill worker's maximum span. Omit for no backfill.",
    minimum: MIN_BACKFILL_LEDGER,
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_BACKFILL_LEDGER)
  @Max(MAX_BACKFILL_LEDGER)
  backfillFromLedger?: number;
}

export class VerifyPaymentAccountRotationDto {
  @ApiProperty({
    description: "The new account's SEP-53 signature over the challenge message, hex or base64.",
  })
  @IsString()
  @MaxLength(256)
  @Matches(/^[A-Za-z0-9+/=_-]+$/, { message: "signature must be hex or base64" })
  signature!: string;
}

export class PaymentAccountRotationVersionDto {
  @ApiProperty({ description: "Rotation version last read." })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class RollbackPaymentAccountRotationDto extends PaymentAccountRotationVersionDto {
  @ApiProperty({ enum: ROLLBACK_REASONS })
  @IsIn(ROLLBACK_REASONS)
  reason!: PaymentAccountRollbackReason;
}
