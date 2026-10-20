import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { AuthenticatedUser } from "../../auth/auth.types";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { ApiErrorDto } from "../../common/dto/api-error.dto";
import { AuthGuard } from "../../common/guards/auth.guard";
import {
  CreateProofShareTokenDto,
  ResolveProofShareTokenDto,
} from "./dto/share-token.dto";
import { ProofShareTokensService } from "./proof-share-tokens.service";

/** Owner-side management of share tokens for one proof. */
@ApiTags("proofs")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller("proofs/:id/share-tokens")
export class ProofShareTokensController {
  constructor(private readonly shareTokens: ProofShareTokensService) {}

  @Post()
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Issue a time-limited share token for an owned proof",
    description:
      "Returns the raw token exactly once. Issuing a token supersedes any live token for the same proof and scope. " +
      "Scope, expiry, and use limit cannot be changed after issuance.",
  })
  @ApiParam({ name: "id", description: "Proof ID." })
  @ApiResponse({ status: HttpStatus.CREATED, description: "Share token issued." })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Proof not found or not owned by the caller.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: "Proof is revoked, expired, or otherwise not shareable.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "A concurrent issuance for the same proof and scope won.",
    type: ApiErrorDto,
  })
  issue(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") proofId: string,
    @Body() body: CreateProofShareTokenDto,
  ) {
    return this.shareTokens.issue(user, proofId, body);
  }

  @Get()
  @ApiOperation({
    summary: "List active share tokens for an owned proof",
    description: "Metadata only. Raw tokens and hashes are never returned.",
  })
  @ApiParam({ name: "id", description: "Proof ID." })
  @ApiResponse({ status: HttpStatus.OK, description: "Active share tokens." })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Proof not found or not owned by the caller.",
    type: ApiErrorDto,
  })
  list(@CurrentUser() user: AuthenticatedUser, @Param("id") proofId: string) {
    return this.shareTokens.listActive(user, proofId);
  }

  @Delete(":tokenId")
  @ApiOperation({
    summary: "Revoke a share token",
    description: "Takes effect immediately and cannot be undone. Idempotent.",
  })
  @ApiParam({ name: "id", description: "Proof ID." })
  @ApiParam({ name: "tokenId", description: "Share token ID." })
  @ApiResponse({ status: HttpStatus.OK, description: "Share token revoked." })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Share token not found for this proof and owner.",
    type: ApiErrorDto,
  })
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") proofId: string,
    @Param("tokenId") tokenId: string,
  ) {
    return this.shareTokens.revoke(user, proofId, tokenId);
  }
}

/**
 * Public share-link resolution.
 *
 * Deliberately has no AuthGuard and reads no session: holding the token is the
 * authorization, and a share flow must never expose or depend on the owner's
 * authenticated session.
 */
@ApiTags("proofs")
@Controller("proof-shares")
export class ProofSharesController {
  constructor(private readonly shareTokens: ProofShareTokensService) {}

  @Post("resolve")
  @HttpCode(HttpStatus.OK)
  @Header("Cache-Control", "no-store")
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({
    summary: "Resolve a proof share token (public)",
    description:
      "Returns the verification result scoped to the token. Every unusable token — unknown, revoked, expired, " +
      "superseded, or exhausted — produces the same 404.",
  })
  @ApiResponse({ status: HttpStatus.OK, description: "Scoped verification result." })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Share link is invalid or has expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description: "Rate limit exceeded.",
    type: ApiErrorDto,
  })
  resolve(@Body() body: ResolveProofShareTokenDto) {
    return this.shareTokens.resolve(body.token);
  }
}
