import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { DisputeCategory, DisputeStatus } from "@prisma/client";

/**
 * ParticipantsDto
 * 
 * Identifies all parties who should receive notifications about the dispute decision.
 * Authorization is verified at the notification handler level.
 */
export class ParticipantsDto {
  @IsString()
  @IsNotEmpty()
  proofOwnerId: string;

  @IsString()
  @IsNotEmpty()
  disputeSubmitterId: string;

  @IsOptional()
  @IsString()
  assignedReviewerId?: string;
}

/**
 * CreateDisputeDecisionNotificationDto
 * 
 * Used to trigger creation of notifications for dispute decision events.
 * This DTO is validated when publishing the domain event.
 * 
 * Privacy guarantees:
 * - No sensitive proof data included in this DTO
 * - Only decision outcome, reason, and participant IDs
 * - Event handler creates notifications with proper redaction
 */
export class CreateDisputeDecisionNotificationDto {
  @IsString()
  @IsNotEmpty()
  disputeId: string;

  @IsString()
  @IsNotEmpty()
  proofId: string;

  @IsString()
  @IsNotEmpty()
  organizationId: string;

  @IsEnum(DisputeCategory)
  category: DisputeCategory;

  @IsEnum(["RESOLVED", "WITHDRAWN", "EXPIRED"])
  decisionType: "RESOLVED" | "WITHDRAWN" | "EXPIRED";

  @IsEnum(DisputeStatus)
  status: DisputeStatus;

  // Resolution fields (when decisionType is RESOLVED)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  resolutionOutcome?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resolutionReason?: string;

  @IsOptional()
  @IsString()
  resolvedBy?: string;

  @IsOptional()
  @IsString()
  resolvedAt?: string;

  // Withdrawal fields (when decisionType is WITHDRAWN)
  @IsOptional()
  @IsString()
  withdrawnBy?: string;

  @IsOptional()
  @IsString()
  withdrawnAt?: string;

  @ValidateNested()
  @Type(() => ParticipantsDto)
  participants: ParticipantsDto;
}

/**
 * DisputeDecisionNotificationResponseDto
 * 
 * Response from notification creation.
 * Confirms that notifications have been enqueued for delivery.
 */
export interface DisputeDecisionNotificationResponseDto {
  disputeId: string;
  proofId: string;
  decisionType: string;
  notificationsEnqueued: number;
  participants: {
    proofOwner: boolean;
    disputeSubmitter: boolean;
    assignedReviewer: boolean;
  };
  enqueuedAt: string;
}
