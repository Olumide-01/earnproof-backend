import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  Optional,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiParam,
} from "@nestjs/swagger";
import { Request } from "express";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import {
  AuthenticatedRoute,
  PublicRoute,
} from "../common/decorators/authorization-policy.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { AuthGuard } from "../common/guards/auth.guard";
import { AuthenticatedSession } from "./auth.types";
import { AuthService } from "./auth.service";
import { ChallengeResponseDto } from "./dto/challenge-response.dto";
import { CreateChallengeDto } from "./dto/create-challenge.dto";
import { LogoutResponseDto } from "./dto/logout-response.dto";
import { RotateResponseDto } from "./dto/rotate-response.dto";
import { SessionResponseDto } from "./dto/session-response.dto";
import { VerifyChallengeDto } from "./dto/verify-challenge.dto";
import { VerifyResponseDto } from "./dto/verify-response.dto";
import { SessionService } from "./session.service";
import {
  SessionInventoryItemDto,
  SessionInventoryResponseDto,
} from "./dto/session-inventory.dto";
import { RevokeSingleSessionResponseDto, RevokeAllOtherSessionsResponseDto } from "./dto/revoke-session.dto";
import { RecentAuthService } from "./recent-auth.service";
import { RenameSessionDto } from "./dto/rename-session.dto";
import { IssueAssertionDto } from "./dto/issue-assertion.dto";
import { AssertionResponseDto } from "./dto/assertion-response.dto";
import { SessionRiskService } from "./session-risk.service";
import { ListReauthHistoryDto, ListRiskEventsDto } from "./dto/session-risk.dto";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
    private readonly recentAuthService: RecentAuthService,
    @Optional()
    private readonly sessionRiskService?: SessionRiskService,
  ) {}

  @ApiOperation({
    summary: "Request a wallet challenge",
    description:
      "Returns a message that the client must sign with the Stellar wallet identified by " +
      "`walletAddress`. The challenge expires in 5 minutes and can be used only once.",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Challenge created successfully.",
    type: ChallengeResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: "Request body failed validation.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "The wallet address is not a valid Stellar Ed25519 public key.",
    type: ApiErrorDto,
  })
  @Post("challenge")
  @PublicRoute()
  createChallenge(@Body() body: CreateChallengeDto) {
    return this.authService.createChallenge(body.walletAddress);
  }

  @ApiOperation({
    summary: "Verify a wallet signature and obtain a session token",
    description:
      "Verifies the Ed25519 signature over the challenge message and, if valid, returns a " +
      "Bearer token scoped to the authenticated wallet. The challenge is consumed and cannot " +
      "be replayed.",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Signature verified. Session token issued.",
    type: VerifyResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: "Request body failed validation.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "The wallet address is not a valid Stellar Ed25519 public key.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Challenge expired/used, or wallet signature is invalid.",
    type: ApiErrorDto,
  })
  @Post("verify")
  @PublicRoute()
  verifyChallenge(
    @Body() body: VerifyChallengeDto,
    @Headers() headers?: Record<string, string | string[] | undefined>,
  ) {
    return this.authService.verifyChallenge(body, headers);
  }

  @ApiOperation({
    summary: "Return the current session user",
    description: "Returns the full profile of the authenticated user from the database.",
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Current session details.",
    type: SessionResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Get("session")
  @AuthenticatedRoute({ ownership: "user" })
  getSession(@CurrentUser() session: AuthenticatedSession) {
    return this.authService.getSession(session.id);
  }

  @ApiOperation({ summary: "List the authenticated user's sessions" })
  @ApiBearerAuth()
  @ApiResponse({ status: HttpStatus.OK, type: SessionInventoryItemDto, isArray: true })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ApiErrorDto })
  @UseGuards(AuthGuard)
  @Get("sessions")
  async listSessions(@CurrentUser() session: AuthenticatedSession) {
    const sessions = await this.sessionService.listForUser(session.id);
    return sessions.map((item) => ({
      ...item,
      deviceLabel: item.deviceLabel ?? "Unknown device",
      current: item.id === session.sessionId,
    }));
  }

  @ApiOperation({ summary: "Rename one of the authenticated user's sessions" })
  @ApiBearerAuth()
  @ApiResponse({ status: HttpStatus.NO_CONTENT, description: "Session label updated." })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ApiErrorDto })
  @UseGuards(AuthGuard)
  @Patch("sessions/:sessionId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async renameSession(
    @CurrentUser() session: AuthenticatedSession,
    @Param("sessionId") sessionId: string,
    @Body() body: RenameSessionDto,
  ) {
    await this.sessionService.renameForUser(session.id, sessionId, body.label);
  }

  @ApiOperation({
    summary: "Log out and revoke the active session",
    description:
      "Revokes the authenticated session server-side so its bearer token cannot be reused.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Session revoked successfully.",
    type: LogoutResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, expired, or revoked.",
    type: ApiErrorDto,
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post("logout")
  @AuthenticatedRoute({ ownership: "user" })
  async logout(@CurrentUser() session: AuthenticatedSession) {
    await this.authService.logout(session.sessionId);
    return { status: "ok" };
  }

  @ApiOperation({
    summary: "Rotate the active session",
    description:
      "Atomically revokes the current session and returns a fresh opaque bearer token.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Session rotated successfully.",
    type: RotateResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "The active session is unavailable, expired, or already revoked.",
    type: ApiErrorDto,
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post("rotate")
  @AuthenticatedRoute({ ownership: "user" })
  async rotate(
    @CurrentUser() session: AuthenticatedSession,
    @Headers() headers?: Record<string, string | string[] | undefined>,
  ) {
    const { token, sessionId, expiresAt } = await this.sessionService.rotate(
      session.sessionId,
      session,
      undefined,
      headers,
    );

    return { token, tokenType: "Bearer", sessionId, expiresAt };
  }

  @ApiOperation({
    summary: "List active sessions for the current user",
    description:
      "Returns a list of all active sessions with non-sensitive metadata. " +
      "Token hashes and full device fingerprints are never returned.",
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Active sessions retrieved successfully.",
    type: SessionInventoryResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, expired, or revoked.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Get("sessions")
  async getSessions(@CurrentUser() session: AuthenticatedSession) {
    const sessions = await this.sessionService.getSessions(session.id);
    
    const sessionsData = sessions.map((s) => ({
      id: s.id,
      deviceFingerprint: s.deviceFingerprint,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      lastUsedAt: s.lastUsedAt?.toISOString() || null,
      isCurrent: s.id === session.sessionId,
    }));

    return {
      sessions: sessionsData,
      total: sessionsData.length,
    };
  }

  @ApiOperation({
    summary: "Revoke a specific other session",
    description:
      "Revokes a single session by its ID. " +
      "The current session cannot be revoked via this endpoint — use POST /auth/logout instead. " +
      "Remote revocation takes effect on the next authenticated request.",
  })
  @ApiParam({
    name: "sessionId",
    description: "The session ID to revoke (not the token itself).",
    example: "clx1abc2def3ghi4",
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Session revoked successfully.",
    type: RevokeSingleSessionResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description:
      "Bearer token is invalid, or the session does not belong to the authenticated user, " +
      "or is already revoked.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "The specified session ID does not exist.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post("sessions/:sessionId/revoke")
  async revokeSingleSession(
    @Param("sessionId") sessionId: string,
    @CurrentUser() session: AuthenticatedSession,
  ) {
    if (sessionId === session.sessionId) {
      throw new ForbiddenException(
        "Cannot revoke the current session via this endpoint. Use POST /auth/logout instead.",
      );
    }

    try {
      const revokedSessionId = await this.sessionService.revokeOtherSession(
        sessionId,
        session.id,
      );

      return {
        status: "ok",
        revokedSessionId,
      };
    } catch (error) {
      if (error instanceof Error && error.message === "Session not found") {
        throw new NotFoundException("Session not found");
      }
      throw error;
    }
  }

  @ApiOperation({
    summary: "Revoke all other sessions",
    description:
      "Revokes all active sessions except the current one (the one making this request). " +
      "Useful for responding to suspected device loss or compromise. " +
      "Remote revocation takes effect on the next authenticated request.",
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.OK,
    description: "All other sessions revoked successfully.",
    type: RevokeAllOtherSessionsResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is invalid or expired.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post("sessions/revoke-all-other")
  async revokeAllOtherSessions(@CurrentUser() session: AuthenticatedSession) {
    const revokedCount = await this.sessionService.revokeAllOtherSessions(
      session.id,
      session.sessionId,
    );

    return {
      status: "ok",
      revokedCount,
    };
  }

  @ApiOperation({
    summary: "Issue a recent-auth assertion",
    description:
      "Issues a short-lived (5 minute), single-use assertion token that proves the " +
      "caller completed wallet re-verification for the specified destructive action. " +
      "Present the returned token in the `X-Recent-Auth` header when calling the " +
      "destructive endpoint. Requires an active session (AuthGuard).",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Assertion issued.",
    type: AssertionResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post("assert")
  async issueAssertion(
    @CurrentUser() session: AuthenticatedSession,
    @Body() body: IssueAssertionDto,
    @Req() req: Request,
  ): Promise<AssertionResponseDto> {
    const origin = String(req.headers["origin"] ?? "null");
    const resourceId = body.resourceId ?? "*";
    const { token, expiresAt } = await this.recentAuthService.issue(
      session.id,
      body.action,
      resourceId,
      origin,
    );
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      action: body.action,
      resourceId,
    };
  }

  @ApiOperation({
    summary: "List session risk events",
    description: "Returns paginated session risk events recorded for the authenticated user.",
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get("sessions/risk-events")
  async getRiskEvents(
    @CurrentUser() session: AuthenticatedSession,
    @Query() query: ListRiskEventsDto,
  ) {
    if (!this.sessionRiskService) {
      throw new NotFoundException("Session risk service not configured");
    }
    return this.sessionRiskService.listRiskEvents(session.id, query);
  }

  @ApiOperation({
    summary: "Revoke sessions related to a risk event",
    description: "Revokes sessions associated with the flagged risk event (idempotent).",
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post("sessions/risk-events/:id/revoke-sessions")
  async revokeRiskEventSessions(
    @CurrentUser() session: AuthenticatedSession,
    @Param("id") riskEventId: string,
  ) {
    if (!this.sessionRiskService) {
      throw new NotFoundException("Session risk service not configured");
    }
    return this.sessionRiskService.revokeRelatedSessions(session.id, riskEventId);
  }

  @ApiOperation({
    summary: "List reauthentication history",
    description: "Returns privacy-safe history of recent-auth assertions without sensitive tokens.",
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get("reauthentication-history")
  async getReauthenticationHistory(
    @CurrentUser() session: AuthenticatedSession,
    @Query() query: ListReauthHistoryDto,
  ) {
    if (!this.sessionRiskService) {
      throw new NotFoundException("Session risk service not configured");
    }
    return this.sessionRiskService.getReauthenticationHistory(session.id, query);
  }
}
