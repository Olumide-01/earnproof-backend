import { ApiProperty } from "@nestjs/swagger";
import { VerificationResult } from "@prisma/client";
import { ContractStatusDto } from "./verify-proof-response.dto";

/**
 * The verification outcome for one proof ID in a batch.
 *
 * Carries the same machine-readable `result` and human-readable `status` the
 * single-proof endpoint returns, so the four states a relying party must keep
 * apart stay distinguishable: a missing proof is `UNKNOWN_PROOF`, a revoked one
 * `REVOKED`, an expired one `EXPIRED`, and an anchoring dependency that could not
 * be reached is reflected in `contractStatus.checked` being false — never
 * collapsed into a single "invalid".
 */
export class BatchProofResultDto {
  @ApiProperty({
    description: "The proof ID this result is for.",
    example: "018e1234-abcd-7000-8000-abcdef012345",
  })
  id!: string;

  @ApiProperty({
    description: "Machine-readable verification outcome.",
    enum: VerificationResult,
    example: VerificationResult.VALID,
  })
  result!: VerificationResult;

  @ApiProperty({
    description: "Human-readable status string derived from `result`.",
    example: "valid",
    enum: ["valid", "expired", "revoked", "invalid", "unknown"],
  })
  status!: string;

  @ApiProperty({
    type: () => ContractStatusDto,
    description:
      "On-chain reconciliation state for this proof. `checked` is false when " +
      "anchoring is disabled or the contract could not be reached.",
  })
  contractStatus!: ContractStatusDto;
}

export class VerifyProofsBatchResponseDto {
  @ApiProperty({
    type: [BatchProofResultDto],
    description:
      "One entry per submitted proof ID, in submission order. Duplicate IDs each " +
      "receive the shared verdict at their own position.",
  })
  results!: BatchProofResultDto[];
}
