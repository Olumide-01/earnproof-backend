import { AuthEventType, VerificationOutcome } from "@prisma/client";

/**
 * The audit taxonomy: the single, stable description of what this service
 * promises to record when a security-relevant action happens.
 *
 * Why a taxonomy rather than a comment next to each write:
 *
 * Audit coverage decays silently. A new endpoint ships, nobody adds the write,
 * and nothing fails — the gap is only discovered when an incident needs the
 * evidence that was never captured. The taxonomy makes coverage a declared
 * artefact, so the matrix test (`audit-event-matrix.spec.ts`) can assert that
 * what the services persist still matches what is declared here, and
 * `docs/audit-events.md` can describe one list rather than nine.
 *
 * Three properties are declared per event and each one is asserted:
 *
 * 1. **Identity** — the persisted shape (`store` plus `match`) that identifies
 *    the event, and the stable `type` that names it. The persisted shape is a
 *    wire format with existing rows behind it and is deliberately *not*
 *    normalised here; the stable type is the name to use in alerts, runbooks
 *    and reports, and `resolveAuditEventType` maps one to the other.
 * 2. **Context** — which actor types may appear, which outcomes the event can
 *    carry, and where the tenant context is read from.
 * 3. **Write-failure behaviour** — whether a failed audit write fails the
 *    mutation (`fail_closed`) or is swallowed so the request still succeeds
 *    (`fail_open`). This is a security decision, so it is recorded rather than
 *    left to whichever `try` block happens to surround the write.
 */

/** The area of the system an event belongs to. */
export type AuditDomain =
  | "authentication"
  | "authorization"
  | "issuer"
  | "proof"
  | "api_key"
  | "webhook"
  | "operator";

/** The kind of principal that caused the event. */
export type AuditActorType = "user" | "api_key" | "wallet" | "system";

/**
 * Whether the recorded attempt was allowed or refused.
 *
 * Deliberately coarse. Audit consumers ask "was this allowed?", and the
 * specific reason lives in the event's own fields (`failureReason`, the
 * verification `outcome`), where it is already constrained to safe values.
 */
export type AuditOutcome = "success" | "denied";

/** Which table the event is persisted to. */
export type AuditStore =
  | "audit_log"
  | "auth_audit_event"
  | "verification_event_log";

/**
 * What happens to the caller's mutation when the audit write itself fails.
 *
 * - `fail_closed`: the error propagates and the request fails. Correct where
 *   the action is a privileged mutation whose evidence is part of the promise:
 *   an untraceable key revocation is worse than a failed one.
 * - `fail_open`: the error is logged and swallowed. Correct where refusing the
 *   request would convert an audit outage into an availability outage on an
 *   unauthenticated path — anyone able to make audit writes fail could
 *   otherwise take authentication down with them.
 */
export type AuditWriteFailureBehavior = "fail_closed" | "fail_open";

/** How the tenant (owning scope) of an event is recovered from the row. */
export type AuditTenantSource =
  /**
   * `AuditLog.resourceId` is itself the tenant: the organisation row, or the
   * user account for account-administration events.
   */
  | "resource_id"
  /** `AuditLog.metadata.organizationId`. */
  | "metadata_organization_id"
  /** The acting principal owns the resource; `AuditLog.actorId` is the scope. */
  | "actor_id"
  /** `AuthAuditEvent.walletHash` — a hashed wallet, never the address. */
  | "wallet_hash"
  /** `VerificationEventLog.proofId`, whose owner is resolvable from the proof. */
  | "proof_id";

/** The persisted fingerprint that identifies an event in its store. */
export type AuditEventMatch =
  | { store: "audit_log"; action: string; resourceType: string }
  | { store: "auth_audit_event"; eventType: AuthEventType }
  | { store: "verification_event_log" };

