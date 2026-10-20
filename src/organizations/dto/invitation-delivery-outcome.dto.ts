import {
  IsEmail,
  IsString,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsEnum,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { InvitationDeliveryOutcome } from '@prisma/client';

/**
 * Request DTO for recording a delivery outcome.
 */
export class RecordDeliveryOutcomeDto {
  @IsEmail()
  @Transform(({ value }) => value?.toLowerCase().trim())
  email: string;

  @IsEnum(InvitationDeliveryOutcome)
  outcome: InvitationDeliveryOutcome;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(599)
  statusCode?: number;

  @IsOptional()
  @IsString()
  failureReason?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  attemptCount?: number;
}

/**
 * Response DTO for a delivery outcome record.
 */
export class DeliveryOutcomeResponseDto {
  id: string;
  organizationId: string;
  outcome: InvitationDeliveryOutcome;
  statusCode?: number;
  failureReason?: string;
  attemptCount: number;
  attemptedAt: Date;
  expiresAt: Date;
}

/**
 * Response DTO for outcome statistics.
 */
export class OutcomeStatsDto {
  organizationId: string;

  period: {
    hoursBack: number;
    startTime: Date;
    endTime: Date;
  };

  total: number;
  byOutcome: Record<InvitationDeliveryOutcome, number>;
  bounceRate: number; // Percentage
  complaintRate: number; // Percentage
  failureRate: number; // Percentage
}

/**
 * Response DTO for abuse pattern detection.
 */
export class AbusePatternDto {
  organizationId: string;
  warnings: string[];
  stats: OutcomeStatsDto;
}

/**
 * Response DTO for recent delivery outcomes.
 */
export class RecentOutcomesResponseDto {
  email: string;
  organizationId: string;
  outcomes: DeliveryOutcomeResponseDto[];
}
