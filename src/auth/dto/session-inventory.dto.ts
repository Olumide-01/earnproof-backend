import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * Represents a single session in the inventory response.
 * Non-sensitive metadata only — token and full fingerprint never included.
 */
export class SessionInventoryItemDto {
  @ApiProperty({
    description: "Session ID (safe to display, not the token itself).",
    example: "clx1abc2def3ghi4",
  })
  id!: string;

  @ApiPropertyOptional({ example: "Chrome on macOS on Desktop" })
  deviceLabel?: string;

  @ApiPropertyOptional({
    description: "Optional device fingerprint hash (e.g., user-agent hash, IP hash).",
    example: "sha256:a1b2c3d4e5f6...",
    nullable: true,
  })
  deviceFingerprint?: string | null;

  @ApiPropertyOptional({ example: "2026-09-24T12:00:00.000Z" })
  firstSeenAt?: Date;

  @ApiPropertyOptional({ example: "2026-09-24T13:00:00.000Z" })
  lastSeenAt?: Date;

  @ApiPropertyOptional({
    description: "ISO-8601 UTC timestamp when the session was created.",
    example: "2025-01-01T10:00:00.000Z",
  })
  createdAt?: string;

  @ApiProperty({
    description: "ISO-8601 UTC timestamp when the session expires.",
    example: "2025-01-01T22:00:00.000Z",
  })
  expiresAt!: string | Date;

  @ApiPropertyOptional({
    description: "ISO-8601 UTC timestamp of the last request using this session.",
    example: "2025-01-01T20:30:45.000Z",
    nullable: true,
  })
  lastUsedAt?: string | null;

  @ApiPropertyOptional({ nullable: true })
  revokedAt?: Date | null;

  @ApiPropertyOptional({ example: true })
  current?: boolean;

  @ApiPropertyOptional({
    description: "Whether this is the current session (the one making the request).",
    example: true,
  })
  isCurrent?: boolean;
}

/**
 * Response DTO for listing active sessions.
 */
export class SessionInventoryResponseDto {
  @ApiProperty({
    description: "List of active sessions.",
    type: () => [SessionInventoryItemDto],
  })
  sessions!: SessionInventoryItemDto[];

  @ApiProperty({
    description: "Total number of active sessions for this user.",
    example: 3,
  })
  total!: number;
}
