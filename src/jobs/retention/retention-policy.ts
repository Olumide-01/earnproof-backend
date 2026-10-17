/**
 * Retention classes and their durations.
 *
 * Each class answers four questions an auditor will ask: what the records are
 * for, how long they are kept, who owns that decision, and what happens at the
 * end — deletion or anonymisation.
 *
 * The full rationale is in `docs/data-retention.md`. This file is the
 * executable half; the two must change together.
 *
 * Durations are configurable per class so an operator can tighten retention
 * without a deploy, but every class has a default that is safe on its own. A
 * missing environment variable must never mean "keep forever".
 */

/** What happens to a record when its retention period ends. */
export enum DisposalMethod {
  /** The row is removed. Used where the record has no residual value. */
  DELETE = "delete",
  /**
   * Identifying columns are cleared while the row survives.
   *
   * Used where an aggregate remains useful — verification counts, delivery
   * success rates — but the link to a subject must not persist.
   */
  ANONYMISE = "anonymise",
}

/**
 * Whether a class may be swept at all.
 *
 * Proof credentials, revocation evidence, and anchoring state are deliberately
 * excluded from automated cleanup. They are the evidence the protocol exists to
 * produce: a proof that silently disappeared would be indistinguishable, to a
 * relying party, from one that was never issued.
 */
export enum SweepMode {
  /** Eligible for the automated cleanup job. */
  AUTOMATED = "automated",
  /**
   * Never touched by the job. Removal requires a deliberate, audited action.
   */
  PRESERVED = "preserved",
}

/** One retention class. */
export interface RetentionClass {
  /** Stable key, used in config and in metrics. */
  key: string;
  /** Prisma model the class governs. */
  model: string;
  /** What the records are for. */
  purpose: string;
  /** Team accountable for the duration. */
  owner: string;
  /** Default retention in days. */
  defaultDays: number;
  /** Environment variable overriding {@link defaultDays}. */
  envVar: string;
  /** Column the cutoff is measured against. */
  cutoffColumn: string;
  /** Index backing {@link cutoffColumn}, so the sweep stays bounded. */
  backingIndex: string;
  disposal: DisposalMethod;
  sweep: SweepMode;
  /** Why this class is preserved, when it is. */
  preservationReason?: string;
}

/**
 * Lower bound on any configured retention period.
 *
 * A zero or negative override would delete records the moment they were
 * written. Clamping rather than trusting configuration means a typo in an
 * environment variable cannot cause data loss.
 */
export const MINIMUM_RETENTION_DAYS = 1;

/** Upper bound, so an override cannot silently disable retention entirely. */
export const MAXIMUM_RETENTION_DAYS = 3_650;

/**
 * Every record class the service holds, including those that are never swept.
 *
 * Listing preserved classes here rather than omitting them is deliberate: an
 * auditor needs to see that the decision was made, not infer it from absence.
 */
