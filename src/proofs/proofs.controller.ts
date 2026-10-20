import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Query,
  UseGuards,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import { ApiKeyScope, SharingOutcome } from "@prisma/client";
import { Request } from "express";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import {
  AuthenticatedRoute,
  PublicRoute,
} from "../common/decorators/authorization-policy.decorator";
import { Idempotent } from "../common/decorators/idempotent.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { AuthGuard } from "../common/guards/auth.guard";
import { AbandonAnchoringResponseDto } from "./dto/abandon-anchoring-response.dto";
import { ProofAnchoringStatusResponseDto } from "./dto/anchoring-intent-status.dto";
import { CreateInvoiceSettlementProofDto } from "./dto/create-invoice-settlement-proof.dto";
import { CreateIncomeRangeProofDto } from "./dto/create-income-range-proof.dto";
import { RequireApiKeyScopes } from "../common/guards/api-key-quota.guard";
import { RequireConsent } from "../common/guards/consent.guard";
import {
  CreateSharingTokenDto,
  SharingTokenResponseDto,
  ProofSharingSummaryDto,
  SharingAccessQueryDto,
} from "./dto/proof-sharing.dto";
import { ThrottleCost } from "../common/rate-limit/throttle-cost.decorator";
import { CreateAggregateEarningsProofDto } from "./dto/create-aggregate-earnings-proof.dto";
import { CreateMinimumIncomeProofDto } from "./dto/create-minimum-income-proof.dto";
import { CreatePaymentReceiptProofDto } from "./dto/create-payment-receipt-proof.dto";
import { CreateRecurringIncomeProofDto } from "./dto/create-recurring-income-proof.dto";
import { CreateEmployerPaymentProofDto } from "./dto/create-employer-payment-proof.dto";
import { CreateEmploymentContinuityProofDto } from "./dto/create-employment-continuity-proof.dto";
import { ListProofsDto } from "./dto/list-proofs.dto";
import { ProofCreatedDto } from "./dto/proof-created.dto";
import {
  ProofDetailResponseDto,
  ProofListResponseDto,
} from "./dto/proof-history-response.dto";
import { RetryAnchoringResponseDto } from "./dto/retry-anchoring-response.dto";
import { RevokeProofDto } from "./dto/revoke-proof.dto";
import {
  ProofRenewalResponseDto,
  RenewalEligibilityResponseDto,
  RenewProofDto,
} from "./dto/renew-proof.dto";
import { RevokeProofResponseDto } from "./dto/revoke-proof-response.dto";
import { VerifyProofResponseDto } from "./dto/verify-proof-response.dto";
import { VerifyProofsBatchResponseDto } from "./dto/verify-proofs-batch-response.dto";
import { VerifyProofsBatchDto } from "./dto/verify-proofs-batch.dto";
import { VerificationStatsDto } from "./dto/verification-stats.dto";
import { RefreshProofRequestDto, RefreshProofResponseDto } from "./dto/refresh-proof.dto";
import { ProofsService } from "./proofs.service";
import { ProofSharingService } from "./proof-sharing.service";
import { PrismaService } from "../database/prisma.service";
import { ProofCapacityPreflightService } from "./proof-capacity-preflight.service";
import { ProofCapacityPreflightDto } from "./dto/capacity-preflight.dto";
import { BoundedRefreshService } from "./bounded-refresh.service";

@ApiTags("proofs")
@Controller("proofs")
export class ProofsController {
  constructor(
    private readonly proofsService: ProofsService,
    private readonly proofSharingService: ProofSharingService,
    private readonly prisma: PrismaService,
    private readonly boundedRefreshService: BoundedRefreshService,
    private readonly preflightService?: ProofCapacityPreflightService,
  ) {}

