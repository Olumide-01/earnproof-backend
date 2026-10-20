import { ApiProperty } from "@nestjs/swagger";
import { PaymentClassification } from "@prisma/client";

export class PaymentClassificationHistoryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  paymentId!: string;

  @ApiProperty()
  actorId!: string;

  @ApiProperty({ enum: PaymentClassification })
  previousClassification!: PaymentClassification;

  @ApiProperty({ enum: PaymentClassification })
  newClassification!: PaymentClassification;

  @ApiProperty()
  reasonCode!: string;

  @ApiProperty()
  classificationRevision!: number;

  @ApiProperty()
  createdAt!: Date;
}

export class ListPaymentClassificationHistoryDto {
  @ApiProperty({ required: false, minimum: 1, default: 1 })
  page?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 100, default: 20 })
  limit?: number;
}