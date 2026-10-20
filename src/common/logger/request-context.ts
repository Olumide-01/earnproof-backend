import { AsyncLocalStorage } from "async_hooks";

/**
 * Request context that survives async boundaries.
 *
 * Holds the request ID and other correlation fields that should be available
 * to log statements anywhere in the async call chain, not just synchronous
 * request handlers. The AsyncLocalStorage persists the context even as the
 * call chain crosses thread pool boundaries (e.g., database queries) or
 * setTimeout/setInterval boundaries (e.g., scheduled jobs triggered by a request).
 */
export interface RequestContext {
  /** Request ID from X-Request-ID header (or generated). */
  requestId: string;
  /** User ID if authenticated, undefined for anonymous requests. */
  userId?: string;
}

/**
 * Global AsyncLocalStorage for request context.
 *
 * Access via {@link getRequestContext} to ensure type safety and lazy initialization.
 * NestJS request-scoped providers would be cleaner but are unavailable in async
 * contexts outside the request chain (e.g., background jobs, cron tasks, queue workers).
 */
const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Returns the current request context if one is active, undefined otherwise.
 *
 * Safe to call from any async context. Returns undefined if not within a
 * request scope (e.g., during app initialization, in a background job).
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Sets the request context for the duration of the callback.
 *
 * Used by the request context middleware to establish the context for the
 * entire request lifetime and any async operations it spawns.
 */
export function runWithRequestContext<T>(
  context: RequestContext,
  callback: () => T,
): T {
  return storage.run(context, callback);
}

/**
 * Runs an async callback with the given request context.
 *
 * Ensures the context is available throughout the entire async chain,
 * including in child tasks, retries, and background operations.
 */
export async function runWithRequestContextAsync<T>(
  context: RequestContext,
  callback: () => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    storage.run(context, async () => {
      try {
        resolve(await callback());
      } catch (error) {
        reject(error);
      }
    });
  });
}
