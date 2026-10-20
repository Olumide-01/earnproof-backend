/**
 * Compatibility checker — five deterministic, pure check functions.
 *
 * Each check accepts a `SignedArtifact` (current version) and an optional
 * "previous" snapshot, and returns an array of `CompatibilityFinding` objects.
 *
 * Design principles:
 * - Pure functions: no I/O, no randomness, no side-effects.
 * - Deterministic: identical inputs always produce identical findings in the
 *   same order, so the final findingsHash is stable across re-runs.
 * - Untrusted artifacts: all inputs are validated before processing; the
 *   checker never executes artifact bytecode.
 * - Unknown check kinds block automatic approval per the acceptance criteria.
 */

import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import {
  AbiEntry,
  CheckKind,
  CompatibilityFinding,
  FindingSeverity,
  SignedArtifact,
  StorageSlot,
} from "./assessment-types";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a finding and compute its deterministic hash. */
function makeFinding(
  base: Omit<CompatibilityFinding, "hash">,
): CompatibilityFinding {
  const body = canonicalize({
    checkKind: base.checkKind,
    severity: base.severity,
    description: base.description,
    evidence: base.evidence ?? null,
  });
  return { ...base, hash: `sha256:${sha256(body)}` };
}

// ---------------------------------------------------------------------------
// ABI compatibility
// ---------------------------------------------------------------------------

/**
 * ABI check — detects removed functions, added required parameters, and
 * removed output fields that would break callers.
 *
 * A brand-new artifact (no `previous`) gets a clean INFO finding confirming the
 * baseline was recorded rather than silently passing.
 */
