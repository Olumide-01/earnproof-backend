import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import {
  ApiErrorCode,
  ApiErrorDto,
  FieldViolationDto,
} from "../dto/api-error.dto";
import { REQUEST_ID_HEADER } from "../interceptors/request-id.interceptor";
import { randomBytes } from "crypto";

// ─── Prisma error-code buckets ───────────────────────────────────────────────
// P2002 – unique constraint violation
// P2025 – record not found / required relation missing
// P2003 – foreign-key constraint violation
// P1000–P1017 – connection / configuration errors

const PRISMA_NOT_FOUND_CODES = new Set(["P2025"]);
const PRISMA_CONFLICT_CODES = new Set(["P2002", "P2003"]);
const PRISMA_DEPENDENCY_CODES = new Set([
  "P1000",
  "P1001",
  "P1002",
  "P1003",
  "P1008",
  "P1010",
  "P1011",
  "P1017",
]);

// ─── NestJS built-in exception message shapes ────────────────────────────────
interface NestValidationResponse {
  message: string | string[];
  error?: string;
  statusCode: number;
}

/**
 * Global exception filter that maps every thrown error to the stable
 * `ApiErrorDto` envelope. Rules:
 *
 * 1. Internal details (Prisma metadata, stack traces, command output,
 *    signatures, encrypted values) are NEVER forwarded to the client.
 * 2. The `requestId` is sourced from `request.requestId` (set by
 *    `RequestIdInterceptor`) or generated fresh as a last resort.
 * 3. NestJS `ValidationPipe` produces a 400 with an array of messages;
 *    these are surfaced as field violations with `code = VALIDATION_ERROR`.
 * 4. Auth-guard exceptions are mapped to specific auth codes.
 * 5. All unrecognised errors become INTERNAL_ERROR with a generic message.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { requestId?: string }>();
    const res = ctx.getResponse<Response>();

    const requestId = this.resolveRequestId(req);
    const { statusCode, code, message, violations, currentRevision } = this.classify(exception);

    // Log internal detail only server-side, never in the response.
    if (statusCode >= 500) {
      this.logger.error(
        `[${requestId}] ${statusCode} ${code}: ${this.safeMessage(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`[${requestId}] ${statusCode} ${code}: ${message}`);
    }

    const body: ApiErrorDto = { statusCode, code, message, requestId };
    if (violations?.length) {
      body.violations = violations;
    }
    if (currentRevision !== undefined) {
      body.currentRevision = currentRevision;
    }

    // Always echo the request-ID back so clients correlate even on errors that
    // arrive before the interceptor has had a chance to set the header.
    res.setHeader(REQUEST_ID_HEADER, requestId);
    res.status(statusCode).json(body);
  }

  // ─── Classification ───────────────────────────────────────────────────────

  private classify(exception: unknown): {
    statusCode: number;
    code: ApiErrorCode;
    message: string;
    violations?: FieldViolationDto[];
    currentRevision?: number;
  } {
    // ── NestJS HTTP exceptions ───────────────────────────────────────────────
    if (exception instanceof HttpException) {
      return this.classifyHttpException(exception);
    }

    // ── Body-parser failures ─────────────────────────────────────────────────
    // These arrive as plain errors from express middleware, not as
    // HttpExceptions, so without this branch an oversized body would be
    // reported as an internal error — telling the client nothing actionable and
    // logging a 500 for what is ordinary, expected input.
    const parserFailure = this.classifyBodyParserError(exception);
    if (parserFailure) {
      return parserFailure;
    }

    // ── Prisma errors ────────────────────────────────────────────────────────
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.classifyPrismaKnown(exception);
    }

    if (
      exception instanceof Prisma.PrismaClientUnknownRequestError ||
      exception instanceof Prisma.PrismaClientRustPanicError
    ) {
      return {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: ApiErrorCode.DEPENDENCY_UNAVAILABLE,
        message:
          "A required service dependency is temporarily unavailable. Please try again later.",
      };
    }

    if (exception instanceof Prisma.PrismaClientInitializationError) {
      return {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: ApiErrorCode.DEPENDENCY_UNAVAILABLE,
        message:
          "A required service dependency is temporarily unavailable. Please try again later.",
      };
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      // Prisma validation = programmer error; treat as internal.
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        code: ApiErrorCode.INTERNAL_ERROR,
        message: "An unexpected error occurred. Please try again later.",
      };
    }

    // ── Unknown / unhandled ──────────────────────────────────────────────────
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ApiErrorCode.INTERNAL_ERROR,
      message: "An unexpected error occurred. Please try again later.",
    };
  }

  private classifyHttpException(exception: HttpException): {
    statusCode: number;
    code: ApiErrorCode;
    message: string;
    violations?: FieldViolationDto[];
    currentRevision?: number;
  } {
    const status = exception.getStatus();
    const raw = exception.getResponse();

    if (this.isStableErrorResponse(raw)) {
      return {
        statusCode: status,
        code: raw.code,
        message: raw.message,
      };
    }

    // Check for ConflictException with currentRevision
    if (status === HttpStatus.CONFLICT && this.isConflictErrorResponse(raw)) {
      return {
        statusCode: status,
        code: raw.code,
        message: raw.message,
        currentRevision: raw.currentRevision,
      };
    }

    // NestJS ValidationPipe throws 400 with { message: string[], error, statusCode }
    if (status === HttpStatus.BAD_REQUEST && this.isValidationResponse(raw)) {
      const messages = Array.isArray(raw.message) ? raw.message : null;

      if (messages && messages.length > 0) {
        return {
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ApiErrorCode.VALIDATION_ERROR,
          message: "One or more fields failed validation.",
          violations: messages.map((msg) => this.parseValidationMessage(msg)),
        };
      }
    }

    // Auth-specific 401 messages (from AuthGuard / AuthService)
    if (status === HttpStatus.UNAUTHORIZED) {
      return this.classifyUnauthorized(exception);
    }

    if (status === HttpStatus.FORBIDDEN) {
      return {
        statusCode: HttpStatus.FORBIDDEN,
        code: ApiErrorCode.FORBIDDEN,
        message: "You do not have permission to perform this action.",
      };
    }

    if (status === HttpStatus.NOT_FOUND) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        code: ApiErrorCode.NOT_FOUND,
        message: "The requested resource was not found.",
      };
    }

    if (status === HttpStatus.CONFLICT) {
      return {
        statusCode: HttpStatus.CONFLICT,
        code: ApiErrorCode.CONFLICT,
        message:
          "The request conflicts with the current state of the resource.",
      };
    }

    if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
      return {
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        code: ApiErrorCode.PAYLOAD_TOO_LARGE,
        // The exception's own message names the limit and never the payload;
        // anything else is replaced rather than forwarded.
        message:
          this.extractSafeMessage(raw) ??
          "The request exceeds the maximum permitted size.",
      };
    }

    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      return {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: ApiErrorCode.TOO_MANY_REQUESTS,
        message: "Too many requests. Please slow down and try again later.",
      };
    }

    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      return {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: ApiErrorCode.DEPENDENCY_UNAVAILABLE,
        message:
          "A required service dependency is temporarily unavailable. Please try again later.",
      };
    }

    if (status === HttpStatus.BAD_REQUEST) {
      // Safe to surface the developer-authored message for 400s from service layer.
      const msg = this.extractSafeMessage(raw);
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        code: ApiErrorCode.INVALID_INPUT,
        message: msg ?? "The request contains invalid input.",
      };
    }

    if (status >= 500) {
      return {
        statusCode: status,
        code: ApiErrorCode.INTERNAL_ERROR,
        message: "An unexpected error occurred. Please try again later.",
      };
    }

    return {
      statusCode: status,
      code: ApiErrorCode.INTERNAL_ERROR,
      message: "An unexpected error occurred. Please try again later.",
    };
  }

  /**
   * Classifies an error thrown by the body parser.
   *
   * `body-parser` tags its failures with a `type`, which is the only stable way
   * to tell "the client sent 4 MB" from "the client sent malformed JSON" — the
   * messages are not contractual. Neither response quotes the body: an error
   * that echoes an oversized payload puts it into the log, which is the problem
   * this whole boundary exists to avoid.
   */
  private classifyBodyParserError(exception: unknown):
    | {
        statusCode: number;
        code: ApiErrorCode;
        message: string;
      }
    | undefined {
    if (!exception || typeof exception !== "object") return undefined;

    const type = (exception as { type?: unknown }).type;
    if (typeof type !== "string") return undefined;

    if (type === "entity.too.large") {
      return {
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        code: ApiErrorCode.PAYLOAD_TOO_LARGE,
        message: "The request exceeds the maximum permitted size.",
      };
    }

    if (
      type === "entity.parse.failed" ||
      type === "encoding.unsupported" ||
      type === "charset.unsupported" ||
      type === "request.aborted"
    ) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        code: ApiErrorCode.INVALID_INPUT,
        message: "The request body could not be read as JSON.",
      };
    }

    return undefined;
  }

  private isStableErrorResponse(
    value: unknown,
  ): value is { code: ApiErrorCode; message: string } {
    if (!value || typeof value !== "object") return false;
    const response = value as Record<string, unknown>;
    return (
      typeof response.message === "string" &&
      typeof response.code === "string" &&
      Object.values(ApiErrorCode).includes(response.code as ApiErrorCode)
    );
  }

  private isConflictErrorResponse(
    value: unknown,
  ): value is { code: ApiErrorCode; message: string; currentRevision: number } {
    if (!value || typeof value !== "object") return false;
    const response = value as Record<string, unknown>;
    return (
      typeof response.message === "string" &&
      typeof response.code === "string" &&
      response.code === ApiErrorCode.CONFLICT &&
      typeof response.currentRevision === "number"
    );
  }

  private classifyUnauthorized(exception: HttpException): {
    statusCode: number;
    code: ApiErrorCode;
    message: string;
  } {
    const raw = exception.getResponse();
    const text = this.extractSafeMessage(raw)?.toLowerCase() ?? "";

    if (text.includes("missing bearer token")) {
      return {
        statusCode: HttpStatus.UNAUTHORIZED,
        code: ApiErrorCode.MISSING_TOKEN,
        message: "Authentication is required. Provide a valid Bearer token.",
      };
    }

    if (text.includes("malformed auth token")) {
      return {
        statusCode: HttpStatus.UNAUTHORIZED,
        code: ApiErrorCode.INVALID_TOKEN,
        message: "Authentication token is malformed.",
      };
    }

    if (text.includes("invalid auth token")) {
      return {
        statusCode: HttpStatus.UNAUTHORIZED,
        code: ApiErrorCode.INVALID_TOKEN,
        message: "Authentication token is invalid.",
      };
    }

    if (text.includes("expired auth token")) {
      return {
        statusCode: HttpStatus.UNAUTHORIZED,
        code: ApiErrorCode.EXPIRED_TOKEN,
        message: "Authentication token has expired. Please log in again.",
      };
    }

    if (text.includes("challenge is expired or unavailable")) {
      return {
        statusCode: HttpStatus.UNAUTHORIZED,
        code: ApiErrorCode.INVALID_CREDENTIALS,
        message:
          "The authentication challenge is expired or has already been used.",
      };
    }

    if (text.includes("invalid wallet signature")) {
      return {
        statusCode: HttpStatus.UNAUTHORIZED,
        code: ApiErrorCode.INVALID_CREDENTIALS,
        message: "Wallet signature verification failed.",
      };
    }

    if (text.includes("user session is no longer valid")) {
      return {
        statusCode: HttpStatus.UNAUTHORIZED,
        code: ApiErrorCode.SESSION_EXPIRED,
        message: "Your session is no longer valid. Please log in again.",
      };
    }

    return {
      statusCode: HttpStatus.UNAUTHORIZED,
      code: ApiErrorCode.INVALID_TOKEN,
      message: "Authentication failed.",
    };
  }

  private classifyPrismaKnown(
    exception: Prisma.PrismaClientKnownRequestError,
  ): {
    statusCode: number;
    code: ApiErrorCode;
    message: string;
  } {
    const prismaCode = exception.code;

    if (PRISMA_NOT_FOUND_CODES.has(prismaCode)) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        code: ApiErrorCode.NOT_FOUND,
        message: "The requested resource was not found.",
      };
    }

    if (PRISMA_CONFLICT_CODES.has(prismaCode)) {
      return {
        statusCode: HttpStatus.CONFLICT,
        code: ApiErrorCode.CONFLICT,
        message:
          "The request conflicts with the current state of the resource.",
      };
    }

    if (PRISMA_DEPENDENCY_CODES.has(prismaCode)) {
      return {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: ApiErrorCode.DEPENDENCY_UNAVAILABLE,
        message:
          "A required service dependency is temporarily unavailable. Please try again later.",
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ApiErrorCode.INTERNAL_ERROR,
      message: "An unexpected error occurred. Please try again later.",
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private resolveRequestId(req: Request & { requestId?: string }): string {
    if (req.requestId) return req.requestId;

    // Fallback: try to read from the header directly (interceptor may not have
    // run yet if the error happened very early in the pipeline).
    const header = req.headers[REQUEST_ID_HEADER];
    const raw = Array.isArray(header) ? header[0] : header;
    const SAFE_PATTERN = /^[a-zA-Z0-9\-_]{1,128}$/;
    if (raw && SAFE_PATTERN.test(raw.trim())) return raw.trim();

    return randomBytes(16).toString("hex");
  }

  private isValidationResponse(raw: unknown): raw is NestValidationResponse {
    return (
      raw !== null &&
      typeof raw === "object" &&
      "message" in (raw as object) &&
      Array.isArray((raw as NestValidationResponse).message)
    );
  }

  /**
   * Parses a class-validator constraint message like:
   *   "walletAddress must be exactly 56 characters"
   * into a FieldViolationDto.
   */
  private parseValidationMessage(msg: string): FieldViolationDto {
    // class-validator messages start with the property name (camelCase/snake_case)
    // followed by a space and the constraint description.
    const spaceIdx = msg.indexOf(" ");
    if (spaceIdx > 0) {
      return { field: msg.slice(0, spaceIdx), message: msg };
    }
    return { field: "unknown", message: msg };
  }

  /**
   * Safely extracts a string message from a NestJS exception response,
   * returning null rather than leaking internal objects.
   */
  private extractSafeMessage(raw: unknown): string | null {
    if (typeof raw === "string") return raw;
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      if (typeof obj["message"] === "string") return obj["message"];
    }
    return null;
  }

  /** Used only for server-side logging – never sent to clients. */
  private safeMessage(exception: unknown): string {
    if (exception instanceof Error) return exception.message;
    if (typeof exception === "string") return exception;
    return String(exception);
  }
}
