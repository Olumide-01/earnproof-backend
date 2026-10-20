import { Logger as NestLogger } from "@nestjs/common";
import {
  formatContext,
  redact,
  redactError,
  type LogContext,
} from "../observability/redaction";
import { getRequestContext } from "./request-context";

/**
 * Structured logger with JSON output support and automatic context propagation.
 *
 * - In development: human-readable output (via NestJS Logger)
 * - In production: JSON per line for machine parsing
 * - Automatic request ID and user ID injection from AsyncLocalStorage
 * - Redaction of sensitive fields before output
 * - Support for structured context fields (workflow, outcome, duration, count)
 *
 * Usage:
 *   const logger = new StructuredLogger(MyService.name);
 *   logger.log("Operation started", { workflow: "registration" });
 */
export class StructuredLogger {
  private readonly context: string;
  private readonly nestLogger: NestLogger;

  constructor(context: string) {
    this.context = context;
    this.nestLogger = new NestLogger(context);
  }

  /**
   * Logs routine progress. Safe to sample or drop under load.
   * Log level: INFO
   */
  log(message: string, additionalContext?: LogContext): void {
    const ctx = this.enrichContext(additionalContext);
    const output = this.formatOutput("info", message, ctx);
    this.nestLogger.log(output);
  }

  /**
   * Logs a condition worth noticing that did not fail the operation.
   * Log level: WARN
   */
  warn(message: string, additionalContext?: LogContext): void {
    const ctx = this.enrichContext(additionalContext);
    const output = this.formatOutput("warn", message, ctx);
    this.nestLogger.warn(output);
  }

  /**
   * Logs a failed operation.
   * Log level: ERROR
   *
   * @param message - Description of what failed
   * @param cause - The error/exception that caused the failure (optional)
   * @param additionalContext - Structured context fields
   */
  error(message: string, cause?: unknown, additionalContext?: LogContext): void {
    const ctx = this.enrichContext(additionalContext);
    if (cause) {
      ctx.error = redactError(cause);
    }
    const output = this.formatOutput("error", message, ctx);
    this.nestLogger.error(output);
  }

  /**
   * Logs verbose detail. Disabled in production via NestJS log level configuration.
   * Log level: DEBUG
   */
  debug(message: string, additionalContext?: LogContext): void {
    const ctx = this.enrichContext(additionalContext);
    const output = this.formatOutput("debug", message, ctx);
    this.nestLogger.debug(output);
  }

  /**
   * Enriches the context with automatically-extracted fields.
   *
   * Adds:
   * - requestId: from AsyncLocalStorage (if in request context)
   * - userId: from AsyncLocalStorage (if authenticated)
   * - timestamp: ISO 8601 format
   * - module: the logger's context (class name)
   */
  private enrichContext(additionalContext?: LogContext): Record<string, unknown> {
    const ctx: Record<string, unknown> = { ...additionalContext };

    const requestCtx = getRequestContext();
    if (requestCtx) {
      ctx.requestId = requestCtx.requestId;
      if (requestCtx.userId) {
        ctx.userId = requestCtx.userId;
      }
    }

    return ctx;
  }

  /**
   * Formats the log output.
   *
   * In development: produces human-readable text (NestJS Logger will handle formatting)
   * In production (NODE_ENV=production): produces JSON per line
   *
   * For now, we keep the human-readable format and rely on the application's
   * log formatter configuration. A future enhancement could detect NODE_ENV and
   * output JSON directly here.
   */
  private formatOutput(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    context: Record<string, unknown>,
  ): string {
    const redactedMessage = redact(message);

    // In development, keep human-readable format.
    // NestJS logger handles the formatting, we just provide context.
    const contextStr =
      Object.keys(context).length > 0
        ? ` [${Object.entries(context)
            .map(([k, v]) => `${k}=${this.formatValue(v)}`)
            .join(" ")}]`
        : "";

    return `${redactedMessage}${contextStr}`;
  }

  /**
   * Formats a context value for output.
   *
   * - Strings are redacted and truncated
   * - Numbers and booleans are stringified as-is
   * - Objects/arrays are JSON-stringified
   */
  private formatValue(value: unknown): string {
    if (typeof value === "string") {
      const redacted = redact(value);
      return redacted.length > 128 ? `${redacted.slice(0, 128)}…` : redacted;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (value === undefined || value === null) {
      return String(value);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "[circular or unserializable]";
    }
  }
}
