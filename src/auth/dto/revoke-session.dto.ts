import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * Response DTO for revoking a single session.
 */
export class RevokeSingleSessionResponseDto {
  @ApiProperty({
    description: "Status of the revocation operation.",
    example: "ok",
  })
  status!: string;

  @ApiProperty({
    description: "ID of the revoked session.",
    example: "clx1abc2def3ghi4",
  })
  revokedSessionId!: string;
}

/**
 * Response DTO for revoking all other sessions.
 */
export class RevokeAllOtherSessionsResponseDto {
  @ApiProperty({
    description: "Status of the revocation operation.",
    example: "ok",
  })
  status!: string;

  @ApiProperty({
    description: "Number of sessions revoked.",
    example: 2,
  })
  revokedCount!: number;
}
