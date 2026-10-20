import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsUrl, IsOptional, MinLength, IsInt, Min } from "class-validator";

export class UpdateOrganizationDto {
  @ApiProperty({
    description:
      "Expected revision number for optimistic concurrency control. Must match current revision or update will fail with 409 conflict.",
    example: 0,
  })
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @ApiPropertyOptional({
    description: "Organization display name",
    example: "Acme Corporation",
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @ApiPropertyOptional({
    description: "Organization website URL",
    example: "https://acme.example.com",
  })
  @IsOptional()
  @IsUrl()
  website?: string;
}
