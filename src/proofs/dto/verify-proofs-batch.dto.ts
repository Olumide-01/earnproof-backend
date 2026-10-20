import { ApiProperty } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  MaxLength,
} from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";

/**
 * A bounded batch of proof IDs to verify in one request.
 *
 * The endpoint reuses the single-proof verification path for each distinct ID,
 * so relying parties can reconcile a page of proofs without a request each. The
 * array is capped so the fan-out to storage and the anchoring contract stays
 * bounded; duplicate IDs are accepted and coalesced by the service (verified
 * once, their verdict returned at every position they occupy) rather than
 * rejected, so a caller listing the same proof twice gets a stable answer
 * without paying for the lookup twice.
 *
 * See `src/common/limits/request-limits.ts` for the cap and its reasoning.
 */
export class VerifyProofsBatchDto {
  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: FIELD_LIMITS.proofIdsPerBatch,
    description:
      `Between 1 and ${FIELD_LIMITS.proofIdsPerBatch} proof IDs. Results are ` +
      "returned in the same order, one per submitted ID. Duplicate IDs are " +
      "coalesced into a single lookup and share a verdict.",
    example: [
      "018e1234-abcd-7000-8000-abcdef012345",
      "018e5678-ef01-7000-8000-abcdef012345",
    ],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(FIELD_LIMITS.proofIdsPerBatch)
  @IsString({ each: true })
  @MaxLength(FIELD_LIMITS.id, { each: true })
  proofIds!: string[];
}