export const RETENTION_CLASSES: readonly RetentionClass[] = [
  {
    key: "wallet_challenges",
    model: "WalletChallenge",
    purpose:
      "Single-use nonces proving wallet control during login. Valueless once " +
      "used or expired.",
    owner: "Platform engineering",
    defaultDays: 7,
    envVar: "RETENTION_WALLET_CHALLENGE_DAYS",
    cutoffColumn: "expiresAt",
    backingIndex: "@@index([expiresAt])",
    disposal: DisposalMethod.DELETE,
    sweep: SweepMode.AUTOMATED,
  },
  {
    key: "auth_sessions",
    model: "AuthSession",
    purpose:
      "Revocable bearer sessions. Only a token hash is stored; the raw token " +
      "never reaches the database.",
    owner: "Platform engineering",
    defaultDays: 30,
    envVar: "RETENTION_AUTH_SESSION_DAYS",
    cutoffColumn: "expiresAt",
    backingIndex: "@@index([expiresAt])",
    disposal: DisposalMethod.DELETE,
    sweep: SweepMode.AUTOMATED,
  },
  {
    key: "webhook_deliveries",
    model: "WebhookDelivery",
    purpose:
      "Delivery attempts and responses, retained so integrators can debug " +
      "missed events. Payloads may echo customer data.",
    owner: "Integrations engineering",
    defaultDays: 30,
    envVar: "RETENTION_WEBHOOK_DELIVERY_DAYS",
    cutoffColumn: "createdAt",
    backingIndex: "@@index([webhookId, createdAt])",
    disposal: DisposalMethod.DELETE,
    sweep: SweepMode.AUTOMATED,
  },
  {
    key: "verification_events",
    model: "VerificationEventLog",
    purpose:
      "Verification outcomes for abuse detection and rate analysis. Already " +
      "carries an explicit retainUntil set at write time.",
    owner: "Product engineering",
    defaultDays: 90,
    envVar: "VERIFICATION_EVENT_RETENTION_DAYS",
    cutoffColumn: "retainUntil",
    backingIndex: "@@index([retainUntil])",
    disposal: DisposalMethod.DELETE,
    sweep: SweepMode.AUTOMATED,
  },
  {
    key: "audit_logs",
    model: "AuditLog",
    purpose:
      "Administrative actions, retained for security review and incident " +
      "reconstruction.",
    owner: "Security",
    defaultDays: 365,
    envVar: "RETENTION_AUDIT_LOG_DAYS",
    cutoffColumn: "createdAt",
    backingIndex: "@@index([createdAt])",
    disposal: DisposalMethod.DELETE,
    sweep: SweepMode.AUTOMATED,
  },
  {
    key: "failed_anchoring_intents",
    model: "AnchoringIntent",
    purpose:
      "Permanently failed anchoring attempts. Retained long enough to " +
      "diagnose and requeue; the proof itself is unaffected.",
    owner: "Platform engineering",
    defaultDays: 90,
    envVar: "RETENTION_FAILED_ANCHORING_DAYS",
    cutoffColumn: "updatedAt",
    backingIndex: "@@index([nextRetryAt])",
    disposal: DisposalMethod.DELETE,
    sweep: SweepMode.AUTOMATED,
  },

  {
    key: "compatibility_assessments",
    model: "ContractCompatibilityAssessment",
    purpose:
      "Immutable compatibility findings bound to a proof version. Retained as " +
      "evidence that governance approval was preceded by a documented assessment.",
    owner: "Security",
    defaultDays: MAXIMUM_RETENTION_DAYS,
    envVar: "RETENTION_COMPAT_ASSESSMENT_DAYS",
    cutoffColumn: "createdAt",
    backingIndex: "@@index([proofId])",
    disposal: DisposalMethod.ANONYMISE,
    sweep: SweepMode.PRESERVED,
    preservationReason:
      "A completed assessment is governance evidence. Deleting it would remove " +
      "the audit trail showing that blocking findings were reviewed before approval.",
  },

  // ─── Preserved: never swept by the automated job ─────────────────────────
  {
    key: "proofs",
    model: "Proof",
    purpose: "Issued proof credentials. The protocol's primary evidence.",
    owner: "Product engineering",
    defaultDays: MAXIMUM_RETENTION_DAYS,
    envVar: "RETENTION_PROOF_DAYS",
    cutoffColumn: "expiresAt",
    backingIndex: "@@index([expiresAt])",
    disposal: DisposalMethod.ANONYMISE,
    sweep: SweepMode.PRESERVED,
    preservationReason:
      "An expired proof is not a deletable proof. A relying party holding a " +
      "credential must be able to learn that it expired or was revoked; a " +
      "proof that vanished is indistinguishable from one never issued. " +
      "Removal is a deliberate, audited operation, not a scheduled sweep.",
  },
  {
    key: "revocation_evidence",
    model: "Proof.revokedAt",
    purpose: "Record that a credential was revoked, and when.",
    owner: "Security",
    defaultDays: MAXIMUM_RETENTION_DAYS,
    envVar: "RETENTION_REVOCATION_DAYS",
    cutoffColumn: "revokedAt",
    backingIndex: "@@index([userId, status])",
    disposal: DisposalMethod.ANONYMISE,
    sweep: SweepMode.PRESERVED,
    preservationReason:
      "Revocation evidence outliving the credential is the point. Deleting it " +
      "would silently restore a revoked credential to apparent validity.",
  },
  {
    key: "anchoring_state",
    model: "AnchoringIntent (non-failed)",
    purpose: "Pending and confirmed on-chain anchoring state.",
    owner: "Platform engineering",
    defaultDays: MAXIMUM_RETENTION_DAYS,
    envVar: "RETENTION_ANCHORING_STATE_DAYS",
    cutoffColumn: "updatedAt",
    backingIndex: "@@index([proofId])",
    disposal: DisposalMethod.DELETE,
    sweep: SweepMode.PRESERVED,
    preservationReason:
      "Confirmed intents carry the transaction hash linking a proof to the " +
      "ledger. Pending intents are unfinished work. Deleting either loses the " +
      "record of what was anchored, or the work itself.",
  },
];

/** Retention classes the automated job is permitted to sweep. */
export const SWEEPABLE_CLASSES: readonly RetentionClass[] =
  RETENTION_CLASSES.filter((entry) => entry.sweep === SweepMode.AUTOMATED);

/** Raised when a configured retention override is unusable. */
export class RetentionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionConfigError";
  }
}

/**
 * Resolves the retention period for a class, applying an override if present.
 *
 * An unparseable or out-of-range override throws rather than falling back to
 * the default. A silent fallback would mean an operator who set a value
 * believes retention is tighter than it is — the failure mode that a retention
 * policy exists to prevent.
 */
export function resolveRetentionDays(
  entry: RetentionClass,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[entry.envVar];

  if (raw === undefined || raw.trim() === "") {
    return entry.defaultDays;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed)) {
    throw new RetentionConfigError(
      `${entry.envVar} must be a whole number of days, received "${raw}".`,
    );
  }

  if (parsed < MINIMUM_RETENTION_DAYS) {
    throw new RetentionConfigError(
      `${entry.envVar} must be at least ${MINIMUM_RETENTION_DAYS} day; ` +
        `${parsed} would delete records as soon as they are written.`,
    );
  }

  if (parsed > MAXIMUM_RETENTION_DAYS) {
    throw new RetentionConfigError(
      `${entry.envVar} must not exceed ${MAXIMUM_RETENTION_DAYS} days; ` +
        `${parsed} effectively disables retention for ${entry.key}.`,
    );
  }

  return parsed;
}

/**
 * The cutoff instant for a class: records older than this are eligible.
 *
 * `now` is injected so tests can pin the boundary exactly. Boundary behaviour
 * is `<` rather than `<=`: a record whose cutoff column equals the instant is
 * retained, so a record is never removed on the exact day its period ends.
 */
export function cutoffFor(
  entry: RetentionClass,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): Date {
  const days = resolveRetentionDays(entry, env);
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);
}
