import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class SyncFinalityDto {
  @ApiProperty({
    description:
      "verified: the sync ended at a checkpoint Horizon just confirmed. unverified: payments were written but no checkpoint could be established or advanced. reconciling: a divergence is being reconciled and part of the history window is not re-read yet. diverged: Horizon returned an inconsistent ledger view; nothing was written and affected payments stay held.",
    enum: ["verified", "unverified", "reconciling", "diverged"],
    example: "verified",
  })
  status!: "verified" | "unverified" | "reconciling" | "diverged";

  @ApiPropertyOptional({
    description: "Why the ledger view diverged, when it did.",
    enum: [
      "ledger_hash_mismatch",
      "ledger_missing",
      "checkpoint_record_missing",
      "checkpoint_record_replaced",
      "out_of_order",
      "record_replaced",
    ],
  })
  reason?: string;

  @ApiProperty({
    description: "Payments currently held from proof issuance pending ledger reconciliation.",
    example: 0,
  })
  heldPayments!: number;

  @ApiProperty({
    description: "Held payments a complete reconciliation could not find on the ledger again.",
    example: 0,
  })
  orphanedPayments!: number;
}

export class SyncResultDto {
  @ApiProperty({
    description: "Total number of incoming payment operations fetched from Stellar Horizon.",
    example: 42,
  })
  totalFetched!: number;

  @ApiProperty({
    description: "Number of new payment records created in this sync.",
    example: 10,
  })
  created!: number;

  @ApiProperty({
    description: "Number of existing payment records updated (eligibility / timestamp refreshed).",
    example: 30,
  })
  updated!: number;

  @ApiProperty({
    description: "Number of operations skipped because their asset is not in the supported-asset list.",
    example: 2,
  })
  skipped!: number;

  @ApiProperty({
    description: "Ledger finality of this sync. See docs/ledger-finality.md.",
    type: SyncFinalityDto,
  })
  finality!: SyncFinalityDto;
}
