import { IsEmail, IsString, IsOptional, IsISO8601, MaxLength, IsDateString } from 'class-validator';
import { Transform } from 'class-transformer';
import { InvitationDeliveryOutcome } from '@prisma/client';

/**
 * Request DTO for adding a recipient to the suppression list.
 */
export class AddSuppressionDto {
  @IsEmail()
  @Transform(({ value }) => value?.toLowerCase().trim())
  email: string;

  @IsString()
  @MaxLength(100)
  reason: string; // BOUNCED, COMPLAINT, MANUAL_REMOVAL, POLICY_VIOLATION

  @IsOptional()
  @IsString()
  sourceOutcome?: InvitationDeliveryOutcome;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * Request DTO for removing a recipient from the suppression list.
 */
export class RemoveSuppressionDto {
  @IsEmail()
  @Transform(({ value }) => value?.toLowerCase().trim())
  email: string;
}

/**
 * Response DTO for a suppression entry.
 * Does not expose the hashed email (it's unhashable).
 */
export class SuppressionResponseDto {
  id: string;
  organizationId: string;
  reason: string;
  sourceOutcome?: InvitationDeliveryOutcome;
  suppressedAt: Date;
  expiresAt?: Date;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Response DTO for suppression statistics.
 */
export class SuppressionStatsDto {
  organizationId: string;
  totalActive: number;
  byReason: Record<string, number>;
}

/**
 * Response DTO for checking if a recipient is suppressed.
 */
export class CheckSuppressionDto {
  @IsEmail()
  @Transform(({ value }) => value?.toLowerCase().trim())
  email: string;
}

export class CheckSuppressionResponseDto {
  email: string;
  isSuppressed: boolean;
  suppression?: SuppressionResponseDto;
  message: string;
}
