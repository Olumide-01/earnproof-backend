import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ProofStatus } from "@prisma/client";
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";
import { AnchoringResultDto, SignedCredentialDto } from "./proof-created.dto";

export class RenewProofDto {
  @ApiPropertyOptional({
    description:
      "Supersede the predecessor with this existing proof instead of issuing a new one. " +
      "It must be owned by the caller, active, unlinked, and compatible in proof type, " +
      "issuer, asset, network, and disclosure policy.",
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(FIELD_LIMITS.id)
  successorProofId?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 365,
    default: 30,
    description:
      "Validity of a newly issued successor, from issuance. Ignored when successorProofId is set.",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}

export class SupersessionLinkDto {
  @ApiPropertyOptional({
    description: "Predecessor this proof supersedes, if any.",
    nullable: true,
    type: String,
  })
  supersedesId!: string | null;

  @ApiPropertyOptional({
    description: "Successor that supersedes this proof, if any.",
    nullable: true,
    type: String,
  })
  supersededById!: string | null;

  @ApiPropertyOptional({
    description: "ISO-8601 UTC timestamp when this proof was superseded.",
    nullable: true,
    type: String,
  })
  supersededAt!: string | null;
}

export class RenewalEligibilityResponseDto {
  @ApiProperty({ example: "clx1abc2def3ghi4" })
  proofId!: string;

  @ApiProperty({ example: true })
  eligible!: boolean;

  @ApiProperty({
    description: "Stable reason codes; empty when eligible.",
    type: [String],
    example: [],
    enum: ["revoked", "invalid", "expired_beyond_grace", "already_superseded"],
    isArray: true,
  })
  reasons!: string[];

  @ApiProperty({
    description: "ISO-8601 UTC time after which an expired proof can no longer be renewed.",
    example: "2025-03-01T00:00:00.000Z",
  })
  renewableUntil!: string;

  @ApiProperty({ type: () => SupersessionLinkDto })
  supersession!: SupersessionLinkDto;
}

export class ProofRenewalResponseDto {
  @ApiProperty({ description: "Predecessor proof ID.", example: "clx1abc2def3ghi4" })
  predecessorId!: string;

  @ApiProperty({ description: "Successor proof ID.", example: "clx9xyz8wvu7tsr6" })
  proofId!: string;

  @ApiProperty({ enum: ProofStatus, example: ProofStatus.ACTIVE })
  status!: ProofStatus;

  @ApiProperty({
    description: "`issued` for a newly issued successor, `linked` when an existing proof was attached.",
    enum: ["issued", "linked"],
  })
  mode!: "issued" | "linked";

  @ApiProperty({
    description: "True when this response replays an earlier identical renewal request.",
    example: false,
  })
  replayed!: boolean;

  @ApiProperty({ example: "/api/v1/proofs/clx9xyz8wvu7tsr6/verify" })
  verificationUrl!: string;

  @ApiProperty({
    description: "ISO-8601 UTC timestamp when the predecessor was superseded.",
    example: "2025-01-20T15:30:00.000Z",
  })
  supersededAt!: string;

  @ApiProperty({ type: () => SignedCredentialDto })
  credential!: SignedCredentialDto;

  @ApiProperty({
    type: () => AnchoringResultDto,
    description:
      "Anchoring of the successor itself. The proof registry contract has no supersession " +
      "entry point, so the predecessor/successor link is recorded off-chain only.",
  })
  anchoring!: AnchoringResultDto;
}
