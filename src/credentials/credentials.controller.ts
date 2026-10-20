import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseInterceptors,
  Res,
  Optional,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiRequestTimeoutResponse,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Request } from "express";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { PublicRoute } from "../common/decorators/authorization-policy.decorator";
import { RequestTimeoutInterceptor } from "../common/interceptors/request-timeout.interceptor";
import { ThrottleCost } from "../common/rate-limit/throttle-cost.decorator";
import { CredentialVerificationKeyService } from "../common/crypto/credential-verification-key.service";
import { Response } from "express";
import { CredentialsService } from "./credentials.service";
import { EvidenceBundleService } from "./evidence-bundle.service";
import {
  GenerateEvidenceBundleDto,
  SignedEvidenceBundle,
  VerifyEvidenceBundleDto,
  VerifyEvidenceBundleResponseDto,
} from "./dto/evidence-bundle.dto";
import { VerifyCredentialResponseDto } from "./dto/verify-credential-response.dto";
import { VerifyCredentialDto } from "./dto/verify-credential.dto";
import { VerifyCredentialsBatchResponseDto } from "./dto/verify-credentials-batch-response.dto";
import { VerifyCredentialsBatchDto } from "./dto/verify-credentials-batch.dto";

/**
 * A worked example of a credential, used to document the request body.
 *
 * Held as a constant rather than inlined so the shape a verifier is asked to
 * post stays readable, and so the same document can illustrate both the request
 * and, in the failure example, what a tampered credential looks like.
 */
const EXAMPLE_CREDENTIAL = {
  id: "cred_01hxk8s3n7q9v2m4c6d8e0f2g4",
  type: "EarnProofMinimumIncomeCredential",
  schemaVersion: "earnproof.minimum-income.v1",
  issuer: "earnproof-backend",
  subject: {
    walletHash:
      "sha256:1f0c8b6b6f4b1f0a2e7d9c4a5b6e8f10123456789abcdef0123456789abcdef01",
  },
  claim: {
    operator: "gte",
    thresholdAmount: "500.0000000",
    assetCode: "XLM",
    assetIssuer: null,
    periodStart: "2026-05-01T00:00:00.000Z",
    periodEnd: "2026-08-01T00:00:00.000Z",
    qualifyingPaymentCount: 6,
  },
  privacy: {
    exactIncomeHidden: true,
    sourceTransactionsHidden: true,
  },
  issuedAt: "2026-08-01T09:12:44.000Z",
  expiresAt: "2026-11-01T09:12:44.000Z",
  proof: {
    type: "HMAC-SHA256",
    credentialHash:
      "sha256:7d3a1c9e5b2f48a06c1d7e93b5a4f80213c6e9d5a7b1c3e5f7092a4b6c8d0e2f",
    signature:
      "hmac-sha256:0YQ6oR3n0y1n7lXhV2sQ2t8kZQ0m4b6c8d0e2f4g6h8i0j2",
  },
};

/**
 * Public credential verification.
 *
 * Deliberately unauthenticated: a verifier is typically a landlord, lender or
 * employer holding a credential a worker handed them, and requiring them to
 * hold an account first would put a login between a worker and being believed.
 * See `docs/adr/0004-public-unauthenticated-verification.md`.
 */
@ApiTags("credentials")
@Controller("credentials")
export class CredentialsController {
  constructor(
    private readonly credentialsService: CredentialsService,
    @Optional()
    private readonly credentialVerificationKeyService?: CredentialVerificationKeyService,
    @Optional()
    private readonly evidenceBundleService?: EvidenceBundleService,
  ) {}

  @Get("keys")
  @ApiOperation({
    summary: "Discover credential verification keys",
    description:
      "Returns the public Ed25519 keys used to verify EarnProof credentials. " +
      "Active and overlap keys are published; private key material is never exposed.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Deterministically ordered public verification keys.",
  })
  getVerificationKeys(
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!this.credentialVerificationKeyService) {
      throw new Error("Credential verification keys are not configured");
    }

    const etag = this.credentialVerificationKeyService.getEtag();
    response.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
    response.setHeader("ETag", etag);

    if (ifNoneMatch === etag) {
      response.status(HttpStatus.NOT_MODIFIED);
      return;
    }

