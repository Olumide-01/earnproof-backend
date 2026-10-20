import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

export class CancelIdempotentOperationDto {
  @ApiPropertyOptional({ description: "Reason for cancellation" })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class IdempotentOperationStatusResponseDto {
  @ApiProperty({ description: "User-supplied idempotency key" })
  idempotencyKey!: string;

  @ApiProperty({ description: "Tenant organization identifier" })
  organizationId!: string;

  @ApiProperty({
    description: "Current operation lifecycle state",
    enum: ["PENDING", "COMPLETED", "FAILED", "CANCELLED", "EXPIRED"],
  })
  status!: "PENDING" | "COMPLETED" | "FAILED" | "CANCELLED" | "EXPIRED";

  @ApiPropertyOptional({ description: "Typed domain operation name" })
  operationType?: string | null;

  @ApiPropertyOptional({ description: "Resource type associated with operation" })
  resourceType?: string | null;

  @ApiPropertyOptional({ description: "Target resource identifier" })
  resourceId?: string | null;

  @ApiProperty({ description: "Number of execution attempts under this key" })
  attemptCount!: number;

  @ApiPropertyOptional({ description: "Stored HTTP response status code" })
  responseStatusCode?: number | null;

  @ApiPropertyOptional({ description: "Replayable response body (secrets stripped)" })
  responseBody?: any;

  @ApiPropertyOptional({ description: "Read-after-write consistency token" })
  consistencyToken?: string | null;

  @ApiProperty({ description: "Timestamp when record is eligible for retention cleanup" })
  expiresAt!: Date;

  @ApiPropertyOptional({ description: "Cancellation reason if cancelled" })
  cancellationReason?: string | null;

  @ApiProperty({ description: "Whether this operation is in a terminal state" })
  terminal!: boolean;

  @ApiProperty({ description: "Whether client can safely retry under a new or same key" })
  retryable!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
