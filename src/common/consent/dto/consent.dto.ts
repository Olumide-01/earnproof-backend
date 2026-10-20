import { ApiProperty } from "@nestjs/swagger";
import { PolicyType, PolicyStatus, ConsentAction } from "@prisma/client";
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class CreatePolicyVersionDto {
  @ApiProperty({
    enum: PolicyType,
    description: "Type of policy (privacy policy or terms of service)",
    example: "PRIVACY_POLICY",
  })
  @IsEnum(PolicyType)
  policyType: PolicyType;

  @ApiProperty({
    description: "Semantic version string",
    example: "1.2.0",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  version: string;

  @ApiProperty({
    description: "Full policy content text",
    example: "This privacy policy explains how we collect and use your data...",
  })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiProperty({
    enum: PolicyStatus,
    description: "Status of the policy version",
    example: "DRAFT",
    required: false,
  })
  @IsOptional()
  @IsEnum(PolicyStatus)
  status?: PolicyStatus;
}

export class PublishPolicyVersionDto {
  @ApiProperty({
    enum: PolicyType,
    description: "Type of policy to publish",
    example: "PRIVACY_POLICY",
  })
  @IsEnum(PolicyType)
  policyType: PolicyType;

  @ApiProperty({
    description: "Version to publish",
    example: "1.2.0",
  })
  @IsString()
  @IsNotEmpty()
  version: string;
}

export class ConsentRequestDto {
  @ApiProperty({
    enum: PolicyType,
    description: "Type of policy to consent to",
    example: "PRIVACY_POLICY",
  })
  @IsEnum(PolicyType)
  policyType: PolicyType;

  @ApiProperty({
    description: "Policy version being consented to",
    example: "1.2.0",
  })
  @IsString()
  @IsNotEmpty()
  version: string;

  @ApiProperty({
    enum: ConsentAction,
    description: "Action being taken (accept or withdraw)",
    example: "ACCEPT",
  })
  @IsEnum(ConsentAction)
  action: ConsentAction;
}

export class PolicyVersionResponseDto {
  @ApiProperty({
    description: "Policy version ID",
  })
  id: string;

  @ApiProperty({
    enum: PolicyType,
    description: "Type of policy",
  })
  policyType: PolicyType;

  @ApiProperty({
    description: "Version string",
  })
  version: string;

  @ApiProperty({
    description: "SHA-256 hash of policy content for integrity verification",
  })
  contentHash: string;

  @ApiProperty({
    enum: PolicyStatus,
    description: "Current status of this version",
  })
  status: PolicyStatus;

  @ApiProperty({
    description: "When this version was published (null for drafts)",
    nullable: true,
  })
  publishedAt: Date | null;

  @ApiProperty({
    description: "When this version was created",
  })
  createdAt: Date;
}

export class ConsentStatusDto {
  @ApiProperty({
    description: "Whether user has consented to the current policy version",
  })
  hasCurrentConsent: boolean;

  @ApiProperty({
    description: "Current published policy version",
    nullable: true,
  })
  currentPolicyVersion: string | null;

  @ApiProperty({
    description: "Policy version user has consented to",
    nullable: true,
  })
  userConsentVersion: string | null;

  @ApiProperty({
    enum: ConsentAction,
    description: "User's latest consent action",
    nullable: true,
  })
  userConsentAction: ConsentAction | null;

  @ApiProperty({
    description: "When user last took consent action",
    nullable: true,
  })
  userConsentDate: Date | null;

  @ApiProperty({
    description: "Whether user needs to accept a newer policy version",
  })
  requiresUpdate: boolean;
}

export class ConsentRecordDto {
  @ApiProperty({
    description: "Consent record ID",
  })
  id: string;

  @ApiProperty({
    description: "Policy version consented to",
  })
  policyVersion: string;

  @ApiProperty({
    description: "Content hash of the policy version",
  })
  contentHash: string;

  @ApiProperty({
    enum: ConsentAction,
    description: "Action taken (accept or withdraw)",
  })
  action: ConsentAction;

  @ApiProperty({
    description: "When the consent was recorded",
  })
  createdAt: Date;
}

export class ConsentResponseDto {
  @ApiProperty({
    description: "Created consent record ID",
  })
  id: string;

  @ApiProperty({
    description: "Whether this was the first time user accepted this policy",
  })
  isFirstAcceptance: boolean;

  @ApiProperty({
    enum: ConsentAction,
    description: "User's previous consent action for this version",
    nullable: true,
  })
  previousAction: ConsentAction | null;
}

export class MissingConsentDto {
  @ApiProperty({
    enum: PolicyType,
    description: "Policy type requiring consent",
  })
  policyType: PolicyType;

  @ApiProperty({
    description: "Current version requiring consent",
  })
  currentVersion: string;

  @ApiProperty({
    enum: ["never_consented", "outdated_version", "withdrawn"],
    description: "Reason why consent is missing",
  })
  reason: "never_consented" | "outdated_version" | "withdrawn";
}

export class RequiredConsentsCheckDto {
  @ApiProperty({
    description: "Whether all required consents are valid and current",
  })
  allConsentsValid: boolean;

  @ApiProperty({
    type: [MissingConsentDto],
    description: "List of missing or outdated consents",
  })
  missingConsents: MissingConsentDto[];
}