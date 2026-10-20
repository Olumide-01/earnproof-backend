import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  AnchoringOperation,
  AnchoringStatus,
  QuarantineDecision,
  QuarantineReasonCode,
} from "@prisma/client";

export class AnchoringIntentStatusDto {
  @ApiProperty({ example: "clx1abc2def3ghi4" })
  id!: string;

  @ApiProperty({ enum: AnchoringOperation, example: AnchoringOperation.REGISTER })
  operation!: AnchoringOperation;

  @ApiProperty({ enum: AnchoringStatus, example: AnchoringStatus.QUARANTINED })
  status!: AnchoringStatus;

  @ApiProperty({
    description: "Number of delivery attempts made for this intent so far.",
    example: 3,
  })
  attemptCount!: number;

  @ApiPropertyOptional({ nullable: true, description: "ISO-8601 UTC timestamp of the last attempt." })
  lastAttemptAt!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "ISO-8601 UTC timestamp the worker will next retry at, for a PENDING intent.",
  })
  nextRetryAt!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "Redacted failure detail from the most recent attempt. Never a raw error.",
  })
  lastErrorSafe!: string | null;

  @ApiProperty({
    description:
      "True once the worker has stopped retrying automatically. Superseded by `status: QUARANTINED`; kept for backward compatibility.",
    example: true,
  })
  permanentError!: boolean;

  @ApiPropertyOptional({ nullable: true, description: "On-chain transaction hash once confirmed." })
  transactionHash!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "ISO-8601 UTC timestamp the intent entered QUARANTINED, or null.",
  })
  quarantinedAt!: string | null;

  @ApiPropertyOptional({
    enum: QuarantineReasonCode,
    nullable: true,
    description: "Why the intent was quarantined, or null if never quarantined.",
  })
  quarantineReasonCode!: QuarantineReasonCode | null;

  @ApiProperty({
    enum: QuarantineDecision,
    example: QuarantineDecision.PENDING,
    description: "The operator's disposition. PENDING until redriven or abandoned.",
  })
  quarantineDecision!: QuarantineDecision;

  @ApiPropertyOptional({
    nullable: true,
    description: "ISO-8601 UTC timestamp of the operator's redrive/abandon decision, or null.",
  })
  decidedAt!: string | null;
}

export class ProofAnchoringStatusResponseDto {
  @ApiProperty({ example: "clx1abc2def3ghi4" })
  proofId!: string;

  @ApiProperty({
    type: () => [AnchoringIntentStatusDto],
    description:
      "One entry per anchoring operation attempted for this proof (at most REGISTER and REVOKE).",
  })
  intents!: AnchoringIntentStatusDto[];
}
