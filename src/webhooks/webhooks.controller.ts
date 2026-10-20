import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { PrismaService } from "../database/prisma.service";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { SESSION_AUTH_SCHEME } from "../common/swagger/security-schemes";
import { CreateWebhookDto } from "./dto/create-webhook.dto";
import {
  ListDeadLettersQueryDto,
  RedriveDeadLetterDto,
  RedriveDeadLettersBatchDto,
} from "./dto/dead-letter.dto";
import { PredicatePreviewRequestDto, PredicatePreviewResponseDto } from "./dto/predicate.dto";
import { UpdateWebhookEventsDto } from "./dto/update-webhook-events.dto";
import { UpdateWebhookCircuitConfigDto } from "./dto/webhook-circuit-config.dto";
import { WebhookCircuitStatsDto } from "./dto/webhook-circuit-stats.dto";
import { WebhookTestDeliveryResponseDto } from "./dto/webhook-test-delivery-response.dto";
import { UpdateWebhookUrlDto } from "./dto/update-webhook-url.dto";
import { VerifyWebhookDto } from "./dto/verify-webhook.dto";
import { WebhooksService } from "./webhooks.service";
import { WebhookCircuitBreakerService } from "./webhook-circuit-breaker.service";
import { WebhookDeadLetterService } from "./webhook-dead-letter.service";

/**
 * Resolves the organisation ID from the current authenticated user.
 *
 * The JWT carries userId only.  We query the first ACTIVE organisation
 * the user belongs to.  In a multi-org scenario the org could be passed
 * as a path or query param — kept simple here per scope constraints.
 */
