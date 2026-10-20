import { ApiProperty } from "@nestjs/swagger";
import { IsInt, Min, Max } from "class-validator";

export class UpdateSupportedAssetDto {
  @ApiProperty({
    description:
      "Expected revision number for optimistic locking. Request will fail if revision has changed.",
    example: 0,
  })
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @ApiProperty({
    description: "Number of decimal places (0-7, Stellar constraint)",
    example: 7,
    minimum: 0,
    maximum: 7,
  })
  @IsInt()
  @Min(0)
  @Max(7)
  decimals: number;
}
