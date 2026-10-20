import { ApiProperty } from "@nestjs/swagger";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsObject } from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";
import { MaxBytes } from "../../common/validation/payload-limits";

/**
 * A bounded batch of portable credentials to verify in one request.
 *
 * The endpoint reuses the single-credential verification path for each item, so
 * an item is intentionally typed only as "an object" — a verifier posts a
 * document it was handed and cannot be asked to reshape it. The bounds that make
 * this safe live here: a maximum item count (so the fan-out is bounded) and a
 * maximum total serialised size (so neither many small items nor a few large
 * ones can exceed what the route will parse). Each item's own 32 KB and depth
 * limits are enforced per item by the service, exactly as on the single route.
 *
 * See `src/common/limits/request-limits.ts` for the numbers and their reasoning.
 */
export class VerifyCredentialsBatchDto {
  @ApiProperty({
    type: "array",
    items: { type: "object", additionalProperties: true },
    minItems: 1,
    maxItems: FIELD_LIMITS.credentialsPerBatch,
    description:
      `Between 1 and ${FIELD_LIMITS.credentialsPerBatch} credential documents, ` +
      "each exactly as issued (including its `proof` block). Results are returned " +
      "in the same order. One malformed item is reported against its own index " +
      "and does not affect the others. The whole batch must serialise to at most " +
      `${FIELD_LIMITS.batchCredentialsBytes / 1024} KB.`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(FIELD_LIMITS.credentialsPerBatch)
  @IsObject({ each: true })
  @MaxBytes(FIELD_LIMITS.batchCredentialsBytes)
  credentials!: Record<string, unknown>[];
}
