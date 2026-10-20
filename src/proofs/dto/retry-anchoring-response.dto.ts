import { ApiProperty } from "@nestjs/swagger";
import { AnchoringStatus } from "@prisma/client";

export class RetryAnchoringResponseDto {
  @ApiProperty({ example: "clx1abc2def3ghi4" })
  intentId!: string;

  @ApiProperty({
    enum: AnchoringStatus,
    example: AnchoringStatus.PENDING,
    description: "Always PENDING on success: the intent was requeued for the worker to retry.",
  })
  status!: AnchoringStatus;

  @ApiProperty({
    description:
      "Attempt count is preserved across a manual retry — it is not reset to zero, so the " +
      "worker's own backoff and MAX_ATTEMPTS cap still apply.",
    example: 4,
  })
  attemptCount!: number;
}
