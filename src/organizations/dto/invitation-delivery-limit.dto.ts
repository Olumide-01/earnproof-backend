import { IsEmail, IsString, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Request DTO for checking invitation delivery limits for a recipient.
 */
export class CheckDeliveryLimitsDto {
  @IsEmail()
  @Transform(({ value }) => value?.toLowerCase().trim())
  email: string;

  @IsOptional()
  @IsString()
  organizationId?: string;
}

/**
 * Response DTO for delivery limit checks.
 * Does not expose recipient email hashes (they're unhashable).
 */
export class DeliveryLimitCheckResponseDto {
  email: string;
  organizationId: string;

  // Per-recipient resend cooldown check
  resendCooldownOk: boolean;
  resendCooldownReason?: string;

  // Per-recipient hourly limit check
  hourlyLimitOk: boolean;
  hourlyLimitReason?: string;

  // Per-tenant daily quota check
  dailyQuotaOk: boolean;
  dailyQuotaReason?: string;

  // Whether an active override bypass the above limits
  overrideActive: boolean;

  // Overall delivery permission
  canDeliver: boolean; // true if all checks pass
  blockedReason?: string; // if canDeliver is false, reason why
}

/**
 * Response DTO for organization limit statistics.
 */
export class OrganizationLimitStatsDto {
  organizationId: string;

  dailyQuota: {
    count: number;
    limit: number;
    windowStart?: Date;
  };

  recipientsInCooldown: number;
}

/**
 * Request DTO for resetting per-recipient limits (ADMIN only).
 */
export class ResetRecipientLimitsDto {
  @IsEmail()
  @Transform(({ value }) => value?.toLowerCase().trim())
  email: string;
}

/**
 * Response DTO for limit reset confirmation.
 */
export class ResetRecipientLimitsResponseDto {
  email: string;
  organizationId: string;
  cooldownReset: boolean;
  hourlyWindowReset: boolean;
  message: string;
}
