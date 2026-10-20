import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
} from "class-validator";
import { Type, Transform } from "class-transformer";
import {
  SecurityNotificationSeverity,
  SecurityNotificationType,
} from "@prisma/client";

export class CreateSecurityNotificationDto {
  @IsEnum(SecurityNotificationType)
  type: SecurityNotificationType;

  @IsOptional()
  @IsEnum(SecurityNotificationSeverity)
  severity?: SecurityNotificationSeverity = SecurityNotificationSeverity.INFO;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  summary: string;

  @IsOptional()
  @IsObject()
  data?: Record<string, unknown> = {};

  @IsOptional()
  @IsString()
  @MaxLength(256)
  resolutionUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  retentionDays?: number;
}

export class ListSecurityNotificationsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Transform(({ value }) => value === "true" || value === true)
  @IsBoolean()
  unreadOnly?: boolean;

  @IsOptional()
  @IsEnum(SecurityNotificationSeverity)
  severity?: SecurityNotificationSeverity;

  @IsOptional()
  @IsEnum(SecurityNotificationType)
  type?: SecurityNotificationType;
}

export interface SecurityNotificationResponseDto {
  id: string;
  organizationId: string;
  userId: string | null;
  type: SecurityNotificationType;
  severity: SecurityNotificationSeverity;
  title: string;
  summary: string;
  data: Record<string, unknown>;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedById: string | null;
  resolutionUrl: string | null;
  createdAt: string;
}

export interface UnreadCountResponseDto {
  organizationId: string;
  unreadCount: number;
}

export interface AcknowledgeNotificationResponseDto {
  id: string;
  acknowledged: true;
  acknowledgedAt: string;
  acknowledgedById: string;
}

export interface ResolutionLinkResponseDto {
  id: string;
  resolutionUrl: string | null;
}