export function checkAbi(
  current: SignedArtifact,
  previous: SignedArtifact | null,
): CompatibilityFinding[] {
  if (!previous) {
    return [
      makeFinding({
        checkKind: CheckKind.ABI,
        severity: FindingSeverity.INFO,
        description: "No previous ABI snapshot; current ABI recorded as baseline.",
      }),
    ];
  }

  const findings: CompatibilityFinding[] = [];
  const currentByName = new Map<string, AbiEntry>(
    current.abi.map((e) => [e.name, e]),
  );
  const previousByName = new Map<string, AbiEntry>(
    previous.abi.map((e) => [e.name, e]),
  );

  // Removed functions → BLOCKING
  for (const [name] of previousByName) {
    if (!currentByName.has(name)) {
      findings.push(
        makeFinding({
          checkKind: CheckKind.ABI,
          severity: FindingSeverity.BLOCKING,
          description: `ABI function "${name}" was removed — existing callers will break.`,
          evidence: { removedFunction: name },
        }),
      );
    }
  }

  // Added inputs or removed outputs → BLOCKING
  for (const [name, prev] of previousByName) {
    const curr = currentByName.get(name);
    if (!curr) continue; // already reported as removed

    if (curr.inputs.length > prev.inputs.length) {
      findings.push(
        makeFinding({
          checkKind: CheckKind.ABI,
          severity: FindingSeverity.BLOCKING,
          description: `ABI function "${name}" gained ${curr.inputs.length - prev.inputs.length} input(s) — callers must be updated.`,
          evidence: { function: name, previousInputCount: prev.inputs.length, currentInputCount: curr.inputs.length },
        }),
      );
    }

    if (curr.outputs.length < prev.outputs.length) {
      findings.push(
        makeFinding({
          checkKind: CheckKind.ABI,
          severity: FindingSeverity.BLOCKING,
          description: `ABI function "${name}" lost ${prev.outputs.length - curr.outputs.length} output(s) — callers relying on them will break.`,
          evidence: { function: name, previousOutputCount: prev.outputs.length, currentOutputCount: curr.outputs.length },
        }),
      );
    }
  }

  // Added functions → INFO
  for (const [name] of currentByName) {
    if (!previousByName.has(name)) {
      findings.push(
        makeFinding({
          checkKind: CheckKind.ABI,
          severity: FindingSeverity.INFO,
          description: `ABI function "${name}" was added (additive change).`,
          evidence: { addedFunction: name },
        }),
      );
    }
  }

  if (findings.length === 0) {
    findings.push(
      makeFinding({
        checkKind: CheckKind.ABI,
        severity: FindingSeverity.INFO,
        description: "ABI is backward-compatible with previous version.",
      }),
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Storage compatibility
// ---------------------------------------------------------------------------

/**
 * Storage check — detects removed slots, type changes, and mutability widening.
 *
 * Slot removal and type changes are BLOCKING; mutability changes are WARNING.
 */
export function checkStorage(
  current: SignedArtifact,
  previous: SignedArtifact | null,
): CompatibilityFinding[] {
  if (!previous) {
    return [
      makeFinding({
        checkKind: CheckKind.STORAGE,
        severity: FindingSeverity.INFO,
        description: "No previous storage snapshot; current layout recorded as baseline.",
      }),
    ];
  }

  const findings: CompatibilityFinding[] = [];
  const currentBySlot = new Map<string, StorageSlot>(
    current.storage.map((s) => [s.slot, s]),
  );
  const previousBySlot = new Map<string, StorageSlot>(
    previous.storage.map((s) => [s.slot, s]),
  );

  for (const [slot, prev] of previousBySlot) {
    const curr = currentBySlot.get(slot);
    if (!curr) {
      findings.push(
        makeFinding({
          checkKind: CheckKind.STORAGE,
          severity: FindingSeverity.BLOCKING,
          description: `Storage slot "${slot}" was removed — existing on-chain state is no longer readable.`,
          evidence: { slot, previousType: prev.type },
        }),
      );
      continue;
    }

    if (curr.type !== prev.type) {
      findings.push(
        makeFinding({
          checkKind: CheckKind.STORAGE,
          severity: FindingSeverity.BLOCKING,
          description: `Storage slot "${slot}" type changed from "${prev.type}" to "${curr.type}" — data reinterpretation hazard.`,
          evidence: { slot, previousType: prev.type, currentType: curr.type },
        }),
      );
    }

    if (!prev.mutable && curr.mutable) {
      findings.push(
        makeFinding({
          checkKind: CheckKind.STORAGE,
          severity: FindingSeverity.WARNING,
          description: `Storage slot "${slot}" changed from immutable to mutable — invariant may be violated.`,
          evidence: { slot },
        }),
      );
    }
  }

  if (findings.length === 0) {
    findings.push(
      makeFinding({
        checkKind: CheckKind.STORAGE,
        severity: FindingSeverity.INFO,
        description: "Storage layout is compatible with previous version.",
      }),
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Dependency compatibility
// ---------------------------------------------------------------------------

/**
 * Dependency check — surfaces declared breaking dependency upgrades.
 *
 * A dependency entry marked `breaking: true` maps to WARNING (the artifact
 * declared the break intentionally).  An undeclared breaking version change
 * (semver major bump without the `breaking` flag) maps to BLOCKING.
 */
export function checkDependencies(
  current: SignedArtifact,
): CompatibilityFinding[] {
  const findings: CompatibilityFinding[] = [];

  for (const dep of current.dependencies) {
    if (dep.breaking) {
      findings.push(
        makeFinding({
          checkKind: CheckKind.DEPENDENCY,
          severity: FindingSeverity.WARNING,
          description: `Dependency "${dep.name}@${dep.version}" is declared as a breaking change.`,
          evidence: { name: dep.name, version: dep.version },
        }),
      );
    }
  }

  // Detect undeclared major version bumps in semver-like versions
  for (const dep of current.dependencies) {
    if (!dep.breaking && looksLikeMajorBump(dep.version)) {
      findings.push(
        makeFinding({
          checkKind: CheckKind.DEPENDENCY,
          severity: FindingSeverity.BLOCKING,
          description: `Dependency "${dep.name}" version "${dep.version}" appears to be a major bump but is not declared as breaking.`,
          evidence: { name: dep.name, version: dep.version },
        }),
      );
    }
  }

  if (findings.length === 0) {
    findings.push(
      makeFinding({
        checkKind: CheckKind.DEPENDENCY,
        severity: FindingSeverity.INFO,
        description: "No breaking dependency changes declared.",
      }),
    );
  }

  return findings;
}

/**
 * Returns true if a version string looks like a semver major (v2, 3.0.0, etc.)
 * without being the initial 1.x release.  Heuristic only — not a semver parser.
 */
function looksLikeMajorBump(version: string): boolean {
  const match = /^v?(\d+)\./.exec(version);
  if (!match) return false;
  const major = parseInt(match[1], 10);
  return major >= 2;
}

// ---------------------------------------------------------------------------
// Client compatibility
// ---------------------------------------------------------------------------

/**
 * Client check — flags deprecated client contract surfaces.
 *
 * Deprecated entries are WARNING; a deprecated entry that was previously not
 * deprecated is BLOCKING (deprecation cannot be silently added without notice).
 */
export function checkClientContracts(
  current: SignedArtifact,
  previous: SignedArtifact | null,
): CompatibilityFinding[] {
  const findings: CompatibilityFinding[] = [];
  const previousDeprecated = new Set<string>(
    (previous?.clientContracts ?? [])
      .filter((c) => c.deprecated)
      .map((c) => c.contractId),
  );
  const previousById = new Map(
    (previous?.clientContracts ?? []).map((c) => [c.contractId, c]),
  );

  for (const contract of current.clientContracts) {
    const prev = previousById.get(contract.contractId);

    if (contract.deprecated && prev && !prev.deprecated) {
      findings.push(
        makeFinding({
          checkKind: CheckKind.CLIENT,
          severity: FindingSeverity.BLOCKING,
          description: `Client contract "${contract.contractId}" was newly deprecated without a migration path declared — existing clients will break on the next removal.`,
          evidence: { contractId: contract.contractId, version: contract.version },
        }),
      );
    } else if (contract.deprecated && previousDeprecated.has(contract.contractId)) {
      findings.push(
        makeFinding({
          checkKind: CheckKind.CLIENT,
          severity: FindingSeverity.WARNING,
          description: `Client contract "${contract.contractId}" remains deprecated — ensure consumers have migrated before removal.`,
          evidence: { contractId: contract.contractId },
        }),
      );
    }
  }

  if (findings.length === 0) {
    findings.push(
      makeFinding({
        checkKind: CheckKind.CLIENT,
        severity: FindingSeverity.INFO,
        description: "No client contract compatibility issues detected.",
      }),
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Migration compatibility
// ---------------------------------------------------------------------------

/**
 * Migration check — verifies every migration note is complete and has an approver.
 *
 * An empty migration note or a missing approver is BLOCKING; a well-formed note
 * gets an INFO finding confirming it was validated.
 */
export function checkMigration(
  current: SignedArtifact,
): CompatibilityFinding[] {
  const findings: CompatibilityFinding[] = [];

  if (current.migrationNotes.length === 0) {
    findings.push(
      makeFinding({
        checkKind: CheckKind.MIGRATION,
        severity: FindingSeverity.INFO,
        description: "No migration notes declared; no data migration required.",
      }),
    );
    return findings;
  }

  for (const note of current.migrationNotes) {
    if (!note.migration || note.migration.trim().length === 0) {
      findings.push(
        makeFinding({
          checkKind: CheckKind.MIGRATION,
          severity: FindingSeverity.BLOCKING,
          description: `Migration note from "${note.fromVersion}" to "${note.toVersion}" has an empty migration description.`,
          evidence: { fromVersion: note.fromVersion, toVersion: note.toVersion },
        }),
      );
    } else if (!note.approvedBy || note.approvedBy.trim().length === 0) {
      findings.push(
        makeFinding({
          checkKind: CheckKind.MIGRATION,
          severity: FindingSeverity.BLOCKING,
          description: `Migration note from "${note.fromVersion}" to "${note.toVersion}" is missing an approver.`,
          evidence: { fromVersion: note.fromVersion, toVersion: note.toVersion },
        }),
      );
    } else {
      findings.push(
        makeFinding({
          checkKind: CheckKind.MIGRATION,
          severity: FindingSeverity.INFO,
          description: `Migration from "${note.fromVersion}" to "${note.toVersion}" is documented and approved by "${note.approvedBy}".`,
          evidence: { fromVersion: note.fromVersion, toVersion: note.toVersion, approvedBy: note.approvedBy },
        }),
      );
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Aggregate entry point
// ---------------------------------------------------------------------------

/**
 * Run all five compatibility checks over a signed artifact.
 *
 * Findings are returned sorted by (checkKind ASC, severity DESC, hash ASC) for
 * deterministic ordering so the findingsHash is stable across re-runs.
 *
 * @param current  The artifact being assessed.
 * @param previous A previous snapshot of the same proof, or null for a
 *                 first-run baseline.
 */
export function runCompatibilityChecks(
  current: SignedArtifact,
  previous: SignedArtifact | null,
): CompatibilityFinding[] {
  const all: CompatibilityFinding[] = [
    ...checkAbi(current, previous),
    ...checkStorage(current, previous),
    ...checkDependencies(current),
    ...checkClientContracts(current, previous),
    ...checkMigration(current),
  ];

  const SEVERITY_ORDER: Record<string, number> = {
    BLOCKING: 0,
    WARNING: 1,
    INFO: 2,
  };

  return all.sort((a, b) => {
    if (a.checkKind !== b.checkKind)
      return a.checkKind < b.checkKind ? -1 : 1;
    const sa = SEVERITY_ORDER[a.severity] ?? 99;
    const sb = SEVERITY_ORDER[b.severity] ?? 99;
    if (sa !== sb) return sa - sb;
    return a.hash < b.hash ? -1 : 1;
  });
}
