import { ApiProperty } from "@nestjs/swagger";
import { DataResidencyClass } from "@prisma/client";
import { ArrayMinSize, ArrayUnique, IsArray, IsEnum, IsString } from "class-validator";

export class SetResidencyPolicyDto {
  @ApiProperty({ enum: DataResidencyClass })
  @IsEnum(DataResidencyClass)
  dataClass: DataResidencyClass;

  @ApiProperty({
    description: "Explicit allow-list of region codes. There is no implicit default region.",
    example: ["eu-west-1", "eu-central-1"],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  allowedRegions: string[];
}
