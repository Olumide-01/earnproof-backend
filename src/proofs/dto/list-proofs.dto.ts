import { ProofStatus, ProofType } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  Matches,
} from "class-validator";

export class ListProofsDto {
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: "cursor must be a valid base64url string",
  })
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsEnum(ProofType)
  type?: ProofType;

  @IsOptional()
  @IsEnum(ProofStatus)
  status?: ProofStatus;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  assetCode?: string;

  @IsOptional()
  @IsDateString()
  issuedFrom?: string;

  @IsOptional()
  @IsDateString()
  issuedTo?: string;
}