export interface AuditEventDefinition {
  /** Stable name. Safe to use in alerts, runbooks and reports; never renamed. */
  readonly type: string;
  readonly domain: AuditDomain;
  readonly store: AuditStore;
  /** The persisted shape this event is recognised by. */
  readonly match: AuditEventMatch;
  /** Actor types that may legitimately produce this event. */
  readonly actorTypes: readonly AuditActorType[];
  /** Outcomes this event can carry. */
  readonly outcomes: readonly AuditOutcome[];
  /** Where the tenant context is read from. */
  readonly tenant: AuditTenantSource;
  /** Behaviour of the mutation when the audit write fails. */
  readonly writeFailure: AuditWriteFailureBehavior;
  /** Metadata keys the event must carry, asserted by the matrix test. */
  readonly requiredMetadata: readonly string[];
  /**
   * Metadata keys holding deliberately public identifiers.
   *
   * The redaction scan flags Stellar account identifiers wherever it finds
   * them, because a wallet address is the strongest re-identifier this service
   * handles. An issuer's account is public registry data by design, so the few
   * places that record one are named here rather than weakening the scan.
   */
  readonly publicIdentifierFields?: readonly string[];
  readonly description: string;
}

/**
 * Verification outcomes that count as a denial.
 *
 * `VALID` is the only allowed outcome; everything else is a refusal to vouch
 * for the proof, whether because it expired, was revoked, or did not verify.
 */
export const DENIED_VERIFICATION_OUTCOMES: readonly VerificationOutcome[] = [
  VerificationOutcome.EXPIRED,
  VerificationOutcome.REVOKED,
  VerificationOutcome.UNKNOWN,
  VerificationOutcome.INVALID_SIGNATURE,
  VerificationOutcome.ISSUER_WARNING,
];

/**
 * The declared audit events.
 *
 * Ordered by domain so the table in `docs/audit-events.md` and this list can be
 * read side by side.
 */
