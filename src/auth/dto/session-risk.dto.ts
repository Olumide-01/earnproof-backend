import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { Type } from "class-transformer";
import { SessionRiskSeverity, SessionRiskType } from "@prisma/client";

export class ListRiskEventsDto {
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
  @IsEnum(SessionRiskSeverity)
  severity?: SessionRiskSeverity;

  @IsOptional()
  @IsEnum(SessionRiskType)
  riskType?: SessionRiskType;
}

export class ListReauthHistoryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  cursor?: string;
}