  @ApiBearerAuth()
  @ApiOperation({
    summary: "List the authenticated user's proofs",
    description:
      "Returns cursor-paginated proof summaries. The response separates local lifecycle status, credential validity, expiration, and contract anchoring state without exposing protected payment data.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Proof history page.",
    type: ProofListResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "The cursor or issued-at date range is invalid.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Get()
  @AuthenticatedRoute({ ownership: "user" })
  listProofs(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListProofsDto,
  ) {
    return this.proofsService.listProofs(user.id, query);
  }

  @ApiBearerAuth()
  @ApiOperation({
    summary: "Preflight check proof issuance capacity and quotas",
    description:
      "Returns advisory capacity evaluation combining organization quota and live contract status. Does not grant authorization.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Proof capacity preflight response.",
  })
  @UseGuards(AuthGuard)
  @Get("preflight")
  @AuthenticatedRoute({ ownership: "user" })
  async getCapacityPreflight(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ProofCapacityPreflightDto,
  ) {
    if (!this.preflightService) {
      throw new BadRequestException("Preflight service not available");
    }
    return this.preflightService.evaluatePreflight(user.id, query);
  }

  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get an owned proof",
    description:
      "Returns proof details for the owner or an administrator. Unknown and non-owned proof IDs produce the same not-found response.",
  })
  @ApiParam({ name: "id", description: "Proof ID (uuid)." })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Proof details.",
    type: ProofDetailResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Proof not found or not accessible to this user.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Get(":id")
  @AuthenticatedRoute({ ownership: "user" })
  getProofDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.proofsService.getProofDetail(user, id);
  }

  @ApiOperation({
    summary: "Create a selectively disclosed payment-receipt proof",
    description:
      "Issues a receipt credential for one eligible payment owned by the authenticated user. Sender and exact amount are hidden unless independently opted in.",
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Payment-receipt proof created.",
    type: ProofCreatedDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Payment does not exist or belongs to another user.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      "Payment is excluded, ineligible, or request validation failed.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "Idempotency key was used with a different request payload.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.REQUEST_TIMEOUT,
    description: "Previous idempotent request is still being processed.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Idempotent({ headerName: "idempotency-key", required: true })
  @Post("payment-receipt")
  @AuthenticatedRoute({ ownership: "user" })
  createPaymentReceiptProof(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreatePaymentReceiptProofDto,
  ) {
    return this.proofsService.createPaymentReceiptProof(user, body);
  }

  @ApiOperation({
    summary: "Create an invoice-settlement proof",
    description:
      "Binds a caller-supplied invoice reference to exactly one confirmed payment matching " +
      "the requested issuer, asset, and exact amount. The raw invoice reference is never " +
      "stored or disclosed — only a normalized SHA-256 commitment is embedded in the credential. " +
      "Ambiguous (multiple matching payments) or unconfirmed (no matching payment) requests are " +
      "rejected, and a payment already bound to a different invoice cannot be reused.",
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Invoice-settlement proof created.",
    type: ProofCreatedDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "The issuer is invalid/inactive, or the requested period range is invalid.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "No confirmed payment matches the requested issuer, asset, and amount.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: "More than one payment matches the requested criteria (ambiguous).",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      "The matched payment is already bound to a different invoice, or this invoice reference " +
      "has already been settled for this issuer.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @AuthenticatedRoute({ ownership: "user" })
  @Post("invoice-settlement")
  createInvoiceSettlementProof(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateInvoiceSettlementProofDto,
  ) {
    return this.proofsService.createInvoiceSettlementProof(user, body);
  }

  @ApiOperation({
    summary: "Create a minimum-income proof",
    description:
      "Generates a privacy-preserving credential asserting that the authenticated wallet " +
      "received at least `thresholdAmount` of a given asset during the specified period. " +
      "The exact income and individual transactions are never disclosed; only the boolean " +
      "outcome (threshold met) is embedded in the credential.",
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.CREATED,
    description:
      "Proof created. Returns the signed credential and an optional anchoring result.",
    type: ProofCreatedDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: "Request body failed validation.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "Business rule violation — e.g. period range invalid, payments ineligible, " +
      "asset mismatch, or threshold not met.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "Idempotency key was used with a different request payload.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.REQUEST_TIMEOUT,
    description: "Previous idempotent request is still being processed.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  // Proof creation is expensive (Stellar reads, contract anchoring) — the
  // "strict" tier, not "default". SkipThrottle excludes the OTHER named
  // throttlers so this route is judged against exactly one budget, not all
  // three simultaneously (see rate-limit.module.ts's doc comment).
  @SkipThrottle({ default: true, verification: true })
  @Throttle({ strict: {} })
  @Idempotent({ headerName: "idempotency-key", required: true })
  @Post("minimum-income")
  @AuthenticatedRoute({ ownership: "user" })
  createMinimumIncomeProof(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateMinimumIncomeProofDto,
  ) {
    return this.proofsService.createMinimumIncomeProof(user, body);
  }

  @ApiOperation({
    summary: "Create an income-range proof",
    description:
      "Generates a privacy-preserving credential asserting that the authenticated wallet " +
      "received a total income inside the inclusive range [`lowerBound`, `upperBound`] of a " +
      "given asset during the specified period. The exact income total and individual " +
      "transactions are never disclosed; only the committed bounds and the boolean outcome " +
      "are embedded in the credential.",
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.CREATED,
    description:
      "Proof created. Returns the signed credential and an optional anchoring result.",
    type: ProofCreatedDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: "Request body failed validation.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "Business rule violation — e.g. period range invalid, bounds inverted or degenerate, " +
      "payments ineligible, asset mismatch, or the payment sum falls outside the requested range.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @AuthenticatedRoute({ ownership: "user" })
  @Post("income-range")
  createIncomeRangeProof(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateIncomeRangeProofDto,
  ) {
    return this.proofsService.createIncomeRangeProof(user, body);
  }

  @ApiOperation({
    summary: "Create a recurring-income proof",
    description:
      "Issues a privacy-preserving credential when every requested cadence interval contains at least one eligible income payment in the selected asset.",
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Recurring-income proof created.",
    type: ProofCreatedDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "The cadence is unsatisfied or a selected payment violates the ownership, classification, eligibility, asset, or period rules.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "Idempotency key was used with a different request payload.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.REQUEST_TIMEOUT,
    description: "Previous idempotent request is still being processed.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Idempotent({ headerName: "idempotency-key", required: true })
  @Post("recurring-income")
  @AuthenticatedRoute({ ownership: "user" })
  createRecurringIncomeProof(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateRecurringIncomeProofDto,
  ) {
    return this.proofsService.createRecurringIncomeProof(user, body);
  }

  @ApiOperation({
    summary: "Create an aggregate-earnings proof",
    description:
      "Sums the caller's eligible income payments in one asset over a half-open period under the " +
      "versioned aggregate-earnings policy, floors the total to the requested rounding increment, " +
      "and issues a credential committing only that rounded aggregate, the payment count and the " +
      "policy parameters. Component payments, exact amounts and source identities are not disclosed.",
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Aggregate-earnings proof created.",
    type: ProofCreatedDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "INVALID_INPUT: the period is empty, longer than 366 days or in the future, issuerIds was " +
      "given without sourceScope verified_issuers, or a requested issuer is unknown or inactive.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      "Validation failed, or the policy refused the aggregate: AGGREGATION_CROSS_ASSET_UNSUPPORTED, " +
      "AGGREGATION_INSUFFICIENT_PAYMENTS (fewer than 2 payments, or a total below the increment), " +
      "AGGREGATION_LIMIT_EXCEEDED (more than 500 payments), or PAYMENT_NOT_ELIGIBLE (an amount is unreadable).",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @AuthenticatedRoute({ ownership: "user" })
  @SkipThrottle({ default: true, verification: true })
  @Throttle({ strict: {} })
  @Post("aggregate-earnings")
  createAggregateEarningsProof(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateAggregateEarningsProofDto,
  ) {
    return this.proofsService.createAggregateEarningsProof(user, body);
  }

  @ApiOperation({
    summary: "Create an employer-payment proof",
    description:
      "Issues a credential stating that the caller received an eligible income payment from a " +
      "verified employer source within the specified period. The credential commits only to " +
      "the employer's identity, the asset, the period, and the policy parameters. Exact amounts, " +
      "source accounts, and individual payments are not disclosed.",
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Employer-payment proof created.",
    type: ProofCreatedDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "The period is invalid, longer than 366 days, or ends in the future.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Trusted source does not exist or belongs to another user.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      "The source is untrusted, revoked or ambiguous (EMPLOYER_SOURCE_UNTRUSTED, EMPLOYER_SOURCE_AMBIGUOUS), " +
      "no eligible payment falls inside the period (EMPLOYER_PAYMENT_NOT_FOUND), or request validation failed.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "Idempotency key was used with a different request payload.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.REQUEST_TIMEOUT,
    description: "Previous idempotent request is still being processed.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @SkipThrottle({ default: true, verification: true })
  @Throttle({ strict: {} })
  @Idempotent({ headerName: "idempotency-key", required: true })
  @Post("employer-payment")
  @AuthenticatedRoute({ ownership: "user" })
  createEmployerPaymentProof(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateEmployerPaymentProofDto,
  ) {
    return this.proofsService.createEmployerPaymentProof(user, body);
  }

  @ApiOperation({
    summary: "Create an employment-continuity proof",
    description:
      "Issues a credential stating that corroborated income payments from one verified employer source cover " +
      "a completed window of consecutive UTC calendar months, allowing at most one missing month and requiring " +
      "the first and last months to be covered. The credential commits only to the continuity result and the " +
      "policy version and parameters it was evaluated under.",
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Employment-continuity proof created.",
    type: ProofCreatedDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "periodStart is not the first instant of a UTC month, observedPeriods is out of range, or the window has not ended.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Trusted source does not exist or belongs to another user.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      "The source is untrusted, revoked or ambiguous, the continuity rule is not met (CONTINUITY_NOT_SATISFIED), " +
      "the window holds too many payments (CONTINUITY_LIMIT_EXCEEDED), or request validation failed.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "Idempotency key was used with a different request payload.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.REQUEST_TIMEOUT,
    description: "Previous idempotent request is still being processed.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @SkipThrottle({ default: true, verification: true })
  @Throttle({ strict: {} })
  @Idempotent({ headerName: "idempotency-key", required: true })
  @Post("employment-continuity")
  @AuthenticatedRoute({ ownership: "user" })
  createEmploymentContinuityProof(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateEmploymentContinuityProofDto,
  ) {
    return this.proofsService.createEmploymentContinuityProof(user, body);
  }

  @ApiOperation({
    summary: "Revoke a proof",
    description:
      "Marks the proof as REVOKED and records the revoking actor, reason, and revocation timestamp. " +
      "If the proof was anchored on-chain, a revocation transaction is also submitted. " +
      "The owner of the proof or an administrator may revoke it. Idempotent: revoking an " +
      "already-revoked proof returns its original revocation metadata unchanged.",
  })
  @ApiBearerAuth()
  @ApiParam({
    name: "id",
    description: "Proof ID (uuid).",
    example: "018e1234-abcd-7000-8000-abcdef012345",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Proof revoked.",
    type: RevokeProofResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Proof not found.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Proof does not belong to the authenticated user and they are not an administrator.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @AuthenticatedRoute({ ownership: "user" })
  @Patch(":id/revoke")
  revokeProof(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body?: RevokeProofDto,
  ) {
    if (body !== undefined) {
      return this.proofsService.revokeProof(user, id, body);
    }
    return this.proofsService.revokeProof(user, id);
  }

  @ApiOperation({
    summary: "Get a proof's anchoring status",
    description:
      "Returns the current on-chain anchoring intent(s) for a proof (at most one REGISTER " +
      "and one REVOKE). This is a live status snapshot, not a per-attempt history: the " +
      "schema keeps one row per operation, overwritten on each attempt. Any failure detail " +
      "returned is already redacted. Available to the proof's owner or an administrator.",
  })
  @ApiBearerAuth()
  @ApiParam({
    name: "id",
    description: "Proof ID (uuid).",
    example: "018e1234-abcd-7000-8000-abcdef012345",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Anchoring status for the proof.",
    type: ProofAnchoringStatusResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Proof not found, or does not belong to the authenticated user.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @AuthenticatedRoute({ ownership: "user" })
  @Get(":id/anchoring")
  getProofAnchoringStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.proofsService.getProofAnchoringStatus(user, id);
  }

  @ApiOperation({
    summary: "Redrive a quarantined anchoring intent",
    description:
      "Requeues a QUARANTINED anchoring intent for the worker to retry on its next poll " +
      "cycle. Does not invoke the chain synchronously. Only a quarantined intent without a " +
      "prior ABANDONED decision is eligible; a PENDING intent is already scheduled to retry " +
      "itself, and a PROCESSING or CONFIRMED intent cannot be retried. Available to the " +
      "proof's owner or an administrator.",
  })
  @ApiBearerAuth()
  @ApiParam({
    name: "id",
    description: "Proof ID (uuid).",
    example: "018e1234-abcd-7000-8000-abcdef012345",
  })
  @ApiParam({
    name: "intentId",
    description: "Anchoring intent ID.",
    example: "clx1abc2def3ghi4",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "The intent was requeued.",
    type: RetryAnchoringResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      "Proof not found, does not belong to the authenticated user, or the intent does not " +
      "belong to this proof.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: "The intent is not eligible for retry (not quarantined, or already abandoned).",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @AuthenticatedRoute({ ownership: "user" })
  @Post(":id/anchoring/:intentId/retry")
  retryProofAnchoring(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Param("intentId") intentId: string,
  ) {
    return this.proofsService.retryProofAnchoring(user, id, intentId);
  }

  @ApiOperation({
    summary: "Abandon a quarantined anchoring intent",
    description:
      "Records a terminal operator decision that a quarantined anchoring intent will never " +
      "be retried again. Only touches the anchoring intent, never the proof's own status or " +
      "on-chain transaction hash: abandoning a REGISTER intent cannot make an unanchored " +
      "proof look confirmed. Idempotent: abandoning an already-abandoned intent returns its " +
      "existing decision unchanged. Available to the proof's owner or an administrator.",
  })
  @ApiBearerAuth()
  @ApiParam({
    name: "id",
    description: "Proof ID (uuid).",
    example: "018e1234-abcd-7000-8000-abcdef012345",
  })
  @ApiParam({
    name: "intentId",
    description: "Anchoring intent ID.",
    example: "clx1abc2def3ghi4",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "The intent was abandoned.",
    type: AbandonAnchoringResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      "Proof not found, does not belong to the authenticated user, or the intent does not " +
      "belong to this proof.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: "The intent is not eligible for abandonment (not quarantined).",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @AuthenticatedRoute({ ownership: "user" })
  @Post(":id/anchoring/:intentId/abandon")
  abandonProofAnchoring(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Param("intentId") intentId: string,
  ) {
    return this.proofsService.abandonProofAnchoring(user, id, intentId);
  }

  @ApiBearerAuth()
  @ApiOperation({
    summary: "Check whether a proof can be renewed",
    description:
      "Returns renewal eligibility with stable reason codes (`revoked`, `invalid`, " +
      "`expired_beyond_grace`, `already_superseded`) and the proof's supersession links. " +
      "Expired proofs remain renewable for a grace period after expiry. Only the proof owner may call this.",
  })
  @ApiParam({ name: "id", description: "Proof ID (uuid)." })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Renewal eligibility.",
    type: RenewalEligibilityResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Proof not found.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Proof does not belong to the authenticated user.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @AuthenticatedRoute({ ownership: "user" })
  @Get(":id/renewal-eligibility")
  getRenewalEligibility(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.proofsService.getRenewalEligibility(user.id, id);
  }

  @ApiBearerAuth()
  @ApiOperation({
    summary: "Renew a proof",
    description:
      "Supersedes an eligible proof. Without `successorProofId`, issues a successor carrying the " +
      "same claim with a fresh validity window; with it, links an existing compatible proof " +
      "(same owner, proof type, issuer, asset, network, and disclosure policy) as the successor. " +
      "A proof has at most one successor: concurrent renewals cannot fork the chain, and links " +
      "that would form a cycle are rejected. Repeating an identical request (same body and " +
      "`Idempotency-Key`) returns the original successor with `replayed: true`; any other " +
      "request for an already-superseded proof returns 409. The supersession link is recorded " +
      "off-chain; an issued successor is anchored through the normal registration path.",
  })
  @ApiParam({ name: "id", description: "Predecessor proof ID (uuid)." })
  @ApiHeader({
    name: "Idempotency-Key",
    required: false,
    description: "Client-chosen key (1-128 chars) scoping retries of one renewal.",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Successor issued or linked (or an identical request replayed).",
    type: ProofRenewalResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Invalid Idempotency-Key.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Proof or successor proof not found.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Proof does not belong to the authenticated user.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "Proof was already superseded by a different renewal.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      "Proof is not eligible for renewal, or the successor is incompatible.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @AuthenticatedRoute({ ownership: "user" })
  // Renewal issues a credential, so it shares proof creation's strict budget.
  @SkipThrottle({ default: true, verification: true })
  @Throttle({ strict: {} })
  @Post(":id/renew")
  renewProof(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: RenewProofDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.proofsService.renewProof(user, id, body, idempotencyKey);
  }

  @ApiOperation({
    summary: "Verify a proof (public)",
    description:
      "Public endpoint. Reconstructs the credential from the stored proof, recomputes the " +
      "HMAC commitment, and returns the verification result. No authentication required — " +
      "third parties such as issuers can call this endpoint directly. " +
      "Supports optional sharing token via Authorization header for access tracking.",
  })
  @ApiParam({
    name: "id",
    description: "Proof ID (uuid) OR sharing token.",
    example: "018e1234-abcd-7000-8000-abcdef012345",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Verification result and the signed credential.",
    type: VerifyProofResponseDto,
  })
  @SkipThrottle({ default: true, strict: true })
  @Throttle({ verification: {} })
  @Get(":id/verify")
  @PublicRoute()
  async verifyProof(@Param("id") proofIdOrToken: string, @Req() request: Request) {
    // Check if this might be a sharing token
    let actualProofId = proofIdOrToken;
    let usedSharingToken = false;

    if (proofIdOrToken.startsWith("share_")) {
      // This is a sharing token - verify and get the actual proof ID
      const sharingResult = await this.proofSharingService.verifyWithSharingToken(
        proofIdOrToken,
        {
          ipAddress: request.ip || "0.0.0.0",
          userAgent: request.headers["user-agent"] || "unknown",
        },
      );

      if (sharingResult.isValid && (sharingResult.proof as any)?.id) {
        actualProofId = (sharingResult.proof as any).id;
        usedSharingToken = true;
      } else {
        // Sharing token verification failed
        return {
          result: "UNKNOWN_PROOF",
          status: "unknown",
          reason: "Invalid or expired sharing token",
        };
      }
    }

    // Proceed with normal proof verification
    const result = await this.proofsService.verifyProof(actualProofId, { 
      ip: request.ip,
    });

    return result;
  }

  @ApiOperation({
    summary: "Verify a batch of proofs (public)",
    description:
      "Public endpoint. Verifies up to a configured maximum of proof IDs in one " +
      "request and returns one result per submitted ID, in order. Authorization " +
      "and privacy match the single verification endpoint exactly — no " +
      "authentication, and no underlying payment data is disclosed.\n\n" +
      "Missing, revoked, expired, and dependency-unavailable outcomes stay " +
      "distinguishable per item. Duplicate IDs are coalesced into a single " +
      "lookup and share a verdict.\n\n" +
      "The batch is rate limited by total item cost: N IDs consume N of the same " +
      "verification budget a single lookup uses, so a batch cannot exceed the " +
      "throughput of the same requests made individually.",
  })
  @ApiBody({
    type: VerifyProofsBatchDto,
    description: "The proof IDs to verify. Results are returned in the same order.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Ordered verification results, one per submitted proof ID.",
    type: VerifyProofsBatchResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "The batch itself could not be accepted: empty or more IDs than the cap.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description:
      "Rate limit exceeded: the batch's item cost exhausted the verification budget.",
    type: ApiErrorDto,
  })
  @SkipThrottle({ default: true, strict: true })
  @Throttle({ verification: {} })
  @ThrottleCost((request: Request) => {
    const proofIds = (request.body as { proofIds?: unknown[] })?.proofIds;
    return Array.isArray(proofIds) ? proofIds.length : 1;
  })
  @PublicRoute()
  @HttpCode(HttpStatus.OK)
  @Post("verify/batch")
  verifyProofsBatch(
    @Body() body: VerifyProofsBatchDto,
  ): Promise<VerifyProofsBatchResponseDto> {
    return this.proofsService.verifyProofsBatch(body.proofIds);
  }

  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get aggregate verification statistics for a proof",
    description:
      "Returns privacy-safe outcome counts. Only the proof owner may access these statistics; verifier identity is never returned.",
  })
  @ApiParam({ name: "id", description: "Proof ID (uuid)." })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Aggregate verification outcome counts.",
    type: VerificationStatsDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "The proof belongs to another user.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Proof not found.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @RequireApiKeyScopes(ApiKeyScope.PROOF_READ) // Example of API key quota enforcement
  @RequireConsent("PRIVACY_POLICY") // Example of consent requirement
  @Get(":id/verification-stats")
  @AuthenticatedRoute({ ownership: "user" })
  getVerificationStats(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.proofsService.getVerificationStats(user.id, id);
  }

  /**
   * Create a sharing token for a proof.
   * Only proof owners can create sharing tokens.
   */
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Create a sharing token for a proof",
    description: "Generate a time-limited sharing token that allows others to verify this proof without authentication. The token is displayed exactly once.",
  })
  @ApiParam({ name: "id", description: "Proof ID (uuid)." })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Sharing token created successfully.",
    type: SharingTokenResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "The proof belongs to another user or is not shareable.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Proof not found.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Post(":id/sharing-token")
  @AuthenticatedRoute({ ownership: "user" })
  async createSharingToken(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") proofId: string,
    @Body() body: CreateSharingTokenDto,
    @Req() request: Request,
  ): Promise<SharingTokenResponseDto> {
    // Get user's organization (simplified - assumes single org membership)
    const orgMember = await this.getUserPrimaryOrganization(user.id);
    if (!orgMember) {
      throw new ForbiddenException("User must belong to an organization");
    }

    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined;
    if (expiresAt && expiresAt <= new Date()) {
      throw new BadRequestException("expiresAt must be in the future");
    }

    const result = await this.proofSharingService.generateSharingToken(
      orgMember.organizationId,
      proofId,
      {
        purpose: "Proof sharing",
        requestedBy: user.id,
      },
      {
        ipAddress: request.ip || "0.0.0.0",
        userAgent: (request.headers["user-agent"] as string) || "unknown",
      },
    );

    return result;
  }

  /**
   * Get sharing access summary for user's proofs.
   * Returns privacy-safe aggregate and recent access data.
   */
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get proof sharing access summary",
    description: "Returns privacy-safe aggregates and recent access events for your proofs. Verifier identities are never exposed.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Sharing access summary.",
    type: ProofSharingSummaryDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Access denied to organization data.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Get("sharing-access")
  @AuthenticatedRoute({ ownership: "user" })
  async getSharingAccess(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: SharingAccessQueryDto,
  ): Promise<ProofSharingSummaryDto> {
    // Determine organization context
    let organizationId = query.organizationId;
    if (!organizationId) {
      const orgMember = await this.getUserPrimaryOrganization(user.id);
      if (!orgMember) {
        throw new ForbiddenException("User must belong to an organization");
      }
      organizationId = orgMember.organizationId;
    }

    const events = await this.proofSharingService.getSharingEvents(
      organizationId,
      {
        proofId: query.proofId,
      },
    );

    const aggregateMap = new Map<SharingOutcome, { count: number; lastAccessedAt: Date | null }>();
    for (const event of events) {
      const existing = aggregateMap.get(event.outcome) ?? { count: 0, lastAccessedAt: null };
      existing.count += 1;
      if (!existing.lastAccessedAt || event.createdAt > existing.lastAccessedAt) {
        existing.lastAccessedAt = event.createdAt;
      }
      aggregateMap.set(event.outcome, existing);
    }
    const aggregates = Array.from(aggregateMap.entries()).map(([outcome, data]) => ({
      outcome,
      count: data.count,
      lastAccessedAt: data.lastAccessedAt,
    }));
    const recentEvents = events.slice(0, 50).map((e: any) => ({
      proofId: e.proofId,
      outcome: e.outcome,
      accessedAt: e.createdAt,
    }));

    return { aggregates, recentEvents };
  }

  /**
   * Helper: Get user's primary organization membership.
   */
  private async getUserPrimaryOrganization(userId: string) {
    return this.prisma.organizationMember.findFirst({
      where: {
        userId,
        status: "ACTIVE",
      },
      select: {
        organizationId: true,
        role: true,
      },
      orderBy: {
        createdAt: "asc", // Get first/primary membership
      },
    });
  }

  /**
   * Refresh verification for an authenticated user's proof.
   * Allows explicit fresh-read path that bypasses stale cache under controlled latency and concurrency budgets.
   */
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Refresh bounded live verification for a proof (authenticated owner)",
    description:
      "Allows proof owners to perform a fresh verification with source selection and latency bounds. " +
      "Supports CACHE (local only), LIVE (on-chain within latency bound), or PREFER_LIVE (attempt live, fallback to cache). " +
      "Result includes provenance metadata indicating whether source was live, cached, or fallback. " +
      "On-chain invalidity (fail-closed) overrides local state. " +
      "Live checks are subject to concurrency limits to prevent thundering herd. " +
      "Endpoint respects global verification rate limits and cannot bypass abuse controls.",
  })
  @ApiParam({ name: "id", description: "Proof ID (uuid)." })
  @ApiBody({
    type: RefreshProofRequestDto,
    description: "Refresh request with source selection and latency bounds.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Verification result with freshness provenance.",
    type: RefreshProofResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Invalid source selection or latency bounds.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "The proof belongs to another user.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Proof not found.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.REQUEST_TIMEOUT,
    description: "Live verification latency bound exceeded.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description: "Rate limit exceeded or concurrency limit reached.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @SkipThrottle({ default: true, strict: true })
  @Throttle({ verification: {} })
  @AuthenticatedRoute({ ownership: "user" })
  @HttpCode(HttpStatus.OK)
  @Post(":id/verify/refresh")
  async refreshProofAuthenticated(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") proofId: string,
    @Body() request: RefreshProofRequestDto,
    @Req() httpRequest: Request,
  ): Promise<RefreshProofResponseDto> {
    // Verify ownership and proof exists
    const proof = await this.prisma.proof.findUnique({
      where: { id: proofId },
      select: { userId: true },
    });

    if (!proof) {
      throw new ForbiddenException("Proof not found");
    }

    if (proof.userId !== user.id) {
      throw new ForbiddenException("Proof belongs to another user");
    }

    // Perform bounded refresh
    return this.boundedRefreshService.refreshProof(
      proofId,
      request,
      {
        ip: httpRequest.ip,
      },
    );
  }

  /**
   * Refresh verification for a shared proof using sharing token.
   * Allows verifiers with a sharing token to perform fresh verification.
   */
  @ApiOperation({
    summary: "Refresh bounded live verification for a shared proof",
    description:
      "Allows verifiers with a valid sharing token to perform a fresh verification with source selection and latency bounds. " +
      "Token is provided as URL query parameter and must be valid and not expired. " +
      "Shares all safety guarantees with the authenticated refresh endpoint: " +
      "Cannot bypass abuse limits, cannot report stale results as live, and deterministic timeout behavior.",
  })
  @ApiParam({ name: "id", description: "Proof ID (uuid) or sharing token (share_*)." })
  @ApiBody({
    type: RefreshProofRequestDto,
    description: "Refresh request with source selection and latency bounds.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Verification result with freshness provenance.",
    type: RefreshProofResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Invalid source selection, latency bounds, or sharing token format.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Proof not found or sharing token invalid/expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.REQUEST_TIMEOUT,
    description: "Live verification latency bound exceeded.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description: "Rate limit exceeded or concurrency limit reached.",
    type: ApiErrorDto,
  })
  @SkipThrottle({ default: true, strict: true })
  @Throttle({ verification: {} })
  @PublicRoute()
  @HttpCode(HttpStatus.OK)
  @Post(":id/verify/refresh")
  async refreshProofShared(
    @Param("id") proofIdOrToken: string,
    @Body() request: RefreshProofRequestDto,
    @Req() httpRequest: Request,
  ): Promise<RefreshProofResponseDto> {
    // Check if this is a sharing token
    let actualProofId = proofIdOrToken;

    if (proofIdOrToken.startsWith("share_")) {
      // Verify sharing token and get the actual proof ID
      const sharingResult = await this.proofSharingService.verifyWithSharingToken(
        proofIdOrToken,
        {
          ipAddress: httpRequest.ip || "0.0.0.0",
          userAgent: httpRequest.headers["user-agent"] || "unknown",
        },
      );

      if (!sharingResult.isValid || !(sharingResult.proof as any)?.id) {
        throw new ForbiddenException("Invalid or expired sharing token");
      }

      actualProofId = (sharingResult.proof as any).id;
    }

    // Perform bounded refresh with sharing context
    return this.boundedRefreshService.refreshProof(
      actualProofId,
      request,
      {
        ip: httpRequest.ip,
      },
    );
  }
}

