import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { BulkAdminItemStatus, BulkAdminJobStatus, BulkAdminJobType } from "@prisma/client";

export const MAX_BULK_ITEMS = 100;

export class BulkAdminItemInputDto {
  @IsString()
  @IsNotEmpty()
  action: string;

  @IsString()
  @IsNotEmpty()
  resourceId: string;

  @IsObject()
  payload: Record<string, unknown>;
}

export class CreateBulkAdminJobDto {
  @IsEnum(BulkAdminJobType)
  jobType: BulkAdminJobType;

  @IsOptional()
  @IsBoolean()
  atomic?: boolean = false;

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BULK_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => BulkAdminItemInputDto)
  items: BulkAdminItemInputDto[];
}

export interface BulkAdminJobItemResponseDto {
  itemIndex: number;
  action: string;
  resourceId: string;
  status: BulkAdminItemStatus;
  errorCategory?: string | null;
  errorMessage?: string | null;
  completedAt?: string | null;
}

export interface BulkAdminJobResponseDto {
  id: string;
  organizationId: string;
  jobType: BulkAdminJobType;
  status: BulkAdminJobStatus;
  atomic: boolean;
  totalItems: number;
  processedItems: number;
  succeededItems: number;
  failedItems: number;
  idempotencyKey: string;
  cancelRequestedAt?: string | null;
  createdAt: string;
  completedAt?: string | null;
  items?: BulkAdminJobItemResponseDto[];
}
