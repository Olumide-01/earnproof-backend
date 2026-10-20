import { sha256 } from "../crypto/hash";

/**
 * Compute a deterministic filter ID from query parameters.
 *
 * This hash binds a cursor to the specific filter context in which it was created,
 * preventing cross-filter pagination attempts. The hash is computed from:
 * - The filter parameter names and values (sorted for determinism)
 * - The sort order (if applicable)
 * - Excludes pagination parameters (cursor, limit)
 *
 * @param params Object containing filter parameters (status, category, etc.)
 * @returns SHA-256 hash of the normalized filter parameters
 */
export function computeFilterId(params: Record<string, any>): string {
  // Extract filter params, excluding pagination and irrelevant fields
  const filterParams: Record<string, any> = {};

  for (const [key, value] of Object.entries(params)) {
    // Skip pagination and internal fields
    if (key === "cursor" || key === "limit" || value === undefined || value === null) {
      continue;
    }

    filterParams[key] = value;
  }

  // Normalize to JSON with sorted keys for deterministic hashing
  const normalized = JSON.stringify(filterParams, Object.keys(filterParams).sort());

  return sha256(normalized);
}

/**
 * Compute filter ID from query DTO with common filter fields.
 * Useful for list endpoints that share similar query parameters.
 *
 * @template T The query DTO type
 * @param query The query DTO instance
 * @param filterFields Which fields to include in the filter hash
 * @returns SHA-256 hash of the filter context
 */
export function computeFilterIdFromDto<T extends Record<string, any>>(
  query: T,
  filterFields: (keyof T)[],
): string {
  const filterParams: Record<string, any> = {};

  for (const field of filterFields) {
    const value = query[field];
    if (value !== undefined && value !== null) {
      filterParams[String(field)] = value;
    }
  }

  const normalized = JSON.stringify(filterParams, Object.keys(filterParams).sort());
  return sha256(normalized);
}
