import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { AuthenticatedUser } from "../../auth/auth.types";
import { AuthenticatedRoute } from "../../common/decorators/authorization-policy.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { ApiErrorDto } from "../../common/dto/api-error.dto";
import { AuthGuard } from "../../common/guards/auth.guard";
import { SESSION_AUTH_SCHEME } from "../../common/swagger/security-schemes";
import { WebhookTlsPostureService } from "./webhook-tls-posture.service";

/**
 * Webhook endpoint TLS posture (#315). Organization membership is checked by
 * the service because it depends on the organization in the path.
 */
@ApiBearerAuth(SESSION_AUTH_SCHEME)
@ApiTags("webhooks")
@AuthenticatedRoute()
@Controller("organizations/:organizationId/webhooks")
@UseGuards(AuthGuard)
@ApiUnauthorizedResponse({ description: "Missing or invalid session.", type: ApiErrorDto })
@ApiForbiddenResponse({ description: "Not an organization member with the required role.", type: ApiErrorDto })
export class WebhookTlsPostureController {
  constructor(private readonly posture: WebhookTlsPostureService) {}

  @Get("tls-posture")
  @ApiOperation({
    summary: "List TLS posture for an organization's webhooks",
    description:
      "Latest probe outcome per webhook, with `stale` set when no probe is newer " +
      "than 48 hours. Bounded to 100 webhooks; `truncated` reports more.",
  })
  @ApiOkResponse({ description: "Posture per webhook." })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
  ) {
    return this.posture.listPosture(user, organizationId);
  }

  @Get(":webhookId/tls-posture")
  @ApiOperation({
    summary: "Get TLS posture and probe history for one webhook",
    description:
      "Outcome categories and public certificate facts only. Resolved addresses " +
      "and raw handshake errors are never returned. History is the last 20 probes.",
  })
  @ApiOkResponse({ description: "Posture and bounded history." })
  @ApiNotFoundResponse({ description: "Webhook not found in this organization.", type: ApiErrorDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Param("webhookId") webhookId: string,
  ) {
    return this.posture.getPosture(user, organizationId, webhookId);
  }

  @Post(":webhookId/tls-posture/probe")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Probe a webhook endpoint's TLS posture now",
    description:
      "Runs one TLS handshake through the outbound destination guard. No HTTP " +
      "request is sent and no redirect is followed. Requires the organization " +
      "ADMIN role; at most one probe per webhook per 60 seconds.",
  })
  @ApiOkResponse({ description: "The recorded probe." })
  @ApiNotFoundResponse({ description: "Webhook not found in this organization.", type: ApiErrorDto })
  @ApiConflictResponse({ description: "Webhook is not ACTIVE.", type: ApiErrorDto })
  @ApiTooManyRequestsResponse({ description: "Probed within the last 60 seconds.", type: ApiErrorDto })
  probe(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Param("webhookId") webhookId: string,
  ) {
    return this.posture.probeNow(user, organizationId, webhookId);
  }
}
