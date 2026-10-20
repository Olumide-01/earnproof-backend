import {
  IsEmail,
  IsString,
  IsOptional,
  IsISO8601,
  IsEnum,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { InvitationOverrideReason } from '@prisma/client';

/**
 * Request DTO for creating an authorized override.
 * Requires recent authorization (signed assertion token).
 */
export class CreateOverrideDto {
  @IsEmail()
  @Transform(({ value }) => value?.toLowerCase().trim())
  email: string;

  @IsString()
  @MaxLength(50)
  overrideType: string; // SUPPRESSION, RATE_LIMIT, COOLDOWN

  @IsEnum(InvitationOverrideReason)
  reason: InvitationOverrideReason;

  @IsString()
  @MaxLength(64)
  authorizedById: string; // User ID (not stored raw)

  @IsISO8601()
  authorizedAt: string; // Must be recent (< 1 hour)

  @IsString()
  @MaxLength(64)
  assertionTokenHash: string; // SHA-256 hash of recent auth assertion

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string; // null = permanent
}

/**
 * Response DTO for an override record.
 */
export class OverrideResponseDto {
  id: string;
  organizationId: string;
  overrideType: string;
  reason: InvitationOverrideReason;
  authorizedById: string;
  authorizedAt: Date;
  description?: string;
  expiresAt?: Date;
  revokedAt?: Date;
  revokedById?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Request DTO for revoking an override (ADMIN only).
 */
export class RevokeOverrideDto {
  @IsString()
  @MaxLength(64)
  overrideId: string;

  @IsString()
  @MaxLength(64)
  revokedById: string; // User ID performing revocation
}

/**
 * Response DTO for override revocation.
 */
export class RevokeOverrideResponseDto {
  id: string;
  organizationId: string;
  overrideType: string;
  reason: InvitationOverrideReason;
  revokedAt: Date;
  revokedById: string;
  message: string;
}

/**
 * Response DTO for active overrides list.
 */
export class ActiveOverridesResponseDto {
  email: string;
  organizationId: string;
  overrides: OverrideResponseDto[];
}

/**
 * Response DTO for override statistics.
 */
export class OverrideStatsDto {
  organizationId: string;
  activeByType: Record<string, number>;
  activeByReason: Record<string, number>;
  totalActive: number;
  createdLast7Days: number;
  revokedTotal: number;
}

/**
 * Response DTO for recent override creators (audit).
 */
export class OverrideCreatorDto {
  authorizedById: string;
  overrideCount: number;
}

export class OverrideCreatorsResponseDto {
  organizationId: string;
  period: {
    days: number;
  };
  creators: OverrideCreatorDto[];
}
