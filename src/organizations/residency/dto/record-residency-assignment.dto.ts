import { ApiProperty } from "@nestjs/swagger";
import { DataResidencyClass } from "@prisma/client";
import { IsEnum, IsString, MinLength } from "class-validator";

export class RecordResidencyAssignmentDto {
  @ApiProperty({ enum: DataResidencyClass })
  @IsEnum(DataResidencyClass)
  dataClass: DataResidencyClass;

  @ApiProperty({
    description: "The kind of resource being placed, e.g. 'backup', 'queueJob', 'deployment'",
    example: "backup",
  })
  @IsString()
  @MinLength(1)
  resourceType: string;

  @ApiProperty({ example: "backup_2026_01_01" })
  @IsString()
  @MinLength(1)
  resourceId: string;

  @ApiProperty({ example: "eu-west-1" })
  @IsString()
  @MinLength(1)
  region: string;
}
