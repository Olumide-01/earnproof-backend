import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, Max, Min } from "class-validator";
import { ReminderDeliveryStatus } from "@prisma/client";

export class ProofReminderPreferencesDto {
  @ApiProperty({ description: "Whether proof expiration reminders are enabled" })
  enabled!: boolean;

  @ApiProperty({
    description: "Array of lead time hours before expiration to send reminders (e.g. [24, 72, 168])",
    type: [Number],
  })
  leadTimeHours!: number[];

  @ApiPropertyOptional({ description: "Timestamp when user opted out of reminders" })
  optedOutAt?: Date | null;
}

export class UpdateProofReminderPreferencesDto {
  @ApiPropertyOptional({ description: "Enable or disable proof expiration reminders" })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: "Configurable lead time hours (e.g. [24, 72, 168])",
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(720, { each: true }) // up to 30 days
  leadTimeHours?: number[];
}

export class ProofReminderDeliveryDto {
  @ApiProperty({ description: "Delivery ID" })
  id!: string;

  @ApiProperty({ description: "Proof ID" })
  proofId!: string;

  @ApiProperty({ description: "Lead window in hours" })
  windowHours!: number;

  @ApiProperty({ description: "Proof expiration target date" })
  targetDate!: Date;

  @ApiProperty({ enum: ReminderDeliveryStatus, description: "Delivery lifecycle status" })
  status!: ReminderDeliveryStatus;

  @ApiProperty({ description: "Scheduled dispatch time" })
  scheduledFor!: Date;

  @ApiPropertyOptional({ description: "Actual delivery timestamp" })
  deliveredAt?: Date | null;

  @ApiPropertyOptional({ description: "Cancellation timestamp if cancelled" })
  cancelledAt?: Date | null;

  @ApiPropertyOptional({ description: "Reason for cancellation" })
  cancellationReason?: string | null;

  @ApiPropertyOptional({ description: "Privacy-safe notification record" })
  notificationRecord?: Record<string, unknown> | null;
}
