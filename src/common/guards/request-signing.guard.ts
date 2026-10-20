import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import {
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  SignatureFailureReason,
  hasSigningHeaders,
  verifySignature,
} from "../crypto/request-signing";
import { RequestNonceService } from "../../api-keys/request-nonce.service";
import { ApiKeyContext } from "../../api-keys/api-key.types";

/**
 * Metadata key for the @RequireSigning() decorator.
 * When present on a route, the guard rejects bearer-only requests.
 */
export const REQUIRE_SIGNING_KEY = "requireRequestSigning";

/**
 * Decorator that marks a route as requiring a signed request.
 * Must be used together with ApiKeyGuard (which validates the bearer token first).
 *
 * @example
 * @Post("minimum-income")
 * @UseGuards(ApiKeyGuard, ScopesGuard, RequestSigningGuard)
 * @RequireSigning()
 * createProof() { ... }
 */
export const RequireSigning = () => SetMetadata(REQUIRE_SIGNING_KEY, true);

/**
 * Request Signing Guard
 *
 * Runs AFTER ApiKeyGuard has verified the bearer token and attached ApiKeyContext.
 * Checks the three signing headers (X-EarnProof-Signature, X-EarnProof-Timestamp,
 * X-EarnProof-Nonce) and verifies the HMAC-SHA256 signature over the canonical
 * request string.
 *
 * Migration policy (bearer-only compatibility):
 *   If none of the three signing headers are present AND the route is not
 *   decorated with @RequireSigning(), the request is allowed through as
 *   bearer-only. This lets existing integrations work without modification.
 *
 * Fail-closed on errors:
 *   Any unexpected error during nonce persistence is treated as a replay and
 *   the request is rejected with 401.
 */
@Injectable()
export class RequestSigningGuard implements CanActivate {
  private readonly logger = new Logger(RequestSigningGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly nonceService: RequestNonceService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      Request & { apiKeyContext?: ApiKeyContext; rawBody?: Buffer }
    >();

    const requireSigning = this.reflector.get<boolean>(
      REQUIRE_SIGNING_KEY,
      context.getHandler(),
    ) ?? false;

    // Check whether the caller included any signing headers.
    const hasSigning = hasSigningHeaders(
      request.headers as Record<string, string | string[] | undefined>,
    );

    // Bearer-only compatibility: if no signing headers and not required, pass through.
    if (!hasSigning && !requireSigning) {
      return true;
    }

    // If signing is required but headers are absent, reject.
    if (!hasSigning && requireSigning) {
      throw new UnauthorizedException(
        "This endpoint requires a signed request. Include X-EarnProof-Signature, " +
        "X-EarnProof-Timestamp, and X-EarnProof-Nonce headers.",
      );
    }

    // At this point the caller provided signing headers — validate them.
    const ctx = request.apiKeyContext;
    if (!ctx) {
      // Signing guard must run after ApiKeyGuard.
      throw new UnauthorizedException("Invalid API key");
    }

    const timestampHeader = this.singleHeader(request, HEADER_TIMESTAMP);
    const nonceHeader     = this.singleHeader(request, HEADER_NONCE);
    const sigHeader       = this.singleHeader(request, HEADER_SIGNATURE);

    if (!timestampHeader || !nonceHeader || !sigHeader) {
      throw new UnauthorizedException(
        "Signed request requires all three headers: X-EarnProof-Signature, " +
        "X-EarnProof-Timestamp, and X-EarnProof-Nonce.",
      );
    }

    // Retrieve the raw API key secret from the Authorization header.
    // ApiKeyGuard already validated this is a real, active key.
    const rawSecret = this.extractBearerToken(request);
    if (!rawSecret) {
      throw new UnauthorizedException("Invalid API key");
    }

    // Verify the signature (timestamp range, nonce format, HMAC).
    const result = verifySignature({
      rawSecret,
      method: request.method,
      path: request.path,
      timestampHeader,
      nonceHeader,
      signatureHeader: sigHeader,
      body: request.rawBody ?? null,
    });

    if (!result.ok) {
      this.logFailure(ctx.keyId, result.reason);
      throw new UnauthorizedException(this.publicMessage(result.reason));
    }

    // Claim the nonce — fail closed if replay detected.
    const ts = Number(timestampHeader);
    const fresh = await this.nonceService.claimNonce(ctx.keyId, nonceHeader, ts);
    if (!fresh) {
      this.logger.warn(`Replay detected for key ${ctx.keyId}`);
      throw new UnauthorizedException("Request signature has already been used (replay detected).");
    }

    return true;
  }

  private singleHeader(request: Request, name: string): string | null {
    const val = request.headers[name];
    if (typeof val === "string") return val;
    if (Array.isArray(val) && val.length > 0) return val[0] ?? null;
    return null;
  }

  private extractBearerToken(request: Request): string | null {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return null;
    return auth.slice("Bearer ".length);
  }

  private logFailure(keyId: string, reason: SignatureFailureReason): void {
    this.logger.warn(`Signature verification failed for key ${keyId}: ${reason}`);
  }

  private publicMessage(reason: SignatureFailureReason): string {
    switch (reason) {
      case SignatureFailureReason.STALE_TIMESTAMP:
        return "Request timestamp is outside the accepted clock window (±5 min).";
      case SignatureFailureReason.MALFORMED_TIMESTAMP:
        return "X-EarnProof-Timestamp must be a Unix timestamp in seconds.";
      case SignatureFailureReason.MALFORMED_NONCE:
        return "X-EarnProof-Nonce must be 16–128 URL-safe characters.";
      case SignatureFailureReason.MALFORMED_SIGNATURE:
        return "X-EarnProof-Signature must be in the format v1=<64-char hex>.";
      case SignatureFailureReason.SIGNATURE_INVALID:
      case SignatureFailureReason.BODY_MISMATCH:
        return "Request signature is invalid.";
      default:
        return "Request signature verification failed.";
    }
  }
}