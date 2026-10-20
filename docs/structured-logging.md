# Structured Logging

This application uses structured logging with automatic request correlation, sensitive data redaction, and support for both human-readable and machine-parseable output formats.

## Overview

Structured logging provides:

- **Correlation**: Every log line includes a request ID that ties together all log entries from a single HTTP request and its async sub-operations (background jobs, retries, etc.)
- **Structured fields**: Log context (workflow name, outcome, duration, count) is attached in a machine-parseable format
- **Redaction**: Sensitive values (wallet addresses, signing secrets, tokens, amounts) are automatically redacted before logging
- **Async propagation**: Request context survives `async/await` boundaries via `AsyncLocalStorage`

## Usage

### Basic Logging

Use `StructuredLogger` instead of NestJS's `Logger`:

```typescript
import { StructuredLogger } from "../common/logger";

@Injectable()
export class MyService {
  private readonly logger = new StructuredLogger(MyService.name);

  async doSomething(): Promise<void> {
    this.logger.log("Operation started");
    // ...
    this.logger.log("Operation completed", { 
      workflow: "registration",
      outcome: "success",
      durationMs: 245
    });
  }
}
```

### Log Levels

Four log levels are available, same as NestJS Logger:

```typescript
logger.debug("Verbose detail");        // DEBUG - disabled in production
logger.log("Routine progress");         // INFO - always enabled
logger.warn("Worth noticing");          // WARN - always enabled
logger.error("Operation failed", err);  // ERROR - always enabled
```

### Structured Context

Pass a context object as the second argument to add structured fields:

```typescript
logger.log("Payment processed", {
  workflow: "payment-verification",
  outcome: "verified",
  durationMs: 120,
  count: 3  // items processed
});
```

**Available context fields:**
- `requestId`: Request ID (auto-populated from X-Request-ID header)
- `userId`: Authenticated user ID (auto-populated if available)
- `workflow`: Bounded workflow name (e.g., "registration", "verification")
- `outcome`: Bounded outcome (e.g., "success", "transient_error", "permanent_error")
- `durationMs`: Duration in milliseconds (measurements only, not identifiers)
- `count`: Row or item count (measurements only, not identifiers)

**Forbidden fields:** Never add these to log context:
- `walletAddress`, `wallet` — correlates logs to user identities
- `proofId`, `credentialHash`, `commitment` — high-cardinality identifiers
- `amount`, `memo` — payment details
- `url`, `signature`, `token`, `tokenHash`, `secret`, `payload`, `body` — sensitive material
- `stack` — implementation details

If you need to log a value from one of these fields, serialize it to the database and log its database ID instead.

### Error Logging

Always pass the error as the second argument:

```typescript
try {
  await doSomething();
} catch (error) {
  logger.error("Operation failed", error, {
    workflow: "registration",
    outcome: "permanent_error"
  });
}
```

The error's class name and redacted message are included automatically. Stack traces are excluded in production (they leak implementation details and file paths).

### Request Context Propagation

Request ID and user ID are automatically available in every log call during a request's lifecycle, including in async operations:

```typescript
@Injectable()
export class MyService {
  private readonly logger = new StructuredLogger(MyService.name);

  async handleRequest(): Promise<void> {
    this.logger.log("Request started");
    
    // Request context is available even across async boundaries
    await this.asyncOperation();
    
    // Request context is still available
    this.logger.log("Request completed");
  }

  private async asyncOperation(): Promise<void> {
    // The same request ID is available here
    this.logger.log("Async operation");
  }
}
```

The request ID flows through:
- Database queries
- Background job execution triggered by the request
- Queued tasks and retries
- Downstream service calls

If you need to explicitly run code with a specific request context (e.g., in a background job), use:

```typescript
import { runWithRequestContextAsync } from "../common/logger";

await runWithRequestContextAsync(
  { requestId: "job_run_123", userId: "user_456" },
  async () => {
    // Logs here will include jobRunId: job_run_123, userId: user_456
    this.logger.log("Background job started");
  }
);
```

## Redaction

Sensitive values are automatically redacted before logging. Patterns matched:

| Pattern | Replacement |
|---------|------------|
| Stellar secret key (S + 55 chars) | `[REDACTED_SECRET]` |
| Stellar public address (G + 55 chars) | `[REDACTED_ADDRESS]` |
| Soroban contract ID (C + 55 chars) | `[REDACTED_CONTRACT]` |
| JWT tokens | `[REDACTED_TOKEN]` |
| Environment variables (KEY=VALUE) | `[REDACTED_ENV]` |
| URLs with query parameters | `[REDACTED_URL]` |
| Hex hashes (64+ characters) | `[REDACTED_HASH]` |
| Base64 payloads (40+ characters) | `[REDACTED_PAYLOAD]` |
| Decimal amounts | `[REDACTED_AMOUNT]` |

Redaction is conservative: it's better to blank an operationally useful figure than to retain an identifier. The *shape* of the error — which patterns matched in what order — survives and drives runbooks.

