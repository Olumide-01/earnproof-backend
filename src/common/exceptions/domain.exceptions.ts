/**
 * Domain-specific HTTP exceptions.
 *
 * These extend Nest's `HttpException` and shape their response body to match
 * the "stable error response" contract that `GlobalExceptionFilter` looks
 * for (`{ code, message }`, where `code` is a member of `ApiErrorCode`) —
 * see `src/common/filters/global-exception.filter.ts` and
 * `src/common/dto/api-error.dto.ts`.
 *
 * Rule: never pass raw upstream error bodies, stack traces, or secrets into
 * the `message` given to these constructors. The message is what a client
 * sees. Log the raw detail separately with `Logger` at the call site instead.
 */
import { HttpException, HttpStatus } from "@nestjs/common";
import { ApiErrorCode } from "../dto/api-error.dto";

interface StableErrorBody {
  code: ApiErrorCode;
  message: string;
}

/**
 * A required dependency (Stellar Horizon, an anchoring contract call, a
 * webhook destination) failed or was unavailable. Maps to 503 by default —
 * pass a different status only when the failure is better modeled as a
 * client error (e.g. a malformed contract ID caught before the call).
 */
class StableHttpException extends HttpException {
  constructor(
    code: ApiErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.SERVICE_UNAVAILABLE,
  ) {
    const body: StableErrorBody = { code, message };
    super(body, status);
  }
}

/**
 * Raised when a call to Stellar Horizon fails: non-2xx response, network
 * error, or a malformed/unexpected payload. Never includes the raw response
 * body, headers, or URL query string in `message` — those may carry request
 * signatures or other sensitive query parameters.
 */
export class HorizonException extends StableHttpException {
  constructor(
    message = "Stellar Horizon is temporarily unavailable",
    status: HttpStatus = HttpStatus.SERVICE_UNAVAILABLE,
  ) {
    super(ApiErrorCode.DEPENDENCY_UNAVAILABLE, message, status);
  }
}

/**
 * Raised when contract anchoring (proof registry / issuer registry) fails:
 * the Stellar CLI process errors, returns no transaction evidence, or the
 * on-chain call itself reverts. Never includes CLI stdout/stderr verbatim —
 * that can contain the invoker's local file paths or key material.
 */
export class AnchoringException extends StableHttpException {
  constructor(
    message = "Contract anchoring is temporarily unavailable",
    status: HttpStatus = HttpStatus.SERVICE_UNAVAILABLE,
  ) {
    super(ApiErrorCode.DEPENDENCY_UNAVAILABLE, message, status);
  }
}

/**
 * Raised for webhook-subsystem failures that are the caller's fault (an
 * invalid replay target, an SSRF-guard rejection) rather than a missing
 * resource (use `NotFoundException` for that) or a downstream dependency
 * outage (use `HorizonException`/`AnchoringException` for those).
 */
export class WebhookException extends StableHttpException {
  constructor(
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super(ApiErrorCode.INVALID_INPUT, message, status);
  }
}

/**
 * Raised when an optimistic update fails due to a revision mismatch.
 * Indicates that the client's view of the resource is stale and needs
 * to be refreshed before retrying the update.
 */
export interface ConflictErrorBody {
  code: ApiErrorCode;
  message: string;
  currentRevision: number;
}

export class ConflictException extends HttpException {
  constructor(message: string, currentRevision: number) {
    const body: ConflictErrorBody = {
      code: ApiErrorCode.CONFLICT,
      message,
      currentRevision,
    };
    super(body, HttpStatus.CONFLICT);
  }
}