    return this.credentialVerificationKeyService.getPublicKeySet();
  }

  /** Verify a portable credential submitted by a third party. */
  @Post("verify")
  @PublicRoute()
  @ApiOperation({
    summary: "Verify a portable EarnProof credential",
    description:
      "Checks a credential a worker shared with you. The endpoint recomputes the " +
      "credential hash and signature, then reconciles the credential against the " +
      "issuing record: revocation, expiry, issuer state, and — where anchoring is " +
      "enabled — the on-chain commitment.\n\n" +
      "No authentication is required, and none of the worker's underlying data is " +
      "disclosed: the response is a single verdict, never the exact income, the " +
      "wallet address, or the payments the proof was built from.\n\n" +
      "A credential that fails a check is still a well-formed request and answers " +
      "`200` with a non-`valid` result. A `4xx` means the submission itself was " +
      "unusable — malformed, oversized, too deeply nested, or rate limited.\n\n" +
      "This route is rate limited to 10 requests per minute per client and is " +
      "subject to a request timeout.",
  })
  @ApiBody({
    type: VerifyCredentialDto,
    description:
      "The credential document exactly as it was issued, including its `proof` " +
      "block. Re-serializing it is safe — verification canonicalizes the body " +
      "before hashing — but altering any field is not.",
    examples: {
      issued: {
        summary: "A credential as issued",
        value: { credential: EXAMPLE_CREDENTIAL },
      },
      tampered: {
        summary: "The same credential with the threshold raised",
        description:
          "Answers `200` with `\"result\": \"invalid_signature\"`. The proof block " +
          "no longer matches the body it covers.",
        value: {
          credential: {
            ...EXAMPLE_CREDENTIAL,
            claim: { ...EXAMPLE_CREDENTIAL.claim, thresholdAmount: "5000.0000000" },
          },
        },
      },
    },
  })
  @ApiOkResponse({
    description:
      "The credential was processed. Read `result` for the verdict — success " +
      "here means the check ran, not that the credential is valid.",
    type: VerifyCredentialResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      "The submission could not be verified: not an object, larger than 32 KB, " +
      "nested deeper than 5 levels, or structurally malformed for its declared " +
      "schema version.",
    type: ApiErrorDto,
  })
  @ApiRequestTimeoutResponse({
    description: "Verification did not complete within the request deadline.",
    type: ApiErrorDto,
  })
  @ApiPayloadTooLargeResponse({
    description:
      "The request body exceeded the transport limit for this route and was " +
      "refused before it was parsed.",
    type: ApiErrorDto,
  })
  @ApiTooManyRequestsResponse({
    description: "Rate limit exceeded: more than 10 verifications in a minute.",
    type: ApiErrorDto,
  })
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @UseInterceptors(RequestTimeoutInterceptor)
  @HttpCode(HttpStatus.OK)
  verifyCredential(
    @Body() body: VerifyCredentialDto,
  ): Promise<VerifyCredentialResponseDto> {
    return this.credentialsService.verifyCredential(body.credential);
  }

  /** Verify a bounded batch of portable credentials in one request. */
  @Post("verify/batch")
  @ApiOperation({
    summary: "Verify a batch of portable EarnProof credentials",
    description:
      "Verifies up to a configured maximum of credentials in one request and " +
      "returns one result per item, in submission order. Each item runs through " +
      "the same checks as the single-credential endpoint, so a batch never " +
      "accepts a credential the single route would reject.\n\n" +
      "A `200` means the batch was accepted, not that every credential is valid: " +
      "read each item's `result`. A single unusable item is reported against its " +
      "own index with an `error` and never hides the other items' outcomes. A " +
      "`4xx` means the batch itself was unusable — empty, over the item cap, or " +
      "larger than the aggregate byte limit.\n\n" +
      "This route is rate limited by total item cost: a batch of N credentials " +
      "consumes N of the same per-minute budget the single route uses, so a " +
      "batch cannot buy a client more verification throughput than issuing the " +
      "same requests one at a time.",
  })
  @ApiBody({
    type: VerifyCredentialsBatchDto,
    description:
      "An array of credential documents, each exactly as issued including its " +
      "`proof` block. Results come back in the same order.",
    examples: {
      mixed: {
        summary: "One issued credential and one tampered credential",
        value: {
          credentials: [
            EXAMPLE_CREDENTIAL,
            {
              ...EXAMPLE_CREDENTIAL,
              claim: {
                ...EXAMPLE_CREDENTIAL.claim,
                thresholdAmount: "5000.0000000",
              },
            },
          ],
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      "The batch was processed. Each entry in `results` carries its own verdict.",
    type: VerifyCredentialsBatchResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "The batch itself could not be accepted: empty, more items than the cap, " +
      "or larger than the aggregate byte limit.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.REQUEST_TIMEOUT,
    description: "Verification did not complete within the request deadline.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    description:
      "The request body exceeded the transport limit for this route and was " +
      "refused before it was parsed.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description:
      "Rate limit exceeded: the batch's item cost exhausted the per-minute budget.",
    type: ApiErrorDto,
  })
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ThrottleCost((request: Request) => {
    const credentials = (request.body as { credentials?: unknown[] })
      ?.credentials;
    return Array.isArray(credentials) ? credentials.length : 1;
  })
  @UseInterceptors(RequestTimeoutInterceptor)
  @HttpCode(HttpStatus.OK)
  verifyCredentialsBatch(
    @Body() body: VerifyCredentialsBatchDto,
  ): Promise<VerifyCredentialsBatchResponseDto> {
    return this.credentialsService.verifyCredentialsBatch(body.credentials);
  }

  @ApiOperation({
    summary: "Generate a signed verification evidence bundle",
    description:
      "Generates a portable, tamper-evident manifest binding public proof outputs " +
      "to verified contract state, Stellar evidence, and freshness without exposing private records.",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Signed verification evidence bundle generated.",
  })
  @PublicRoute()
  @Post("evidence-bundle/generate")
  @HttpCode(HttpStatus.CREATED)
  generateEvidenceBundle(
    @Body() body: GenerateEvidenceBundleDto,
  ): Promise<SignedEvidenceBundle> {
    if (!this.evidenceBundleService) {
      throw new Error("EvidenceBundleService is not configured");
    }
    return this.evidenceBundleService.generateBundle(body.proofId, body.network);
  }

  @ApiOperation({
    summary: "Verify a signed verification evidence bundle",
    description:
      "Public verification for portable signed evidence bundles. Fails on tampering, " +
      "unsupported versions, network mismatch, expired evidence, or retired key IDs.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Verification verdict and details.",
    type: VerifyEvidenceBundleResponseDto,
  })
  @PublicRoute()
  @Post("evidence-bundle/verify")
  @HttpCode(HttpStatus.OK)
  verifyEvidenceBundle(
    @Body() body: VerifyEvidenceBundleDto,
  ): Promise<VerifyEvidenceBundleResponseDto> {
    if (!this.evidenceBundleService) {
      throw new Error("EvidenceBundleService is not configured");
    }
    return this.evidenceBundleService.verifyBundle(body.bundle, body.expectedNetwork);
  }
}
