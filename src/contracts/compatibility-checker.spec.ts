/**
 * Unit tests for compatibility-checker.ts
 *
 * Coverage:
 *  - Positive: clean artifact passes all checks with INFO findings.
 *  - Negative: each check produces BLOCKING findings for known violations.
 *  - Boundary: edge cases (empty arrays, duplicate hash uniqueness).
 *  - Regression: deterministic hash stability — same input → same hash.
 *  - Unknown check kind detection via KNOWN_CHECK_KINDS.
 *
 * Uses only synthetic fixtures — no DB, no I/O.
 */

import {
  buildSignedArtifact,
} from "../testing/factories";
import {
  CheckKind,
  FindingSeverity,
  KNOWN_CHECK_KINDS,
} from "./assessment-types";
import {
  checkAbi,
  checkClientContracts,
  checkDependencies,
  checkMigration,
  checkStorage,
  runCompatibilityChecks,
} from "./compatibility-checker";

const PROOF_ID = "test-proof-id-001";

// ---------------------------------------------------------------------------
// ABI check
// ---------------------------------------------------------------------------

describe("checkAbi()", () => {
  it("returns INFO baseline finding when no previous snapshot", () => {
    const current = buildSignedArtifact(1, PROOF_ID);
    const findings = checkAbi(current, null);

    expect(findings).toHaveLength(1);
    expect(findings[0].checkKind).toBe(CheckKind.ABI);
    expect(findings[0].severity).toBe(FindingSeverity.INFO);
    expect(findings[0].description).toMatch(/baseline/);
  });

  it("returns INFO clean finding when ABI is unchanged", () => {
    const current = buildSignedArtifact(1, PROOF_ID);
    const findings = checkAbi(current, current);

    expect(findings.every((f) => f.severity === FindingSeverity.INFO)).toBe(true);
  });

  it("produces BLOCKING finding when a function is removed", () => {
    const previous = buildSignedArtifact(1, PROOF_ID, {
      abi: [
        { name: "register_proof", inputs: ["proofId"], outputs: ["bool"] },
        { name: "revoke_proof", inputs: ["proofId"], outputs: ["bool"] },
      ],
    });
    const current = buildSignedArtifact(1, PROOF_ID, {
      abi: [{ name: "register_proof", inputs: ["proofId"], outputs: ["bool"] }],
    });

    const findings = checkAbi(current, previous);
    const blocking = findings.filter((f) => f.severity === FindingSeverity.BLOCKING);

    expect(blocking.length).toBeGreaterThanOrEqual(1);
    expect(blocking.some((f) => f.description.includes("revoke_proof"))).toBe(true);
  });

  it("produces BLOCKING finding when a required input is added", () => {
    const previous = buildSignedArtifact(1, PROOF_ID, {
      abi: [{ name: "register_proof", inputs: ["proofId"], outputs: ["bool"] }],
    });
    const current = buildSignedArtifact(1, PROOF_ID, {
      abi: [{ name: "register_proof", inputs: ["proofId", "nonce"], outputs: ["bool"] }],
    });

    const findings = checkAbi(current, previous);
    const blocking = findings.filter((f) => f.severity === FindingSeverity.BLOCKING);

    expect(blocking.length).toBeGreaterThanOrEqual(1);
    expect(blocking[0].description).toMatch(/input/i);
  });

  it("produces BLOCKING finding when an output is removed", () => {
    const previous = buildSignedArtifact(1, PROOF_ID, {
      abi: [{ name: "register_proof", inputs: [], outputs: ["bool", "string"] }],
    });
    const current = buildSignedArtifact(1, PROOF_ID, {
      abi: [{ name: "register_proof", inputs: [], outputs: ["bool"] }],
    });

    const findings = checkAbi(current, previous);
    const blocking = findings.filter((f) => f.severity === FindingSeverity.BLOCKING);

    expect(blocking.length).toBeGreaterThanOrEqual(1);
  });

  it("produces INFO finding when a new function is added", () => {
    const previous = buildSignedArtifact(1, PROOF_ID, {
      abi: [{ name: "register_proof", inputs: ["proofId"], outputs: ["bool"] }],
    });
    const current = buildSignedArtifact(1, PROOF_ID, {
      abi: [
        { name: "register_proof", inputs: ["proofId"], outputs: ["bool"] },
        { name: "get_proof", inputs: ["proofId"], outputs: ["string"] },
      ],
    });

    const findings = checkAbi(current, previous);
    const added = findings.filter((f) => f.description.includes("get_proof"));

    expect(added.length).toBeGreaterThanOrEqual(1);
    expect(added[0].severity).toBe(FindingSeverity.INFO);
  });

  it("produces deterministic hashes — same input yields same hash", () => {
    const artifact = buildSignedArtifact(42, PROOF_ID);
    const r1 = checkAbi(artifact, null);
    const r2 = checkAbi(artifact, null);

    expect(r1[0].hash).toBe(r2[0].hash);
  });
});

