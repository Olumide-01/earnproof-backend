import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MinLength } from "class-validator";

export class DecideApprovalRequestDto {
  @ApiProperty({
    description:
      "Hash of the payload the caller is approving/rejecting, as returned when the request was created. Must match the request's current payload hash exactly.",
    example: "a1b2c3...",
  })
  @IsString()
  @MinLength(1)
  expectedPayloadHash: string;

  @ApiPropertyOptional({ description: "Free-text reason for the decision" })
  @IsOptional()
  @IsString()
  reason?: string;
}
