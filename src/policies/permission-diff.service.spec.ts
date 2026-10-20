/**
 * Unit tests for permission-diff.service.ts
 *
 * Coverage:
 *  - Positive: valid role, scope, governance diffs with grants and revokes.
 *  - Negative: unknown permissions fail validation.
 *  - Boundary: empty before, empty after, no changes.
 *  - Inherited: inherited permissions are explicit in snapshots.
 *  - Secrets: actor hash stored as sha256:sha256(wallet), never raw address.
 *  - Determinism: same inputs always produce the same diffHash.
 *  - Replay detection: duplicate diffHash returns existing record.
 *  - Regression: changes array is sorted and stable across re-runs.
 *  - persistDiff: creates DB row and returns diff.
 *  - listDiffsForSubject: queries by subjectId.
 */

import { BadRequestException } from "@nestjs/common";
import {
  buildPermissionDiff,
  BuildDiffInput,
  PermissionDiffService,
  UnknownPermissionError,
  validatePermissions,
} from "./permission-diff.service";
import {
  ALL_PERMISSIONS,
  GOVERNANCE_PERMISSIONS,
  PERMISSION_DIFF_VERSION,
  ROLE_PERMISSIONS,
  SCOPE_PERMISSIONS,
} from "./permission-diff-types";

const SUBJECT_ID = "user-001";
const ACTOR_HASH = "sha256:actor-wallet-hash";
const CHANGED_AT = new Date("2025-01-01T12:00:00.000Z");

function baseInput(overrides: Partial<BuildDiffInput> = {}): BuildDiffInput {
  return {
    subjectId: SUBJECT_ID,
    subjectKind: "user",
    actorWalletHash: ACTOR_HASH,
    before: [ROLE_PERMISSIONS.WORKER],
    after: [ROLE_PERMISSIONS.ISSUER],
    changedAt: CHANGED_AT,
    ...overrides,
  };
}

function makePrisma(overrides: Record<string, unknown> = {}) {
  const existingRow = "existingRow" in overrides ? overrides.existingRow : null;
  return {
    permissionChangeDiff: {
      findUnique: jest.fn().mockResolvedValue(existingRow),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: "diff-001", ...data }),
      ),
      findMany: jest.fn().mockResolvedValue("rows" in overrides ? overrides.rows : []),
    },
  };
}

// ─── validatePermissions ──────────────────────────────────────────────────────

describe("validatePermissions()", () => {
  it("passes for all declared permissions", () => {
    expect(() => validatePermissions([...ALL_PERMISSIONS])).not.toThrow();
  });

  it("throws UnknownPermissionError for an unknown value", () => {
    expect(() => validatePermissions(["role:SUPERUSER"])).toThrow(UnknownPermissionError);
  });

  it("throws BadRequestException subclass so NestJS returns 400", () => {
    expect(() => validatePermissions(["scope:UNKNOWN"])).toThrow(BadRequestException);
  });

  it("names the unknown permission in the error message", () => {
    try {
      validatePermissions(["governance:GRANT_ALL"]);
    } catch (e: unknown) {
      expect((e as Error).message).toMatch(/GRANT_ALL/);
    }
  });
});

// ─── buildPermissionDiff — positive ──────────────────────────────────────────