// ---------------------------------------------------------------------------
// Storage check
// ---------------------------------------------------------------------------

describe("checkStorage()", () => {
  it("returns INFO baseline finding when no previous snapshot", () => {
    const findings = checkStorage(buildSignedArtifact(1, PROOF_ID), null);
    expect(findings[0].severity).toBe(FindingSeverity.INFO);
    expect(findings[0].description).toMatch(/baseline/);
  });

  it("returns INFO clean finding when storage is unchanged", () => {
    const artifact = buildSignedArtifact(1, PROOF_ID);
    const findings = checkStorage(artifact, artifact);
    expect(findings.every((f) => f.severity === FindingSeverity.INFO)).toBe(true);
  });

  it("produces BLOCKING finding when a slot is removed", () => {
    const previous = buildSignedArtifact(1, PROOF_ID, {
      storage: [
        { slot: "0x00", type: "bytes32", mutable: false },
        { slot: "0x01", type: "address", mutable: false },
      ],
    });
    const current = buildSignedArtifact(1, PROOF_ID, {
      storage: [{ slot: "0x00", type: "bytes32", mutable: false }],
    });

    const findings = checkStorage(current, previous);
    const blocking = findings.filter((f) => f.severity === FindingSeverity.BLOCKING);
    expect(blocking.some((f) => f.description.includes("0x01"))).toBe(true);
  });

  it("produces BLOCKING finding when slot type changes", () => {
    const previous = buildSignedArtifact(1, PROOF_ID, {
      storage: [{ slot: "0x00", type: "bytes32", mutable: false }],
    });
    const current = buildSignedArtifact(1, PROOF_ID, {
      storage: [{ slot: "0x00", type: "uint256", mutable: false }],
    });

    const findings = checkStorage(current, previous);
    const blocking = findings.filter((f) => f.severity === FindingSeverity.BLOCKING);
    expect(blocking.length).toBeGreaterThanOrEqual(1);
    expect(blocking[0].description).toMatch(/type changed/i);
  });

  it("produces WARNING when immutable slot becomes mutable", () => {
    const previous = buildSignedArtifact(1, PROOF_ID, {
      storage: [{ slot: "0x00", type: "bytes32", mutable: false }],
    });
    const current = buildSignedArtifact(1, PROOF_ID, {
      storage: [{ slot: "0x00", type: "bytes32", mutable: true }],
    });

    const findings = checkStorage(current, previous);
    const warnings = findings.filter((f) => f.severity === FindingSeverity.WARNING);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0].description).toMatch(/mutable/i);
  });
});

// ---------------------------------------------------------------------------
// Dependency check
// ---------------------------------------------------------------------------

