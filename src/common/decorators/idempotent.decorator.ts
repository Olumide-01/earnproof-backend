import { SetMetadata } from "@nestjs/common";

export interface IdempotentOptions {
  /**
   * Which HTTP header to read the idempotency key from.
   * Defaults to "idempotency-key".
   */
  headerName?: string;

  /**
   * Whether to require an idempotency key for this endpoint.
   * If true, requests without the header will return 400.
   * If false, requests without the header skip idempotency logic.
   * Defaults to true.
   */
  required?: boolean;
}

export const IDEMPOTENT_KEY = "idempotent";

/**
 * Decorator to mark a controller method as idempotent.
 * Must be used with the IdempotentInterceptor.
 *
 * Usage:
 * @Post('proofs/minimum-income')
 * @Idempotent({ headerName: 'idempotency-key', required: true })
 * @UseInterceptors(IdempotentInterceptor)
 * createMinimumIncomeProof(...) { ... }
 */
export function Idempotent(options?: IdempotentOptions) {
  const headerName = options?.headerName ?? "idempotency-key";
  const required = options?.required ?? true;

  return SetMetadata(IDEMPOTENT_KEY, { headerName, required });
}
