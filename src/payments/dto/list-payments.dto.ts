import { ApiPropertyOptional } from "@nestjs/swagger";
import { PaymentClassification } from "@prisma/client";
import { IsEnum, IsOptional, IsString } from "class-validator";
import { CursorPaginationQueryDto } from "../../common/pagination/pagination.dto";

export class ListPaymentsDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({ enum: PaymentClassification })
  @IsOptional()
  @IsEnum(PaymentClassification)
  classification?: PaymentClassification;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assetCode?: string;
}
