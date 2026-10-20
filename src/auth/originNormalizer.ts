/**
 * Normalizes and validates an application origin for inclusion in
 * wallet challenge state.
 *
 * A valid origin is: scheme://host[:port]
 * - Only https:// and http://localhost are accepted
 * - Wildcard origins (*) are rejected
 * - Opaque origins (null) are rejected
 * - Credential-bearing URLs (user:pass@host) are rejected
 * - Trailing slashes and paths are stripped
 * - The result is a canonical, lowercase, normalized string
 *
 * @throws OriginValidationError with an auditable reason on rejection
 */

export enum OriginRejectionReason {
  Opaque = 'opaque_origin',
  Wildcard = 'wildcard_origin',
  CredentialBearing = 'credential_bearing_url',
  UnsupportedScheme = 'unsupported_scheme',
  Malformed = 'malformed_url',
  Empty = 'empty_origin',
}

export class OriginValidationError extends Error {
  constructor(
    message: string,
    public readonly reason: OriginRejectionReason,
    public readonly rawOrigin: string,
  ) {
    super(message);
    this.name = 'OriginValidationError';
  }
}

/**
 * Normalizes an origin string for challenge binding.
 * Returns the canonical origin or throws OriginValidationError.
 */
export function normalizeOrigin(rawOrigin: string): string {
  // Reject empty
  if (!rawOrigin || rawOrigin.trim() === '') {
    throw new OriginValidationError(
      'Origin is empty',
      OriginRejectionReason.Empty,
      rawOrigin,
    );
  }

  // Reject opaque (literal "null")
  if (rawOrigin === 'null') {
    throw new OriginValidationError(
      'Opaque origins are not accepted',
      OriginRejectionReason.Opaque,
      rawOrigin,
    );
  }

  // Reject wildcard
  if (rawOrigin === '*') {
    throw new OriginValidationError(
      'Wildcard origins are not accepted',
      OriginRejectionReason.Wildcard,
      rawOrigin,
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw new OriginValidationError(
      `Malformed origin: cannot parse as URL`,
      OriginRejectionReason.Malformed,
      rawOrigin,
    );
  }

  // Reject credential-bearing URLs
  if (parsed.username || parsed.password) {
    throw new OriginValidationError(
      'Credential-bearing URLs are not accepted as origins',
      OriginRejectionReason.CredentialBearing,
      rawOrigin,
    );
  }

  // Only accept https:// or http://localhost
  const isHttpsScheme = parsed.protocol === 'https:';
  const isLocalhostHttp =
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');

  if (!isHttpsScheme && !isLocalhostHttp) {
    throw new OriginValidationError(
      `Unsupported scheme "${parsed.protocol}" — only https:// and http://localhost are accepted`,
      OriginRejectionReason.UnsupportedScheme,
      rawOrigin,
    );
  }

  // Canonical form: scheme://host[:port] (no path, no trailing slash, lowercase)
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}`;
}
