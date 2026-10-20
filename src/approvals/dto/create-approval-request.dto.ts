import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsObject, IsOptional, IsString, Max, Min, MinLength } from "class-validator";

export class CreateApprovalRequestDto {
  @ApiProperty({
    description: "Identifier of the privileged operation being requested",
    example: "organization.residency_policy.override",
  })
  @IsString()
  @MinLength(1)
  operationType: string;

  @ApiProperty({
    description: "Operation-specific parameters. Hashed and pinned at request time.",
    example: { organizationId: "org_123", allowedRegions: ["eu-west-1"] },
  })
  @IsObject()
  payload: Record<string, unknown>;

  @ApiPropertyOptional({
    description: "How long the request remains decidable, in minutes. Defaults to 1440 (24h).",
    example: 1440,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_080)
  ttlMinutes?: number;
}