export const AUDIT_EVENTS: readonly AuditEventDefinition[] = [
  // ---------------------------------------------------------------- auth ---
  {
    type: "authentication.challenge_created",
    domain: "authentication",
    store: "auth_audit_event",
    match: { store: "auth_audit_event", eventType: AuthEventType.CHALLENGE_CREATED },
    actorTypes: ["wallet"],
    outcomes: ["success"],
    tenant: "wallet_hash",
    writeFailure: "fail_open",
    requiredMetadata: [],
    description: "A login challenge was issued for a wallet.",
  },
  {
    type: "authentication.challenge_verified",
    domain: "authentication",
    store: "auth_audit_event",
    match: { store: "auth_audit_event", eventType: AuthEventType.CHALLENGE_VERIFIED },
    actorTypes: ["wallet"],
    outcomes: ["success"],
    tenant: "wallet_hash",
    writeFailure: "fail_open",
    requiredMetadata: [],
    description: "A wallet proved control of its key and a session was issued.",
  },
  {
    type: "authentication.wallet_rotated",
    domain: "authentication",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "user.wallet_rotated",
      resourceType: "user",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "actor_id",
    writeFailure: "fail_closed",
    requiredMetadata: [
      "rotationId",
      "previousWalletHash",
      "newWalletHash",
      "sessionsRevoked",
    ],
    description:
      "An account proved control of its current and replacement keys and its wallet address was replaced; every session was revoked.",
  },
  {
    type: "authentication.signature_invalid",
    domain: "authentication",
    store: "auth_audit_event",
    match: { store: "auth_audit_event", eventType: AuthEventType.SIGNATURE_INVALID },
    actorTypes: ["wallet"],
    outcomes: ["denied"],
    tenant: "wallet_hash",
    writeFailure: "fail_open",
    requiredMetadata: [],
    description: "A challenge response carried a signature that did not verify.",
  },
  {
    type: "authentication.challenge_expired",
    domain: "authentication",
    store: "auth_audit_event",
    match: { store: "auth_audit_event", eventType: AuthEventType.CHALLENGE_EXPIRED },
    actorTypes: ["wallet"],
    outcomes: ["denied"],
    tenant: "wallet_hash",
    writeFailure: "fail_open",
    requiredMetadata: [],
    description: "A challenge was answered after it expired, or never existed.",
  },
  {
    type: "authentication.challenge_replayed",
    domain: "authentication",
    store: "auth_audit_event",
    match: { store: "auth_audit_event", eventType: AuthEventType.CHALLENGE_REPLAYED },
    actorTypes: ["wallet"],
    outcomes: ["denied"],
    tenant: "wallet_hash",
    writeFailure: "fail_open",
    requiredMetadata: [],
    description: "An already-consumed challenge was presented a second time.",
  },
  {
    type: "authentication.account_inactive",
    domain: "authentication",
    store: "auth_audit_event",
    match: { store: "auth_audit_event", eventType: AuthEventType.ACCOUNT_INACTIVE },
    actorTypes: ["wallet"],
    outcomes: ["denied"],
    tenant: "wallet_hash",
    writeFailure: "fail_open",
    requiredMetadata: [],
    description:
      "A suspended, revoked or deleted account proved wallet control and was refused a session.",
  },
  // ------------------------------------------------------- authorization ---
  {
    type: "authorization.rate_limited",
    domain: "authorization",
    store: "auth_audit_event",
    match: { store: "auth_audit_event", eventType: AuthEventType.RATE_LIMITED },
    actorTypes: ["wallet"],
    outcomes: ["denied"],
    tenant: "wallet_hash",
    writeFailure: "fail_open",
    requiredMetadata: [],
    description:
      "A wallet or client fingerprint exceeded an authentication rate limit and was refused.",
  },
  {
    type: "authorization.api_key_authenticated",
    domain: "authorization",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "api_key.authenticated",
      resourceType: "api_key",
    },
    actorTypes: ["api_key"],
    outcomes: ["success"],
    tenant: "metadata_organization_id",
    writeFailure: "fail_open",
    requiredMetadata: ["prefix", "organizationId"],
    description:
      "An API key was accepted and used, recorded with the key as its own actor.",
  },
  // -------------------------------------------------------------- issuer ---
  {
    type: "issuer.created",
    domain: "issuer",
    store: "audit_log",
    match: { store: "audit_log", action: "CREATE", resourceType: "Issuer" },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "metadata_organization_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["organizationId", "stellarAddress"],
    publicIdentifierFields: ["stellarAddress"],
    description: "An operator registered an issuer against an organisation.",
  },
  {
    type: "issuer.metadata_updated",
    domain: "issuer",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "UPDATE_METADATA",
      resourceType: "Issuer",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "actor_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["newMetadataHash"],
    description: "An operator changed an issuer's public metadata.",
  },
  {
    type: "issuer.status_updated",
    domain: "issuer",
    store: "audit_log",
    match: { store: "audit_log", action: "UPDATE_STATUS", resourceType: "Issuer" },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "actor_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["previousStatus", "newStatus"],
    description:
      "An operator moved an issuer between lifecycle states (verify, suspend, revoke).",
  },
  {
    type: "issuer.status_synced",
    domain: "issuer",
    store: "audit_log",
    match: { store: "audit_log", action: "SYNC_STATUS", resourceType: "Issuer" },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "actor_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["state", "status"],
    description: "An issuer's status was synchronised with the on-chain registry.",
  },
  {
    type: "issuer.address_rotation_requested",
    domain: "issuer",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "issuer.address_rotation.requested",
      resourceType: "issuer_address_rotation",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "metadata_organization_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["organizationId", "issuerId", "fromAddress", "toAddress", "expectedRevision"],
    publicIdentifierFields: ["fromAddress", "toAddress"],
    description:
      "An operator requested an issuer address rotation; the issuer's address is unchanged until the contract confirms it.",
  },
  {
    type: "issuer.address_rotated",
    domain: "issuer",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "issuer.address_rotation.confirmed",
      resourceType: "issuer_address_rotation",
    },
    actorTypes: ["user", "system"],
    outcomes: ["success"],
    tenant: "metadata_organization_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["organizationId", "issuerId", "fromAddress", "toAddress", "transactionHash"],
    publicIdentifierFields: ["fromAddress", "toAddress"],
    description:
      "The contract was observed holding the new issuer address and the database adopted it; the previous address was moved to history.",
  },
  {
    type: "issuer.address_rotation_failed",
    domain: "issuer",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "issuer.address_rotation.failed",
      resourceType: "issuer_address_rotation",
    },
    actorTypes: ["user", "system"],
    outcomes: ["success"],
    tenant: "metadata_organization_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["organizationId", "issuerId", "reason"],
    publicIdentifierFields: ["fromAddress", "toAddress"],
    description:
      "An issuer address rotation was closed without changing the issuer: a contract or database conflict, or retries exhausted.",
  },
  // --------------------------------------------------------------- proof ---
  {
    type: "proof.verification_recorded",
    domain: "proof",
    store: "verification_event_log",
    match: { store: "verification_event_log" },
    actorTypes: ["system"],
    outcomes: ["success", "denied"],
    tenant: "proof_id",
    writeFailure: "fail_open",
    requiredMetadata: [],
    description:
      "A public verification attempt was resolved; only the outcome and a salted metadata hash are kept.",
  },
  {
    type: "proof.revoked",
    domain: "proof",
    store: "audit_log",
    match: { store: "audit_log", action: "proof.revoked", resourceType: "proof" },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "resource_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["revokedByType", "reasonCode", "revokedAt"],
    description:
      "A proof was revoked by its owner or an administrator; the free-form private " +
      "reason and any evidence hash are kept on the proof row, never in this log.",
  },
  {
    type: "anchoring_intent.retried",
    domain: "proof",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "anchoring_intent.retried",
      resourceType: "proof",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "resource_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["intentId", "requeuedAt"],
    description:
      "An operator manually requeued a permanently-failed anchoring intent for retry.",
  },
  {
    type: "anchoring_intent.abandoned",
    domain: "proof",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "anchoring_intent.abandoned",
      resourceType: "proof",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "resource_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["intentId", "decidedAt"],
    description:
      "An operator made a terminal decision to abandon a quarantined anchoring intent; " +
      "the worker will never retry it again.",
  },
  // ------------------------------------------------------------- api key ---
  {
    type: "api_key.created",
    domain: "api_key",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "api_key.created",
      resourceType: "api_key",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "metadata_organization_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["prefix", "organizationId"],
    description: "A machine credential was issued for an organisation.",
  },
  {
    type: "api_key.rotated",
    domain: "api_key",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "api_key.rotated",
      resourceType: "api_key",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "metadata_organization_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["prefix", "organizationId"],
    description:
      "A machine credential was rotated with an overlap window or immediate cutover.",
  },
  {
    type: "api_key.cutover",
    domain: "api_key",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "api_key.cutover",
      resourceType: "api_key",
    },
    actorTypes: ["user", "system"],
    outcomes: ["success"],
    tenant: "metadata_organization_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["prefix", "organizationId", "familyId", "receiptId"],
    description:
      "An API key rotation overlap window was cut over; the old key was retired.",
  },
  {
    type: "api_key.revoked",
    domain: "api_key",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "api_key.revoked",
      resourceType: "api_key",
    },
    actorTypes: ["user", "system"],
    outcomes: ["success"],
    tenant: "metadata_organization_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["prefix", "organizationId", "revokedAt"],
    description: "A machine credential was withdrawn.",
  },
  // ------------------------------------------------------------- webhook ---
  {
    type: "webhook.delivery_replayed",
    domain: "webhook",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "webhook.delivery.replayed",
      resourceType: "webhookDelivery",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "actor_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["webhookId", "eventType", "eventId"],
    description:
      "An operator re-sent a webhook delivery; recorded before the dispatch, not after.",
  },
  // ------------------------------------------------------------ operator ---
  {
    type: "operator.organization_created",
    domain: "operator",
    store: "audit_log",
    match: { store: "audit_log", action: "CREATE", resourceType: "Organization" },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "resource_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["slug"],
    description: "An administrator created a tenant organisation.",
  },
  {
    type: "operator.organization_updated",
    domain: "operator",
    store: "audit_log",
    match: { store: "audit_log", action: "UPDATE", resourceType: "Organization" },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "resource_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["changes"],
    description: "An administrator changed a tenant organisation's profile.",
  },
  {
    type: "operator.organization_archived",
    domain: "operator",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "organization.archived",
      resourceType: "Organization",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "resource_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["archivedAt"],
    description:
      "An administrator archived an organization, disabling its keys, webhooks, issuer activation and attestation issuance.",
  },
  {
    type: "operator.organization_restored",
    domain: "operator",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "organization.restored",
      resourceType: "Organization",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "resource_id",
    writeFailure: "fail_closed",
    requiredMetadata: [],
    description:
      "An administrator restored an archived organization.",
  },
  {
    type: "operator.organization_legal_hold_placed",
    domain: "operator",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "organization.legal_hold_placed",
      resourceType: "Organization",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "resource_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["reference"],
    description:
      "An administrator placed a legal hold, which blocks deletion until released.",
  },
  {
    type: "operator.organization_legal_hold_released",
    domain: "operator",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "organization.legal_hold_released",
      resourceType: "Organization",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "resource_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["reference"],
    description:
      "An administrator released an organization's legal hold.",
  },
  {
    type: "operator.organization_deleted",
    domain: "operator",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "organization.deleted",
      resourceType: "Organization",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "resource_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["previousStatus", "apiKeysRevoked", "webhooksDeleted", "webhookDeliveriesDeleted", "idempotencyRecordsDeleted"],
    description:
      "An administrator deleted an archived organization after its dependency, legal-hold and retention checks passed.",
  },
  {
    type: "operator.payment_classification_updated",
    domain: "operator",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "payment.classification.updated",
      resourceType: "payment",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "actor_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["previousClassification", "nextClassification"],
    description:
      "A payment was reclassified, changing whether it counts towards income proofs.",
  },
  {
    type: "operator.trusted_source_created",
    domain: "operator",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "trusted_source.created",
      resourceType: "trusted_source",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "actor_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["sourceAddressHash", "sourceType"],
    description:
      "A payer was added to a user's trusted set; the address is recorded only as a hash.",
  },
  {
    type: "operator.trusted_source_updated",
    domain: "operator",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "trusted_source.updated",
      resourceType: "trusted_source",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "actor_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["displayNameChanged"],
    description: "A trusted payer's display metadata or issuer link changed.",
  },
  {
    type: "operator.trusted_source_deleted",
    domain: "operator",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "trusted_source.deleted",
      resourceType: "trusted_source",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "actor_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["sourceAddressHash", "retentionPolicy"],
    description:
      "A trusted payer was soft-deleted; history referencing it is retained.",
  },
  {
    type: "operator.user_status_changed",
    domain: "operator",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "user.status_changed",
      resourceType: "user",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "resource_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["previousStatus", "newStatus", "sessionsRevoked"],
    description:
      "An administrator moved an account between lifecycle states; suspension and revocation also revoke its sessions.",
  },
  {
    type: "operator.user_role_changed",
    domain: "operator",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "user.role_changed",
      resourceType: "user",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "resource_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["previousRole", "newRole"],
    description: "An administrator changed an account's global role.",
  },
  {
    type: "operator.payment_backfill_requested",
    domain: "operator",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "payment_backfill.requested",
      resourceType: "payment_backfill",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "actor_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["startLedger", "endLedger"],
    description:
      "An administrator queued a ledger-range rescan of a user's incoming payments.",
  },
  {
    type: "operator.payment_backfill_cancelled",
    domain: "operator",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "payment_backfill.cancelled",
      resourceType: "payment_backfill",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "actor_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["previousStatus"],
    description:
      "An administrator cancelled a payment backfill; committed pages are kept.",
  },
];

