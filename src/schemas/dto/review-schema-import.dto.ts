import { ApiProperty } from "@nestjs/swagger";
import { IsString, MinLength } from "class-validator";

export class ReviewSchemaImportDto {
  @ApiProperty({
    description: "The job's canonicalHash from the dry-run result being approved/applied",
  })
  @IsString()
  @MinLength(1)
  reviewedHash: string;
}
