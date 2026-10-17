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
  /** `AuditLog.resourceId` is itself the tenant (the organisation row). */
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
      "A machine credential's secret was replaced; the old secret stopped working immediately.",
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
    actorTypes: ["user"],
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
  // ─────────────────────────── compatibility assessment ──────────────────
  {
    type: "proof.compatibility_assessment_triggered",
    domain: "proof",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "compatibility_assessment.triggered",
      resourceType: "proof",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "actor_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["assessmentId", "proofId", "artifactVersion"],
    description:
      "An ADMIN triggered a contract upgrade compatibility assessment for a proof.",
  },
  {
    type: "proof.compatibility_assessment_complete",
    domain: "proof",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "compatibility_assessment.complete",
      resourceType: "proof",
    },
    actorTypes: ["user"],
    outcomes: ["success"],
    tenant: "actor_id",
    writeFailure: "fail_closed",
    requiredMetadata: [
      "assessmentId",
      "proofId",
      "findingsHash",
      "hasBlockingFindings",
    ],
    description:
      "A compatibility assessment completed; findings are immutable from this point.",
  },
  {
    type: "proof.compatibility_assessment_failed",
    domain: "proof",
    store: "audit_log",
    match: {
      store: "audit_log",
      action: "compatibility_assessment.failed",
      resourceType: "proof",
    },
    actorTypes: ["user"],
    outcomes: ["denied"],
    tenant: "actor_id",
    writeFailure: "fail_closed",
    requiredMetadata: ["assessmentId", "proofId"],
    description: "A compatibility assessment failed; a retry is required.",
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