@ApiTags("webhooks")
@AuthenticatedRoute({ ownership: "user" })
@ApiBearerAuth(SESSION_AUTH_SCHEME)
@ApiUnauthorizedResponse({
  description: "Missing, invalid, or expired session token.",
  type: ApiErrorDto,
})
@ApiForbiddenResponse({
  description:
    "The session is valid but belongs to no active organisation, or the "
    + "webhook belongs to another organisation.",
  type: ApiErrorDto,
})
@UseGuards(AuthGuard)
@Controller("webhooks")
export class WebhooksController {
  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly circuitBreakerService: WebhookCircuitBreakerService,
    private readonly prisma: PrismaService,
    private readonly deadLetters: WebhookDeadLetterService,
  ) {}

  // ---------------------------------------------------------------------------
  // Dead letters (operator: DEVELOPER or ADMIN, own organisation only)
  //
  // Declared before the `:id` routes so `dead-letters` is never captured as a
  // webhook id.
  // ---------------------------------------------------------------------------

  @Get("dead-letters")
  @ApiOperation({
    summary: "List dead-lettered deliveries for your organisation (DEVELOPER or ADMIN)",
  })
  async listDeadLetters(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListDeadLettersQueryDto,
  ) {
    this.requirePrivilegedRole(user);
    const orgId = await this.requireOrgId(user);
    return this.deadLetters.list(orgId, query);
  }

  @Post("dead-letters/redrive")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Redrive a bounded batch of dead-lettered deliveries (DEVELOPER or ADMIN)",
    description:
      "Each item is redriven independently and reported with a stable outcome code. " +
      "An operator reason is required and audited.",
  })
  async redriveDeadLetters(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RedriveDeadLettersBatchDto,
  ) {
    this.requirePrivilegedRole(user);
    const orgId = await this.requireOrgId(user);
    return this.deadLetters.redriveBatch(
      orgId,
      body.deliveryIds,
      user.id,
      body.reason,
    );
  }

  @Get("dead-letters/:deliveryId")
  @ApiOperation({
    summary: "Inspect a dead-lettered delivery and its attempt history (DEVELOPER or ADMIN)",
  })
  async getDeadLetter(
    @CurrentUser() user: AuthenticatedUser,
    @Param("deliveryId") deliveryId: string,
  ) {
    this.requirePrivilegedRole(user);
    const orgId = await this.requireOrgId(user);
    return this.deadLetters.get(orgId, deliveryId);
  }

  @Post("dead-letters/:deliveryId/redrive")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Redrive one dead-lettered delivery (DEVELOPER or ADMIN)",
    description:
      "Creates a new delivery carrying the original event id and payload bytes. " +
      "Idempotent: a second redrive of the same dead letter returns the first one.",
  })
  async redriveDeadLetter(
    @CurrentUser() user: AuthenticatedUser,
    @Param("deliveryId") deliveryId: string,
    @Body() body: RedriveDeadLetterDto,
  ) {
    this.requirePrivilegedRole(user);
    const orgId = await this.requireOrgId(user);
    const result = await this.deadLetters.redrive(
      orgId,
      deliveryId,
      user.id,
      body.reason,
    );
    if (result.outcome === "not_found") {
      throw new NotFoundException("Dead-lettered delivery not found");
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Endpoint management
  // ---------------------------------------------------------------------------

  @Post()
  @ApiOperation({
    summary: "Create a webhook endpoint",
    description:
      "Registers an HTTPS endpoint for the caller's organisation and returns its " +
      "signing secret. The secret is shown exactly once: store it before leaving " +
      "the response, and rotate the endpoint if it is lost. The endpoint starts " +
      "PENDING: a verification challenge is sent to the destination immediately, " +
      "and no real event deliveries go out until it is acknowledged via `verify`.",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description:
      "Endpoint registered. `signingSecret` is returned once and never again.",
    schema: {
      example: {
        id: "ckv8v6h2b0002qzrm7t4k9xza",
        url: "https://example.com/webhooks/earnproof",
        events: ["proof.created", "proof.verified"],
        status: "PENDING",
        createdAt: "2026-08-24T12:00:00.000Z",
        signingSecret:
          "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "The URL is not HTTPS, or the event list is empty or names an unknown " +
      "event type.",
    type: ApiErrorDto,
  })
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWebhookDto) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.create(orgId, dto);
  }

  @Get()
  @ApiOperation({
    summary: "List webhook endpoints for your organisation",
    description:
      "Returns a cursor-paginated, deterministically ordered page of endpoints " +
      "registered by the caller's organisation. Signing secrets are never included. " +
      "Pass `pageInfo.nextCursor` from a response as the next request's `cursor`.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Endpoints owned by the caller's organisation, plus pagination metadata.",
    schema: {
      example: {
        data: [
          {
            id: "ckv8v6h2b0002qzrm7t4k9xza",
            url: "https://example.com/webhooks/earnproof",
            events: ["proof.created", "proof.verified"],
            status: "ACTIVE",
            createdAt: "2026-08-24T12:00:00.000Z",
            updatedAt: "2026-08-24T12:00:00.000Z",
          },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      },
    },
  })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListWebhooksDto,
  ) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.listForOrg(orgId, query);
  }

  @Get(":id")
  @ApiOperation({
    summary: "Get a webhook endpoint",
    description: "Returns one endpoint owned by the caller's organisation.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "The endpoint.",
    schema: {
      example: {
        id: "ckv8v6h2b0002qzrm7t4k9xza",
        url: "https://example.com/webhooks/earnproof",
        events: ["proof.created", "proof.verified"],
        status: "ACTIVE",
        createdAt: "2026-08-24T12:00:00.000Z",
        updatedAt: "2026-08-24T12:00:00.000Z",
      },
    },
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async get(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.getForOrg(orgId, id);
  }

  @Patch(":id/events")
  @ApiOperation({
    summary: "Update event subscriptions",
    description:
      "Replaces the endpoint's subscription set. The list is a replacement, not " +
      "a delta: events omitted here stop being delivered.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Subscriptions replaced.",
    schema: {
      example: {
        id: "ckv8v6h2b0002qzrm7t4k9xza",
        url: "https://example.com/webhooks/earnproof",
        events: ["proof.revoked"],
        status: "ACTIVE",
        updatedAt: "2026-08-24T13:05:00.000Z",
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "The event list is empty or names an unknown event type.",
    type: ApiErrorDto,
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async updateEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: UpdateWebhookEventsDto,
  ) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.updateEvents(orgId, id, dto);
  }

  // ---------------------------------------------------------------------------
  // Destination verification
  // ---------------------------------------------------------------------------

  @Patch(":id/url")
  @ApiOperation({
    summary: "Change the destination URL",
    description:
      "Updates the endpoint's destination. The endpoint reverts to PENDING and " +
      "a fresh verification challenge is sent to the new URL — verification of " +
      "the previous destination no longer authorises deliveries.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Destination updated; endpoint is PENDING re-verification.",
    schema: {
      example: {
        id: "ckv8v6h2b0002qzrm7t4k9xza",
        url: "https://example.com/webhooks/earnproof-v2",
        events: ["proof.created", "proof.verified"],
        status: "PENDING",
        updatedAt: "2026-08-24T13:05:00.000Z",
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "The URL is not a safe HTTPS destination.",
    type: ApiErrorDto,
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async updateUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: UpdateWebhookUrlDto,
  ) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.updateUrl(orgId, id, dto);
  }

  @Post(":id/resend-verification")
  @ApiOperation({
    summary: "Re-send the destination verification challenge",
    description:
      "Issues and sends a new challenge for a PENDING endpoint, invalidating " +
      "any still-outstanding previous challenge. Use this if the original " +
      "challenge expired or was never received.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "A new challenge was issued and sent.",
    schema: {
      example: {
        webhookId: "ckv8v6h2b0002qzrm7t4k9xza",
        status: "PENDING",
        expiresAt: "2026-08-24T13:10:00.000Z",
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "The endpoint is not awaiting verification.",
    type: ApiErrorDto,
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async resendVerification(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.resendVerification(orgId, id);
  }

  @Post(":id/verify")
  @ApiOperation({
    summary: "Acknowledge the destination verification challenge",
    description:
      "Submits the token delivered in the `webhook.verification` challenge " +
      "payload. On success the endpoint becomes ACTIVE and real event " +
      "deliveries begin. The token is single-use: a second submission (replay) " +
      "is rejected the same way as an unknown or expired one.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Verified; the endpoint is now ACTIVE.",
    schema: {
      example: {
        id: "ckv8v6h2b0002qzrm7t4k9xza",
        status: "ACTIVE",
        updatedAt: "2026-08-24T13:12:00.000Z",
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "The token is unknown, expired, or already used.",
    type: ApiErrorDto,
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async verify(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: VerifyWebhookDto,
  ) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.verify(orgId, id, dto);
  }

  @Post(":id/rotate-secret")
  @ApiOperation({
    summary: "Rotate the signing secret (returns new secret once)",
    description:
      "Issues a new signing secret and invalidates the old one immediately. " +
      "Deliveries already in flight fail their current attempt and are retried " +
      "with the new secret, so rotate before the old secret is discarded.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "New secret issued. Returned once and never again.",
    schema: {
      example: {
        webhookId: "ckv8v6h2b0002qzrm7t4k9xza",
        signingSecret:
          "3b1f6c0d9e5a4728b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d",
        rotatedAt: "2026-08-24T13:10:00.000Z",
        note:
          "Any in-flight deliveries signed with the old secret will fail their current attempt. They will be retried with the new secret.",
      },
    },
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async rotateSecret(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.rotateSecret(orgId, id);
  }

  @Patch(":id/disable")
  @ApiOperation({
    summary: "Disable a webhook endpoint",
    description:
      "Stops delivery without deleting the endpoint or its history. Reversible " +
      "with the enable route.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Endpoint disabled.",
    schema: {
      example: {
        id: "ckv8v6h2b0002qzrm7t4k9xza",
        status: "DISABLED",
        updatedAt: "2026-08-24T13:20:00.000Z",
      },
    },
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async disable(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.disable(orgId, id);
  }

  @Patch(":id/enable")
  @ApiOperation({
    summary: "Re-enable a webhook endpoint",
    description: "Resumes delivery for a previously disabled endpoint.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Endpoint re-enabled.",
    schema: {
      example: {
        id: "ckv8v6h2b0002qzrm7t4k9xza",
        status: "ACTIVE",
        updatedAt: "2026-08-24T13:25:00.000Z",
      },
    },
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async enable(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.enable(orgId, id);
  }

  @Delete(":id")
  @ApiOperation({
    summary: "Delete a webhook endpoint",
    description:
      "Removes the endpoint. Disable it instead when the delivery history still " +
      "matters.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Endpoint deleted.",
    schema: {
      example: { deleted: true, webhookId: "ckv8v6h2b0002qzrm7t4k9xza" },
    },
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async delete(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.delete(orgId, id);
  }

  // ---------------------------------------------------------------------------
  // Delivery observability
  // ---------------------------------------------------------------------------

  @Get(":id/deliveries")
  @ApiOperation({
    summary: "List delivery records for a webhook endpoint",
    description:
      "The 100 most recent delivery attempts, newest first. Request bodies and " +
      "signing headers are never stored, so nothing here can leak a secret. " +
      "Response bodies are stored as a safe JSON structure with truncation and redaction: " +
      "truncatedBody (first 1024 bytes), contentHash (SHA-256), wasTruncated (boolean), " +
      "hadEncodingIssue (boolean). Sensitive patterns (api_key, password, token, etc.) " +
      "are redacted before storage.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Recent delivery attempts with safe response bodies.",
    schema: {
      example: [
        {
          id: "ckv8v6h2b0003qzrm4d8n2plq",
          eventType: "proof.created",
          eventId: "evt_01hxk8s3n7q9v2m4c6d8e0f2g4",
          attempt: 1,
          status: "SUCCESS",
          statusCode: 200,
          responseBody: {
            truncatedBody: '{"ok":true}',
            contentHash:
              "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
            wasTruncated: false,
            hadEncodingIssue: false,
          },
          durationMs: 142,
          failureReason: null,
          replayOf: null,
          replayedBy: null,
          deliveredAt: "2026-08-24T12:30:01.000Z",
          nextRetryAt: null,
          createdAt: "2026-08-24T12:30:00.000Z",
        },
      ],
    },
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async listDeliveries(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Query() query: ListWebhookDeliveriesDto,
  ) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.listDeliveries(orgId, id, query);
  }

  // ---------------------------------------------------------------------------
  // Circuit breaker management
  // ---------------------------------------------------------------------------

  @Get(":id/circuit")
  @ApiOperation({
    summary: "Get webhook circuit breaker statistics",
    description: "Returns current circuit state and failure statistics for monitoring.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Circuit breaker statistics.",
    type: WebhookCircuitStatsDto,
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async getCircuitStats(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    // Verify webhook ownership
    await this.webhooksService.getForOrg(orgId, id);
    
    const stats = await this.circuitBreakerService.getCircuitStats(id);
    if (!stats) {
      // Initialize circuit if it doesn't exist
      await this.circuitBreakerService.initializeCircuit(id);
      return await this.circuitBreakerService.getCircuitStats(id);
    }
    return stats;
  }

  @Patch(":id/circuit")
  @ApiOperation({
    summary: "Update webhook circuit breaker configuration",
    description: "Configure failure threshold and recovery window for circuit breaker.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Circuit breaker configuration updated.",
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async updateCircuitConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() config: UpdateWebhookCircuitConfigDto,
  ) {
    const orgId = await this.requireOrgId(user);
    // Verify webhook ownership
    await this.webhooksService.getForOrg(orgId, id);
    
    await this.circuitBreakerService.updateConfig(id, config);
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Manual replay
  // ---------------------------------------------------------------------------

  @Post("deliveries/:deliveryId/replay")
  @ApiOperation({
    summary: "Manually replay a delivery (DEVELOPER or ADMIN only)",
    description:
      "Re-sends a stored delivery to its endpoint as a new attempt, keeping the " +
      "original event identifier so a receiver that de-duplicates on it can " +
      "recognise the replay. The replay is recorded against the acting user.",
  })
  @ApiParam({
    name: "deliveryId",
    description: "Delivery record to replay.",
    example: "ckv8v6h2b0003qzrm4d8n2plq",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Replay queued.",
    schema: {
      example: {
        replayDeliveryId: "ckv8v6h2b0004qzrm1s6y3wkc",
        originalDeliveryId: "ckv8v6h2b0003qzrm4d8n2plq",
        eventId: "evt_01hxk8s3n7q9v2m4c6d8e0f2g4",
        eventType: "proof.created",
        replayedBy: "ckv8v6h2b0000qzrmn831i7rn",
        replayedAt: "2026-08-24T14:00:00.000Z",
      },
    },
  })
  @ApiForbiddenResponse({
    description:
      "The caller is not a DEVELOPER or ADMIN, or the delivery belongs to " +
      "another organisation.",
    type: ApiErrorDto,
  })
  @ApiNotFoundResponse({
    description: "No such delivery record.",
    type: ApiErrorDto,
  })
  async replayDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Param("deliveryId") deliveryId: string,
  ) {
    this.requirePrivilegedRole(user);
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.replayDelivery(orgId, deliveryId, user.id);
  }

  // ---------------------------------------------------------------------------
  // Synthetic test delivery
  // ---------------------------------------------------------------------------

  @Post(":id/test")
  @HttpCode(HttpStatus.OK)
  // Same limiter as other expensive, outbound-triggering operations: each call
  // makes a synchronous HTTP request to a caller-chosen destination.
  @SkipThrottle({ default: true, verification: true })
  @Throttle({ strict: {} })
  @ApiOperation({
    summary: "Send a synthetic test event (DEVELOPER or ADMIN only)",
    description:
      "Signs a versioned synthetic `webhook.test` event with the endpoint's " +
      "current secret through the production signing path and POSTs it once, " +
      "under the same destination policy, no-redirect rule, and timeout as a " +
      "real delivery. The event is marked `synthetic: true`, its id is prefixed " +
      "`test_`, and it is never stored as a delivery or retried. Returns the " +
      "delivery timing, a status class, and the receiver response, redacted and " +
      "bounded exactly as stored delivery responses are. A non-2xx receiver " +
      "answer is reported in the body, not as an error status.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Test delivery attempted; see `statusClass` for the outcome.",
    type: WebhookTestDeliveryResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "The endpoint is disabled.",
    type: ApiErrorDto,
  })
  @ApiForbiddenResponse({
    description:
      "The caller is not a DEVELOPER or ADMIN, or the endpoint belongs to " +
      "another organisation.",
    type: ApiErrorDto,
  })
  @ApiNotFoundResponse({
    description: "No such endpoint.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description: "Rate limit exceeded (strict limiter).",
    type: ApiErrorDto,
  })
  async sendTestDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<WebhookTestDeliveryResponseDto> {
    this.requirePrivilegedRole(user, "send webhook test deliveries");
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.sendTestDelivery(orgId, id);
  }

  /**
   * Preview a predicate against a sample event.
   *
   * Test whether a bounded predicate matches a given event, without creating
   * a delivery or modifying any state. Returns whether the predicate matched,
   * the reason if it didn't, and the number of nodes visited during evaluation.
   *
   * Useful for validation during predicate design: ensures the predicate
   * behaves as expected before attaching it to a subscription.
   *
   * POST /api/v1/webhooks/preview-predicate
   */
  @Post("preview-predicate")
  @UseGuards(AuthGuard)
  @ApiBearerToken()
  @Throttle({ default: { limit: 100, ttl: 60_000 } })
  @ApiOperation({
    operationId: "previewPredicate",
    summary: "Preview a bounded webhook predicate",
    description:
      "Test a predicate against a sample event to see if it matches. " +
      "No deliveries are created. Useful for validation during predicate design. " +
      "Same authorization and rate limits as other webhook endpoints.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Predicate evaluation completed successfully.",
    type: () => ({
      match: { type: "boolean" },
      reason: { type: "string", nullable: true },
      visitedNodes: { type: "integer" },
    }),
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "Invalid predicate or sample event (validation error, unknown version, malformed structure, etc.).",
    type: ApiErrorDto,
  })
  @ApiForbiddenResponse({
    description:
      "The caller is not authenticated or has no active organisation.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description: "Rate limit exceeded.",
    type: ApiErrorDto,
  })
  async previewPredicate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: {
      predicate: any;
      event: { resource: string; outcome: string; schemaVersion: string };
    },
  ): Promise<{ match: boolean; reason?: string; visitedNodes: number }> {
    const orgId = await this.requireOrgId(user);
    // Authorization check: ensure user's org context (already done by requireOrgId)
    // No webhook-specific check needed; this is a read-only preview endpoint
    return this.webhooksService.previewPredicate(orgId, dto.predicate, dto.event);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async requireOrgId(user: AuthenticatedUser): Promise<string> {
    // Find an active organization the user belongs to
    const userWithOrgs = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: {
        organizations: {
          where: { status: "ACTIVE", archivedAt: null },
          select: { id: true },
          take: 1,
        },
      },
    });

    if (!userWithOrgs?.organizations?.[0]) {
      throw new ForbiddenException("No active organisation found for this user");
    }

    return userWithOrgs.organizations[0].id;
  }

  private requirePrivilegedRole(
    user: AuthenticatedUser,
    action = "replay webhook deliveries",
  ): void {
    if (user.role !== "DEVELOPER" && user.role !== "ADMIN") {
      throw new ForbiddenException(
        "Only DEVELOPER or ADMIN users may inspect, replay, or redrive webhook deliveries",
        `Only DEVELOPER or ADMIN users may ${action}`,
      );
    }
  }
}
