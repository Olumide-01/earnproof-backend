import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString, MaxLength, IsInt, Min } from "class-validator";

export class UpdateTrustedSourceDto {
  @ApiProperty({
    description:
      "Expected revision number for optimistic concurrency control. Must match current revision or update will fail with 409 conflict.",
    example: 0,
  })
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @ApiPropertyOptional({
    description: "Updated human-readable name for the trusted source",
    example: "My Employer Account - Updated",
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({
    description: "Updated issuer ID to link this trusted source to a known issuer",
    example: "issuer_456def",
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  issuerId?: string;
}
