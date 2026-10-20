import { ApiProperty } from "@nestjs/swagger";
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";
import {
  MAX_BACKFILL_LEDGER,
  MIN_BACKFILL_LEDGER,
} from "../payment-backfill.service";

export class CreatePaymentBackfillDto {
  @ApiProperty({ description: "ID of the user whose payments are rescanned." })
  @IsString()
  @IsNotEmpty()
  @MaxLength(FIELD_LIMITS.id)
  userId!: string;

  @ApiProperty({
    description: "First ledger of the inclusive range.",
    minimum: MIN_BACKFILL_LEDGER,
    example: 51_000_000,
  })
  @IsInt()
  @Min(MIN_BACKFILL_LEDGER)
  @Max(MAX_BACKFILL_LEDGER)
  startLedger!: number;

  @ApiProperty({
    description:
      "Last ledger of the inclusive range. At most 120960 ledgers after startLedger, inclusive.",
    maximum: MAX_BACKFILL_LEDGER,
    example: 51_010_000,
  })
  @IsInt()
  @Min(MIN_BACKFILL_LEDGER)
  @Max(MAX_BACKFILL_LEDGER)
  endLedger!: number;
}
