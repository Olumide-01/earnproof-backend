import { ApiProperty } from "@nestjs/swagger";
import { AnchoringStatus, QuarantineDecision } from "@prisma/client";

export class AbandonAnchoringResponseDto {
  @ApiProperty({ example: "clx1abc2def3ghi4" })
  intentId!: string;

  @ApiProperty({ enum: AnchoringStatus, example: AnchoringStatus.QUARANTINED })
  status!: AnchoringStatus;

  @ApiProperty({
    enum: QuarantineDecision,
    example: QuarantineDecision.ABANDONED,
    description: "Always ABANDONED on success. Terminal: the worker will never retry this intent again.",
  })
  quarantineDecision!: QuarantineDecision;
}
