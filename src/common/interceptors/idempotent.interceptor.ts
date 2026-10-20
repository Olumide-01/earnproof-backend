import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpStatus,
  BadRequestException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable, throwError } from "rxjs";
import { catchError, tap } from "rxjs/operators";
import { Request, Response } from "express";
import { IdempotencyService } from "../services/idempotency.service";
import {
  IDEMPOTENT_KEY,
  IdempotentOptions,
} from "../decorators/idempotent.decorator";
import { AuthenticatedUser } from "../../auth/auth.types";

/**
 * IdempotentInterceptor enforces idempotency on controller methods decorated with @Idempotent.
 *
 * Flow:
 * 1. Check if the method is decorated with @Idempotent
 * 2. Extract the idempotency key from the request header
 * 3. Check if this key has been seen before in this organization
 * 4. If new: reserve the key, execute handler, store response on success
 * 5. If replay: return stored response (or 408 if still PENDING)
 * 6. If conflict: return 409 Conflict
 */
@Injectable()
export class IdempotentInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotentInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const user = (request as any).user as AuthenticatedUser;

    // Check if this method is decorated with @Idempotent
    const idempotentOptions = this.reflector.get<IdempotentOptions | undefined>(
      IDEMPOTENT_KEY,
      context.getHandler(),
    );

    if (!idempotentOptions) {
      // Not decorated, skip idempotency logic
      return next.handle();
    }

    const { headerName = "idempotency-key", required = true } = idempotentOptions;

    // Extract the idempotency key from the header
    const idempotencyKey = request.headers[
      headerName.toLowerCase()
    ] as string | undefined;

    // If no key and not required, skip idempotency logic
    if (!idempotencyKey) {
      if (required) {
        throw new BadRequestException(
          `Idempotency key is required. Provide it via the "${headerName}" header.`,
        );
      }
      // Skip idempotency for this request
      return next.handle();
    }

    // Validate the key format
    this.idempotencyService.validateKey(idempotencyKey);

    // Compute the request fingerprint
    const method = request.method;
    const path = request.path;
    const body = request.body;
    const requestFingerprint = this.idempotencyService.computeFingerprint(
      method,
      path,
      body,
    );

    // For now, assume organization ID is available in the user context.
    // In a real system, this might come from a route parameter or JWT claim.
    // For this implementation, we'll derive it from the issuer's organization
    // which requires a database lookup, or we'll use a placeholder approach.
    //
    // The issue: users can be part of multiple organizations. The request context
    // would typically specify which organization the action is scoped to.
    // For now, we'll use a request-scoped organization ID set by middleware.
    let organizationId = (request as any).organizationId;

    if (!organizationId && user) {
      // Fallback: if user only has one organization (simple case), use it.
      // In production, this would come from the request path or middleware.
      this.logger.warn(
        "Organization ID not found in request context. This should be set by middleware.",
      );
      // For testing, we'll generate a placeholder. In production, this must be set.
      organizationId = "org-placeholder";
    }

    // Check if this key has been used before
    let checkResult: any;
    try {
      checkResult = await this.idempotencyService.check(
        organizationId,
        idempotencyKey,
        requestFingerprint,
      );
    } catch (error) {
      // ConflictException or other validation errors
      if (error instanceof ConflictException) {
        this.logger.warn(
          `Idempotency key conflict: key=${idempotencyKey}, fingerprint=${requestFingerprint}`,
        );
      }
      throw error;
    }

    if (!checkResult.isNew) {
      // This is a replay. Return the stored response.
      const record = checkResult.record!;

      this.logger.debug(
        `Replaying idempotent request: key=${idempotencyKey}, status=${record.status}`,
      );

      if (record.status === "PENDING") {
        // Previous attempt still in progress. Return 408 Request Timeout.
        response.status(HttpStatus.REQUEST_TIMEOUT).json({
          statusCode: HttpStatus.REQUEST_TIMEOUT,
          code: "REQUEST_TIMEOUT",
          message:
            "Previous idempotent request is still being processed. Please retry.",
          requestId: (request as any).id,
        });
        // Return an empty observable to indicate the request was handled
        return new Observable((subscriber) => {
          subscriber.complete();
        });
      }

      // Return the stored response
      response
        .status(record.responseStatusCode || 200)
        .json(record.responseBody);
      // Return an empty observable to indicate the request was handled
      return new Observable((subscriber) => {
        subscriber.complete();
      });
    }

    // This is a new request. Reserve the key and proceed.
    await this.idempotencyService.reserve(
      organizationId,
      idempotencyKey,
      requestFingerprint,
    );

    this.logger.debug(`Reserved idempotency key: ${idempotencyKey}`);

    // Execute the handler
    return next.handle().pipe(
      tap((result) => {
        // Success: store the response
        const statusCode = response.statusCode || 201;
        this.logger.debug(
          `Storing idempotent response: key=${idempotencyKey}, status=${statusCode}`,
        );
        return this.idempotencyService.success(
          organizationId,
          idempotencyKey,
          result,
          statusCode,
        );
      }),
      catchError((error) => {
        // Failure: record the failed status
        this.logger.debug(`Marking idempotency key as failed: ${idempotencyKey}`);
        return this.idempotencyService
          .failure(organizationId, idempotencyKey)
          .then(() => throwError(() => error));
      }),
    );
  }
}
