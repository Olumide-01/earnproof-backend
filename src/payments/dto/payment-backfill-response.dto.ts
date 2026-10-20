import { ApiProperty } from "@nestjs/swagger";
import { PaymentBackfillStatus } from "@prisma/client";

export class PaymentBackfillResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() userId!: string;
  @ApiProperty() startLedger!: number;
  @ApiProperty() endLedger!: number;
  @ApiProperty({ enum: PaymentBackfillStatus })
  status!: PaymentBackfillStatus;
  @ApiProperty({
    nullable: true,
    description: "Paging token of the last committed record; only moves forward.",
  })
  checkpointCursor!: string | null;
  @ApiProperty() pagesProcessed!: number;
  @ApiProperty() recordsSeen!: number;
  @ApiProperty() paymentsCreated!: number;
  @ApiProperty({
    description: "Payments already stored (for example by normal sync) and left unchanged.",
  })
  duplicatesSkipped!: number;
  @ApiProperty({ description: "Consecutive claims without progress." })
  attempts!: number;
  @ApiProperty() cancelRequested!: boolean;
  @ApiProperty({ nullable: true, description: "Fault category only." })
  lastErrorSafe!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiProperty({ nullable: true }) completedAt!: string | null;
}
