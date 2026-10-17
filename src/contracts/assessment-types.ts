/**
 * Core value types for contract upgrade compatibility assessments.
 *
 * These types are shared between the job worker, the service layer, the
 * governance module, and test fixtures.  No NestJS decorators here — this file
 * must remain importable in pure-unit tests without a DI container.
 */

export const ASSESSMENT_VERSION = "earnproof.compat-assessment.v1" as const;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * The five canonical compatibility dimensions that every upgrade is assessed
 * against. Unknown checks outside this set block automatic approval per the
 * acceptance criteria.
 */
export const CheckKind = {
  /** Application Binary Interface — function signatures, argument types. */
  ABI: "ABI",
  /** On-chain storage layout — slot assignments, type widths. */
  STORAGE: "STORAGE",
  /** Off-chain package or library dependency changes. */
  DEPENDENCY: "DEPENDENCY",
  /** Client SDK / API surface compatibility. */
  CLIENT: "CLIENT",
  /** Data migration requirements between versions. */
  MIGRATION: "MIGRATION",
} as const;

export type CheckKindValue = (typeof CheckKind)[keyof typeof CheckKind];

/** All valid check kinds as a frozen set, used in validation. */
export const KNOWN_CHECK_KINDS = new Set<string>(Object.values(CheckKind));

/**
 * Severity of a single compatibility finding.
 *
 * BLOCKING — approval gates must reject the upgrade automatically.
 * WARNING   — human review required before approval.
 * INFO      — informational; does not prevent automatic approval.
 */
export const FindingSeverity = {
  BLOCKING: "BLOCKING",
  WARNING: "WARNING",
  INFO: "INFO",
} as const;

export type FindingSeverityValue =
  (typeof FindingSeverity)[keyof typeof FindingSeverity];

// ---------------------------------------------------------------------------
// Finding shape
// ---------------------------------------------------------------------------

/**
 * A single compatibility finding produced by one check.
 *
 * Every finding includes a stable `checkKind` and a deterministic `hash`
 * computed over its canonical content so the full findings corpus can be
 * fingerprinted.
 */
export interface CompatibilityFinding {
  /** Which check produced this finding. */
  checkKind: CheckKindValue;
  /** Severity rating. */
  severity: FindingSeverityValue;
  /** Human-readable description of the finding. */
  description: string;
  /**
   * Stable SHA-256 hex digest of the canonical finding body.
   * Computed by the worker; callers should treat it as opaque.
   */
  hash: string;
  /** Optional structured evidence attached to the finding. */
  evidence?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Signed artifact type
// ---------------------------------------------------------------------------

/**
 * The signed artifact envelope passed to the compatibility checker.
 *
 * Only schema-derived metadata is used; raw bytecode and private material are
 * never stored or passed through.
 */
export interface SignedArtifact {
  /** Identifier of the proof or credential this artifact belongs to. */
  proofId: string;
  /** Schema version string, e.g. "1". */
  schemaVersion: string;
  /** Credential hash of the artifact (sha256:… form). */
  credentialHash: string;
  /** Public ABI surface — function names and their argument/return descriptors. */
  abi: AbiEntry[];
  /** Storage slot manifest. */
  storage: StorageSlot[];
  /** Declared runtime dependencies. */
  dependencies: DependencyEntry[];
  /** Declared client-surface contracts. */
  clientContracts: ClientContractEntry[];
  /** Migration hints between this version and the previous one. */
  migrationNotes: MigrationNote[];
}

/** A single ABI function entry. */
export interface AbiEntry {
  name: string;
  inputs: string[];
  outputs: string[];
}

/** A single storage slot declaration. */
export interface StorageSlot {
  slot: string;
  type: string;
  mutable: boolean;
}

/** An off-chain dependency declaration. */
export interface DependencyEntry {
  name: string;
  version: string;
  breaking: boolean;
}

/** A client-facing contract surface entry. */
export interface ClientContractEntry {
  contractId: string;
  version: string;
  deprecated: boolean;
}

/** A migration note describing schema changes. */
export interface MigrationNote {
  fromVersion: string;
  toVersion: string;
  migration: string;
  approvedBy: string;
}