describe("buildPermissionDiff() — positive", () => {
  it("generates a diff with version, subjectId, diffHash", () => {
    const diff = buildPermissionDiff(baseInput());
    expect(diff.version).toBe(PERMISSION_DIFF_VERSION);
    expect(diff.subjectId).toBe(SUBJECT_ID);
    expect(diff.diffHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("records a grant when a permission is added", () => {
    const diff = buildPermissionDiff(baseInput({
      before: [ROLE_PERMISSIONS.WORKER],
      after: [ROLE_PERMISSIONS.WORKER, ROLE_PERMISSIONS.ISSUER],
    }));
    const grants = diff.changes.filter((c) => c.operation === "grant");
    expect(grants).toHaveLength(1);
    expect(grants[0].permission).toBe(ROLE_PERMISSIONS.ISSUER);
  });

  it("records a revoke when a permission is removed", () => {
    const diff = buildPermissionDiff(baseInput({
      before: [ROLE_PERMISSIONS.WORKER, ROLE_PERMISSIONS.ISSUER],
      after: [ROLE_PERMISSIONS.WORKER],
    }));
    const revokes = diff.changes.filter((c) => c.operation === "revoke");
    expect(revokes).toHaveLength(1);
    expect(revokes[0].permission).toBe(ROLE_PERMISSIONS.ISSUER);
  });

  it("handles scope changes", () => {
    const diff = buildPermissionDiff(baseInput({
      subjectKind: "api_key",
      before: [SCOPE_PERMISSIONS.PROOF_READ],
      after: [SCOPE_PERMISSIONS.PROOF_READ, SCOPE_PERMISSIONS.PAYMENT_READ],
    }));
    const grants = diff.changes.filter((c) => c.operation === "grant");
    expect(grants[0].kind).toBe("scope");
  });

  it("handles governance changes", () => {
    const diff = buildPermissionDiff(baseInput({
      subjectKind: "governance",
      before: [],
      after: [GOVERNANCE_PERMISSIONS.APPROVE_ISSUER],
    }));
    expect(diff.changes[0].kind).toBe("governance");
  });

  it("hashes actor wallet — never stores raw address", () => {
    const diff = buildPermissionDiff(baseInput({ actorWalletHash: "GRAWWALLET" }));
    expect(diff.actorHash).not.toBe("GRAWWALLET");
    expect(diff.actorHash).toMatch(/^sha256:/);
    expect(diff.actorHash).not.toContain("GRAWWALLET");
  });
});

// ─── buildPermissionDiff — inherited ─────────────────────────────────────────

describe("buildPermissionDiff() — inherited permissions", () => {
  it("marks inherited permissions explicitly in before/after snapshots", () => {
    const diff = buildPermissionDiff(baseInput({
      before: [ROLE_PERMISSIONS.WORKER],
      after: [ROLE_PERMISSIONS.ISSUER],
      inheritedPermissions: [SCOPE_PERMISSIONS.PROOF_READ],
    }));
    const inheritedBefore = diff.before.filter((e) => e.inherited);
    const inheritedAfter = diff.after.filter((e) => e.inherited);
    expect(inheritedBefore.length).toBeGreaterThan(0);
    expect(inheritedAfter.length).toBeGreaterThan(0);
    expect(inheritedBefore[0].permission).toBe(SCOPE_PERMISSIONS.PROOF_READ);
  });

  it("does not include inherited permissions in changes", () => {
    const diff = buildPermissionDiff(baseInput({
      before: [ROLE_PERMISSIONS.WORKER],
      after: [ROLE_PERMISSIONS.ISSUER],
      inheritedPermissions: [SCOPE_PERMISSIONS.PROOF_READ],
    }));
    const inheritedChanges = diff.changes.filter((c) => c.inherited);
    expect(inheritedChanges).toHaveLength(0);
  });
});

// ─── buildPermissionDiff — boundary ──────────────────────────────────────────

describe("buildPermissionDiff() — boundary", () => {
  it("handles empty before set (first grant)", () => {
    const diff = buildPermissionDiff(baseInput({ before: [], after: [ROLE_PERMISSIONS.WORKER] }));
    expect(diff.before).toHaveLength(0);
    expect(diff.changes[0].operation).toBe("grant");
  });

  it("handles empty after set (full revoke)", () => {
    const diff = buildPermissionDiff(baseInput({ before: [ROLE_PERMISSIONS.WORKER], after: [] }));
    expect(diff.after).toHaveLength(0);
    expect(diff.changes[0].operation).toBe("revoke");
  });

  it("produces empty changes when before equals after", () => {
    const diff = buildPermissionDiff(baseInput({
      before: [ROLE_PERMISSIONS.WORKER],
      after: [ROLE_PERMISSIONS.WORKER],
    }));
    expect(diff.changes).toHaveLength(0);
  });

  it("rejects unknown permission in before set", () => {
    expect(() =>
      buildPermissionDiff(baseInput({ before: ["role:UNKNOWN_ROLE"] })),
    ).toThrow(UnknownPermissionError);
  });

  it("rejects unknown permission in after set", () => {
    expect(() =>
      buildPermissionDiff(baseInput({ after: ["scope:FAKE_SCOPE"] })),
    ).toThrow(UnknownPermissionError);
  });
});

// ─── Determinism ─────────────────────────────────────────────────────────────

describe("buildPermissionDiff() — determinism", () => {
  it("produces the same diffHash for identical inputs", () => {
    const input = baseInput();
    const d1 = buildPermissionDiff(input);
    const d2 = buildPermissionDiff(input);
    expect(d1.diffHash).toBe(d2.diffHash);
  });

  it("produces different diffHash when permissions differ", () => {
    const d1 = buildPermissionDiff(baseInput({ after: [ROLE_PERMISSIONS.WORKER] }));
    const d2 = buildPermissionDiff(baseInput({ after: [ROLE_PERMISSIONS.ADMIN] }));
    expect(d1.diffHash).not.toBe(d2.diffHash);
  });

  it("changes array is sorted identically across runs", () => {
    const input = baseInput({
      before: [ROLE_PERMISSIONS.WORKER],
      after: [ROLE_PERMISSIONS.ISSUER, ROLE_PERMISSIONS.ADMIN],
    });
    const d1 = buildPermissionDiff(input);
    const d2 = buildPermissionDiff(input);
    expect(d1.changes.map((c) => c.permission)).toEqual(
      d2.changes.map((c) => c.permission),
    );
  });
});

// ─── PermissionDiffService — persistDiff ─────────────────────────────────────

describe("PermissionDiffService — persistDiff", () => {
  it("creates a new DB row and returns the diff", async () => {
    const prisma = makePrisma();
    const svc = new PermissionDiffService(prisma as never);
    const diff = await svc.persistDiff(baseInput());
    expect(diff.diffHash).toMatch(/^sha256:/);
    expect(prisma.permissionChangeDiff.create).toHaveBeenCalledTimes(1);
  });

  it("returns existing diff without re-creating when hash already exists", async () => {
    const existingRow = { id: "existing", diffHash: "sha256:abc", subjectId: SUBJECT_ID,
      subjectKind: "user", actorHash: "sha256:h", version: PERMISSION_DIFF_VERSION,
      before: [], after: [], changes: [], changedAt: CHANGED_AT };
    const prisma = makePrisma({ existingRow });
    const svc = new PermissionDiffService(prisma as never);
    await svc.persistDiff(baseInput());
    expect(prisma.permissionChangeDiff.create).not.toHaveBeenCalled();
  });

  it("attaches auditLogId when provided", async () => {
    const prisma = makePrisma();
    const svc = new PermissionDiffService(prisma as never);
    await svc.persistDiff(baseInput(), "audit-log-001");
    const data = prisma.permissionChangeDiff.create.mock.calls[0][0].data;
    expect(data.auditLogId).toBe("audit-log-001");
  });
});

// ─── PermissionDiffService — listDiffsForSubject ─────────────────────────────

describe("PermissionDiffService — listDiffsForSubject", () => {
  it("returns empty array when no diffs exist", async () => {
    const prisma = makePrisma({ rows: [] });
    const svc = new PermissionDiffService(prisma as never);
    const result = await svc.listDiffsForSubject("user-999");
    expect(result).toEqual([]);
  });

  it("queries by subjectId", async () => {
    const prisma = makePrisma({ rows: [] });
    const svc = new PermissionDiffService(prisma as never);
    await svc.listDiffsForSubject("user-abc");
    expect(prisma.permissionChangeDiff.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { subjectId: "user-abc" } }),
    );
  });
});

// ─── PermissionDiffService — getDiffByHash ───────────────────────────────────

describe("PermissionDiffService — getDiffByHash", () => {
  it("returns null when no diff found", async () => {
    const prisma = makePrisma();
    const svc = new PermissionDiffService(prisma as never);
    const result = await svc.getDiffByHash("sha256:nonexistent");
    expect(result).toBeNull();
  });

  it("returns mapped diff when found", async () => {
    const row = { id: "d1", version: PERMISSION_DIFF_VERSION, subjectId: "u1",
      subjectKind: "user", actorHash: "sha256:h", before: [], after: [], changes: [],
      diffHash: "sha256:abc", auditLogId: null, changedAt: CHANGED_AT, createdAt: CHANGED_AT };
    const prisma = makePrisma({ existingRow: row });
    const svc = new PermissionDiffService(prisma as never);
    const result = await svc.getDiffByHash("sha256:abc");
    expect(result?.subjectId).toBe("u1");
    expect(result?.diffHash).toBe("sha256:abc");
  });
});