/** Every domain the taxonomy is required to cover. */
export const REQUIRED_AUDIT_DOMAINS: readonly AuditDomain[] = [
  "authentication",
  "authorization",
  "issuer",
  "proof",
  "api_key",
  "webhook",
  "operator",
];

/** Lookup by stable type. */
export function auditEvent(type: string): AuditEventDefinition {
  const found = AUDIT_EVENTS.find((event) => event.type === type);
  if (!found) {
    throw new Error(
      `Unknown audit event type "${type}". Declare it in src/common/audit/audit-taxonomy.ts.`,
    );
  }
  return found;
}

/** The shape of a persisted `AuditLog` row, as far as identification needs it. */
export interface PersistedAuditLogRow {
  action: string;
  resourceType: string;
}

/**
 * Maps a persisted `AuditLog` row back to its stable event type.
 *
 * Returns `undefined` for a row the taxonomy does not declare, which is what
 * the matrix test asserts against: an undeclared write is a coverage gap, not
 * an unknown-but-fine row.
 */
export function resolveAuditEventType(
  row: PersistedAuditLogRow,
): string | undefined {
  return AUDIT_EVENTS.find(
    (event) =>
      event.match.store === "audit_log" &&
      event.match.action === row.action &&
      event.match.resourceType === row.resourceType,
  )?.type;
}