describe("checkDependencies()", () => {
  it("returns INFO when no breaking dependencies are declared", () => {
    const artifact = buildSignedArtifact(1, PROOF_ID, { dependencies: [{ name: "@stellar/sdk", version: "1.5.0", breaking: false }] });
    const findings = checkDependencies(artifact);
    expect(findings.every((f) => f.severity === FindingSeverity.INFO)).toBe(true);
  });

  it("produces WARNING when a dependency is declared as breaking", () => {
    const artifact = buildSignedArtifact(1, PROOF_ID, {
      dependencies: [{ name: "@stellar/sdk", version: "12.0.0", breaking: true }],
    });
    const findings = checkDependencies(artifact);
    const warnings = findings.filter((f) => f.severity === FindingSeverity.WARNING);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("produces BLOCKING when a major semver bump is not declared as breaking", () => {
    const artifact = buildSignedArtifact(1, PROOF_ID, {
      dependencies: [{ name: "@stellar/sdk", version: "3.0.0", breaking: false }],
    });
    const findings = checkDependencies(artifact);
    const blocking = findings.filter((f) => f.severity === FindingSeverity.BLOCKING);
    expect(blocking.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT block for v1.x non-breaking", () => {
    const artifact = buildSignedArtifact(1, PROOF_ID, {
      dependencies: [{ name: "@stellar/sdk", version: "1.5.0", breaking: false }],
    });
    const findings = checkDependencies(artifact);
    expect(findings.every((f) => f.severity !== FindingSeverity.BLOCKING)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Client contracts check
// ---------------------------------------------------------------------------

describe("checkClientContracts()", () => {
  it("returns INFO when all contracts are active and unchanged", () => {
    const artifact = buildSignedArtifact(1, PROOF_ID);
    const findings = checkClientContracts(artifact, null);
    expect(findings.every((f) => f.severity === FindingSeverity.INFO)).toBe(true);
  });

  it("produces BLOCKING when a contract is newly deprecated", () => {
    const previous = buildSignedArtifact(1, PROOF_ID, {
      clientContracts: [{ contractId: "earn.v1", version: "1", deprecated: false }],
    });
    const current = buildSignedArtifact(1, PROOF_ID, {
      clientContracts: [{ contractId: "earn.v1", version: "1", deprecated: true }],
    });

    const findings = checkClientContracts(current, previous);
    const blocking = findings.filter((f) => f.severity === FindingSeverity.BLOCKING);
    expect(blocking.length).toBeGreaterThanOrEqual(1);
    expect(blocking[0].description).toMatch(/newly deprecated/i);
  });

  it("produces WARNING when a previously deprecated contract remains deprecated", () => {
    const previous = buildSignedArtifact(1, PROOF_ID, {
      clientContracts: [{ contractId: "earn.v1", version: "1", deprecated: true }],
    });
    const current = buildSignedArtifact(1, PROOF_ID, {
      clientContracts: [{ contractId: "earn.v1", version: "1", deprecated: true }],
    });

    const findings = checkClientContracts(current, previous);
    const warnings = findings.filter((f) => f.severity === FindingSeverity.WARNING);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Migration check
// ---------------------------------------------------------------------------

describe("checkMigration()", () => {
  it("returns INFO when no migration notes are declared", () => {
    const artifact = buildSignedArtifact(1, PROOF_ID, { migrationNotes: [] });
    const findings = checkMigration(artifact);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe(FindingSeverity.INFO);
    expect(findings[0].description).toMatch(/no migration notes/i);
  });

  it("produces BLOCKING when migration description is empty", () => {
    const artifact = buildSignedArtifact(1, PROOF_ID, {
      migrationNotes: [
        { fromVersion: "1", toVersion: "2", migration: "", approvedBy: "alice" },
      ],
    });
    const findings = checkMigration(artifact);
    const blocking = findings.filter((f) => f.severity === FindingSeverity.BLOCKING);
    expect(blocking.length).toBeGreaterThanOrEqual(1);
    expect(blocking[0].description).toMatch(/empty/i);
  });

  it("produces BLOCKING when approvedBy is missing", () => {
    const artifact = buildSignedArtifact(1, PROOF_ID, {
      migrationNotes: [
        { fromVersion: "1", toVersion: "2", migration: "run migrate.sql", approvedBy: "" },
      ],
    });
    const findings = checkMigration(artifact);
    const blocking = findings.filter((f) => f.severity === FindingSeverity.BLOCKING);
    expect(blocking.length).toBeGreaterThanOrEqual(1);
    expect(blocking[0].description).toMatch(/approver/i);
  });

  it("produces INFO for a well-formed migration note", () => {
    const artifact = buildSignedArtifact(1, PROOF_ID, {
      migrationNotes: [
        {
          fromVersion: "1",
          toVersion: "2",
          migration: "run migrate.sql to rename column",
          approvedBy: "alice@example.com",
        },
      ],
    });
    const findings = checkMigration(artifact);
    expect(findings.every((f) => f.severity === FindingSeverity.INFO)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runCompatibilityChecks — aggregate
// ---------------------------------------------------------------------------

describe("runCompatibilityChecks()", () => {
  it("runs all five check kinds and returns sorted findings", () => {
    const artifact = buildSignedArtifact(1, PROOF_ID);
    const findings = runCompatibilityChecks(artifact, null);

    const kinds = new Set(findings.map((f) => f.checkKind));
    expect(kinds).toContain(CheckKind.ABI);
    expect(kinds).toContain(CheckKind.STORAGE);
    expect(kinds).toContain(CheckKind.DEPENDENCY);
    expect(kinds).toContain(CheckKind.CLIENT);
    expect(kinds).toContain(CheckKind.MIGRATION);
  });

  it("all check kinds are within KNOWN_CHECK_KINDS", () => {
    const artifact = buildSignedArtifact(1, PROOF_ID);
    const findings = runCompatibilityChecks(artifact, null);
    findings.forEach((f) => {
      expect(KNOWN_CHECK_KINDS.has(f.checkKind)).toBe(true);
    });
  });

  it("returns deterministic results — identical input yields identical hash list", () => {
    const artifact = buildSignedArtifact(99, PROOF_ID);
    const r1 = runCompatibilityChecks(artifact, null);
    const r2 = runCompatibilityChecks(artifact, null);

    const hashes1 = r1.map((f) => f.hash);
    const hashes2 = r2.map((f) => f.hash);
    expect(hashes1).toEqual(hashes2);
  });

  it("every finding has a non-empty hash starting with sha256:", () => {
    const artifact = buildSignedArtifact(1, PROOF_ID);
    const findings = runCompatibilityChecks(artifact, null);
    findings.forEach((f) => {
      expect(f.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  it("findings hashes within a single run are unique", () => {
    const artifact = buildSignedArtifact(1, PROOF_ID);
    const findings = runCompatibilityChecks(artifact, null);
    const hashes = findings.map((f) => f.hash);
    const unique = new Set(hashes);
    // Allow duplicates only for identical description/evidence pairs (which
    // would genuinely produce the same hash) — but in our fixtures they differ.
    expect(unique.size).toBe(hashes.length);
  });

  it("blocking findings are sorted before warnings and infos within the same check kind", () => {
    const previous = buildSignedArtifact(1, PROOF_ID, {
      abi: [{ name: "old_func", inputs: [], outputs: [] }],
    });
    const current = buildSignedArtifact(1, PROOF_ID, {
      abi: [{ name: "new_func", inputs: [], outputs: [] }],
    });

    const findings = runCompatibilityChecks(current, previous);
    const abiFindings = findings.filter((f) => f.checkKind === CheckKind.ABI);

    if (abiFindings.length > 1) {
      const firstSeverity = abiFindings[0].severity;
      expect(firstSeverity).toBe(FindingSeverity.BLOCKING);
    }
  });
});