Numbers adjacent to counting words ("attempt 3", "retry 5", "limit 100") are preserved.

## Migrating a Service

To migrate a service from `Logger` to `StructuredLogger`:

1. **Change the import:**
   ```typescript
   // Before:
   import { Logger } from "@nestjs/common";
   
   // After:
   import { StructuredLogger } from "../common/logger";
   ```

2. **Change the instantiation:**
   ```typescript
   // Before:
   private readonly logger = new Logger(MyService.name);
   
   // After:
   private readonly logger = new StructuredLogger(MyService.name);
   ```

3. **Add structured context to key operations:**
   ```typescript
   // Before:
   this.logger.log("Proof created");
   
   // After:
   this.logger.log("Proof created", {
     workflow: "proof-issuance",
     outcome: "success",
     durationMs: elapsed
   });
   ```

4. **No other changes needed** — `StructuredLogger` has the same interface as `Logger` (log, warn, error, debug methods), so existing call sites work unchanged.

## Log Format

**Development:** Human-readable format via NestJS Logger:
```
[Nest] 12345  - 09/23/2026, 7:37:34 PM    INFO [MyService] Operation completed [workflow=registration outcome=success durationMs=245 requestId=abc123...]
```

**Production:** JSON per line (future enhancement; currently follows NestJS logger format):
```json
{"level":"info","timestamp":"2026-09-23T19:37:34.123Z","module":"MyService","message":"Operation completed","workflow":"registration","outcome":"success","durationMs":245,"requestId":"abc123...","userId":"user_123"}
```

## Configuration

### Per-Module Log Levels

Set the `LOG_LEVEL` environment variable or per-module via NestJS ConfigService.

Supported levels: `DEBUG`, `INFO`, `WARN`, `ERROR`

Default: `INFO` (debug logs disabled)

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOG_LEVEL` | `INFO` | Global minimum log level |
| `DEBUG` | `unset` | Enable debug logs for specific modules (comma-separated) |

Example:
```bash
# Enable debug logs for webhook delivery and payments services
DEBUG=WebhookDeliveryService,PaymentsService npm start
```

## Request ID Header

Clients can supply an `X-Request-ID` header to correlate logs with their own systems:

```bash
curl -H "X-Request-ID: client-batch-123" http://localhost:3000/api/v1/proofs
```

If not supplied, a 32-character hex ID is generated automatically. The resolved ID is returned in the response header `X-Request-ID`.

## Testing

Logs are visible in test output by default. To suppress logs during tests:

```bash
npm run test -- --silent
```

To inspect logs from a specific test:

```bash
npm run test -- --verbose path/to/test.spec.ts
```

## Best Practices

1. **Always log operation boundaries**: Entry and exit of significant operations (service methods, request handlers, job executions)
   ```typescript
   this.logger.log("Proof verification started");
   // ...
   this.logger.log("Proof verification completed", { outcome: "valid" });
   ```

2. **Use outcome codes for errors**: Distinguish transient from permanent failures
   ```typescript
   logger.warn("Transient failure", error, { 
     workflow: "payment-sync", 
     outcome: "transient_error" 
   });
   
   logger.error("Permanent failure", error, { 
     workflow: "payment-sync", 
     outcome: "permanent_error" 
   });
   ```

3. **Log measurements, not identifiers**: Duration, count, size — not user IDs, proof IDs, or amounts
   ```typescript
   // Good:
   logger.log("Batch processed", { count: 1200, durationMs: 345 });
   
   // Bad (high cardinality):
   logger.log("Processing payment", { paymentId: "pay_123456" });
   ```

4. **Keep messages short and specific**:
   ```typescript
   // Good:
   logger.error("Failed to anchor proof", error);
   
   // Bad (vague):
   logger.error("Something went wrong", error);
   ```

5. **Never log raw request/response bodies**: Extract and log the relevant field
   ```typescript
   // Good:
   logger.debug("Credential verification started", { workflow: "verification" });
   
   // Bad (could leak credentials):
   logger.debug("Request body", { body: req.body });
   ```

## Troubleshooting

### Request ID Not Appearing in Logs

Check that `RequestContextMiddleware` is registered in bootstrap. It should run after structural limits but before other middleware.

### Sensitive Data in Logs

1. Check if it matches a redaction pattern (see table above)
2. If not, consider whether it should be logged at all
3. If it must be logged, use a redaction annotation or log a database ID instead
4. File an issue if you discover new sensitive patterns that should be redacted

### Log Noise

Use the `LOG_LEVEL` environment variable or NestJS `getLogger()` to control verbosity per module:

```typescript
// Disable debug logs for this module
const logger = new StructuredLogger(MyService.name);
// Will respect LOG_LEVEL environment variable
```

## Implementation Details

- `RequestContext` is stored in Node.js `AsyncLocalStorage`, which survives async boundaries
- Request context is populated by `RequestContextMiddleware` on each request
- Redaction happens at output time, not at collection time, so you can log freely and redaction policies can be updated without code changes
- Structured fields are validated against a forbidden list to prevent accidental logging of sensitive data