/**
 * Normalises a persisted `actorType` to the taxonomy's spelling.
 *
 * The store holds two spellings of the same actor: the earliest writers
 * (issuers, organizations) persist `"User"`, later ones persist `"user"`. Both
 * mean the same principal, and a consumer filtering on one of them silently
 * loses the other — which is exactly the kind of hole an audit query must not
 * have. Normalising on read keeps every existing row queryable; normalising on
 * write would need a migration over historical rows and is deliberately not
 * done here.
 */
export function normalizeAuditActorType(actorType: string): string {
  return actorType.toLowerCase();
}

/** Maps a persisted `AuthAuditEvent` type back to its stable event type. */
export function resolveAuthAuditEventType(
  eventType: AuthEventType,
): string | undefined {
  return AUDIT_EVENTS.find(
    (event) =>
      event.match.store === "auth_audit_event" &&
      event.match.eventType === eventType,
  )?.type;
}

/** Classifies a verification outcome as an allow or a refusal. */
export function verificationOutcomeToAuditOutcome(
  outcome: VerificationOutcome,
): AuditOutcome {
  return outcome === VerificationOutcome.VALID ? "success" : "denied";
}

// ---------------------------------------------------------------------------
// Audit Correlation Graph Types (#283)
// ---------------------------------------------------------------------------

export type AuditMissingLinkReason =
  | "RETENTION_EXPIRED"
  | "CROSS_TENANT_BLOCKED"
  | "NOT_FOUND"
  | "DEPTH_LIMIT_REACHED";

export interface AuditCorrelationGraphNode {
  id: string;
  action: string;
  domain?: string;
  actorType: string;
  actorId: string | null;
  resourceType: string;
  resourceId: string | null;
  correlationId: string | null;
  parentId: string | null;
  depth: number;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

export interface AuditCorrelationEdge {
  fromNodeId: string;
  toNodeId: string;
  relationship: "PARENT" | "CHILD" | "CORRELATION";
}

export interface AuditMissingLink {
  sourceNodeId: string;
  targetId: string;
  reason: AuditMissingLinkReason;
}
