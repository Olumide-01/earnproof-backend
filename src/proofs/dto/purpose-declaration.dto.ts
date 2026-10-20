import { IsString, IsDateString, IsOptional, MaxLength, IsObject } from 'class-validator';
import { PurposeDeclarationApprovalState } from '@prisma/client';

export class CreatePurposeDefinitionDto {
  @IsString()
  @MaxLength(128)
  purposeKey: string;

  @IsString()
  @MaxLength(500)
  description: string;

  @IsObject()
  disclosureScope: Record<string, unknown>;
}

export class CreatePurposeDeclarationDto {
  @IsString()
  purposeDefinitionId: string;

  @IsDateString()
  expiresAt: string;
}

export class ApprovePurposeDeclarationDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RevokePurposeDeclarationDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class PurposeDeclarationResponseDto {
  id: string;
  organizationId: string;
  purposeDefinitionId: string;
  verifierOrganizationId: string;
  approvalState: PurposeDeclarationApprovalState;
  approvedAt: string | null;
  approvedById: string | null;
  revokedAt: string | null;
  revokedById: string | null;
  expiresAt: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export class PurposeDefinitionResponseDto {
  id: string;
  organizationId: string;
  purposeKey: string;
  version: number;
  description: string;
  disclosureScope: Record<string, unknown>;
  createdAt: string;
  deactivatedAt: string | null;
}
