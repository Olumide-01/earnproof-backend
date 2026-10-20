import { ApiProperty } from "@nestjs/swagger";
import { PaymentClassification } from "@prisma/client";
import { IsEnum, IsOptional, IsString } from "class-validator";

export class UpdatePaymentClassificationDto {
  @ApiProperty({ enum: PaymentClassification })
  @IsEnum(PaymentClassification)
  classification!: PaymentClassification;

  @ApiProperty({ 
    description: "Reason code for the classification change",
    example: "USER_RECLASSIFICATION",
    required: false
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}
