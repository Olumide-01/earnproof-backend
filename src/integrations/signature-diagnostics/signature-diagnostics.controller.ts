import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { ApiKeyScope } from "@prisma/client";
import { Request } from "express";
import { ApiKeyContext } from "../../api-keys/api-key.types";
import { AuthenticatedRoute } from "../../common/decorators/authorization-policy.decorator";
import { CurrentApiKey } from "../../common/decorators/current-api-key.decorator";
import { RequireScopes } from "../../common/decorators/require-scopes.decorator";
import { ApiErrorDto } from "../../common/dto/api-error.dto";
import { ApiKeyGuard } from "../../common/guards/api-key.guard";
import { ScopesGuard } from "../../common/guards/scopes.guard";
import { API_KEY_AUTH_SCHEME, ORGANIZATION_ID_HEADER } from "../../common/swagger/security-schemes";
import {
  SignatureDiagnosticsRequestDto,
  SignatureDiagnosticsResponseDto,
} from "./dto/signature-diagnostics.dto";
import { SignatureDiagnosticsService } from "./signature-diagnostics.service";

/** Route-level limit on top of the global limiter; diagnostics are for occasional synthetic tests. */
export const SIGNATURE_DIAGNOSTICS_LIMIT_PER_MINUTE = 10;

@ApiTags("integrations")
@AuthenticatedRoute()
@ApiBearerAuth(API_KEY_AUTH_SCHEME)
@ApiHeader(ORGANIZATION_ID_HEADER)
@Controller("integrations/signature-diagnostics")
export class SignatureDiagnosticsController {
  constructor(private readonly diagnostics: SignatureDiagnosticsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard, ScopesGuard)
  @RequireScopes(ApiKeyScope.ORG_READ)
  @Throttle({ default: { ttl: 60_000, limit: SIGNATURE_DIAGNOSTICS_LIMIT_PER_MINUTE } })
  @ApiOperation({
    summary: "Diagnose a synthetic signed request",
    description:
      "Evaluates the signing headers of a synthetic request, described in the body, " +
      "with the authenticating API key's signing key. Reports the canonicalization " +
      "version, header and timestamp-window status, per-component mismatches against " +
      "an optional declared canonical string, nonce status, and a stable failure " +
      "category in RequestSigningGuard order.\n\n" +
      "Never returns the expected signature, the derived key, the server's canonical " +
      "string, or the nonce. Every well-formed, in-window nonce is consumed, so a " +
      "diagnosed request cannot be replayed against a live endpoint. Limited to " +
      `${SIGNATURE_DIAGNOSTICS_LIMIT_PER_MINUTE} requests per minute; requires ORG_READ.`,
  })
  @ApiOkResponse({ type: SignatureDiagnosticsResponseDto })
  @ApiBadRequestResponse({ description: "Invalid body, or both body and bodySha256.", type: ApiErrorDto })
  @ApiUnauthorizedResponse({ description: "Missing or invalid API key.", type: ApiErrorDto })
  @ApiForbiddenResponse({ description: "The key lacks the ORG_READ scope.", type: ApiErrorDto })
  diagnose(
    @CurrentApiKey() context: ApiKeyContext,
    @Req() request: Request,
    @Body() dto: SignatureDiagnosticsRequestDto,
  ) {
    // ApiKeyGuard has already validated this bearer secret.
    const rawSecret = (request.headers.authorization ?? "").slice("Bearer ".length);
    return this.diagnostics.diagnose(context, rawSecret, dto);
  }
}
