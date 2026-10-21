export type AuthenticatedUser = {
  id: string;
  walletAddress: string;
  walletHash: string;
  role: string;
  organizationId?: string;
};

/**
 * Minimal session context attached to every authenticated request.
 * The raw bearer token is never kept here — only the opaque session id
 * that the guard resolved from the database.
 */
export type AuthenticatedSession = AuthenticatedUser & {
  /** Database id of the resolved AuthSession row. */
  sessionId: string;
};

/**
 * @deprecated  The previous HMAC-only payload type.
 * Kept temporarily so that any external references compile while the
 * migration is in progress; remove once all callers are updated.
 */
export type AuthTokenPayload = AuthenticatedUser & {
  exp: number;
};
