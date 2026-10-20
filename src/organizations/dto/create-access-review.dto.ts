import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsOptional, MaxLength } from "class-validator";

export class CreateAccessReviewDto {
  @ApiProperty({
    description: "Name of the access review campaign",
    example: "Q1 2025 Access Review"
  })
  @IsString()
  @MaxLength(255)
  name!: string;

  @ApiProperty({
    description: "Optional description of the review purpose",
    example: "Quarterly review of all organization member access and roles",
    required: false
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}