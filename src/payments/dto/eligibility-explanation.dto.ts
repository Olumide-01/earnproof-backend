import { ApiProperty } from "@nestjs/swagger";
import { PaymentClassification } from "@prisma/client";
import { DECISION_TRIGGERS, REASON_CODES } from "../eligibility-policy";

const REASON_CODE_VALUES = Object.keys(REASON_CODES);

export class EligibilityFactorsDto {
  @ApiProperty({ description: "The asset is on the active supported-asset list.", example: true })
  assetSupported!: boolean;

  @ApiProperty({ enum: PaymentClassification, example: PaymentClassification.INCOME })
  classification!: PaymentClassification;

  @ApiProperty({ description: "The sender is one of the owner's active trusted sources.", example: false })
  sourceTrusted!: boolean;

  @ApiProperty({
    description: "The trusted source is linked to an active registered issuer.",
    example: false,
  })
  sourceIssuerVerified!: boolean;
}

export class EligibilityReasonDto {
  @ApiProperty({ enum: REASON_CODE_VALUES, example: "ASSET_SUPPORTED" })
  code!: string;

  @ApiProperty({
    enum: ["allow", "deny", "info"],
    description: "allow/deny decide `eligible`; info explains which proofs the payment can back.",
    example: "allow",
  })
  effect!: "allow" | "deny" | "info";

  @ApiProperty({ example: "The payment's asset is on the supported-asset list." })
  message!: string;
}

export class EligibilityUsageDto {
  @ApiProperty({ description: "Can back a payment-receipt proof.", example: true })
  paymentReceipt!: boolean;

  @ApiProperty({ description: "Can back minimum-income and recurring-income proofs.", example: true })
  incomeProofs!: boolean;
}

export class EligibilityHistoryItemDto {
  @ApiProperty({ example: "payment-eligibility.v1" })
  policyVersion!: string;

  @ApiProperty({ example: true })
  eligible!: boolean;

  @ApiProperty({ type: [String], example: ["ASSET_SUPPORTED", "CLASSIFICATION_INCOME", "SOURCE_NOT_TRUSTED"] })
  reasonCodes!: string[];

  @ApiProperty({ enum: DECISION_TRIGGERS, example: "sync" })
  trigger!: string;

  @ApiProperty({ example: "2026-09-25T09:00:00.000Z" })
  evaluatedAt!: Date;

  @ApiProperty({ nullable: true, type: String, example: null })
  supersededAt!: Date | null;
}

export class EligibilityExplanationDto {
  @ApiProperty({ example: "clx1abc2def3ghi4" })
  paymentId!: string;

  @ApiProperty({ description: "Mirrors Payment.isEligible.", example: true })
  eligible!: boolean;

  @ApiProperty({ example: "payment-eligibility.v1" })
  policyVersion!: string;

  @ApiProperty({ example: "2026-09-25T09:00:00.000Z" })
  evaluatedAt!: Date;

  @ApiProperty({ enum: DECISION_TRIGGERS, example: "sync" })
  trigger!: string;

  @ApiProperty({ type: EligibilityFactorsDto })
  factors!: EligibilityFactorsDto;

  @ApiProperty({ type: [EligibilityReasonDto] })
  reasons!: EligibilityReasonDto[];

  @ApiProperty({ type: EligibilityUsageDto })
  usage!: EligibilityUsageDto;

  @ApiProperty({
    type: [EligibilityHistoryItemDto],
    description: "Most recent decisions first, including the active one (at most 20).",
  })
  history!: EligibilityHistoryItemDto[];
}
