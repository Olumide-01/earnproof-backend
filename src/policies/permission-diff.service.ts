/**
 * PermissionDiffService
 *
 * Generates versioned semantic diffs for role, scope, and governance
 * permission changes and persists them attached to audit records.
 *
 * Design principles:
 *  - Secrets never enter diffs — only permission names and actor hashes.
 *  - Unknown permissions fail validation before any DB write.
 *  - Inherited permissions are explicit in the before/after snapshots.
 *  - diffHash is deterministic: same inputs always produce the same hash.
 *  - Replay detection: unique diffHash constraint on PermissionChangeDiff.
 *  - All diffs are generated inside the source transaction (or synchronously
 *    before the DB write) so the diff and the mutation are atomic.
 */

import {
  BadRequestException,
  Injectable,
  Logger,

} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import { PrismaService } from "../database/prisma.service";
import {
  ALL_PERMISSIONS,
  PERMISSION_DIFF_VERSION,
  PermissionDiff,
  PermissionDiffEntry,
  PermissionKind,
  PermissionName,
  PermissionOperation,
} from "./permission-diff-types";

// ─── Validation ──────────────────────────────────────────────────────────────

/** Raised when a permission name is not in ALL_PERMISSIONS. */
export class UnknownPermissionError extends BadRequestException {
  constructor(permission: string) {
    super(
      `Unknown permission "${permission}". Declare it in permission-diff-types.ts before use.`,
    );
    this.name = "UnknownPermissionError";
  }
}

/**
 * Validate every permission in a set.
 * Throws UnknownPermissionError for the first unknown value found.
 */
export function validatePermissions(permissions: PermissionName[]): void {
  for (const p of permissions) {
    if (!ALL_PERMISSIONS.has(p)) {
      throw new UnknownPermissionError(p);
    }
  }
}

// ─── Kind inference ──────────────────────────────────────────────────────────

function inferKind(permission: PermissionName): PermissionKind {
  if (permission.startsWith("role:")) return "role";
  if (permission.startsWith("scope:")) return "scope";
  if (permission.startsWith("governance:")) return "governance";
  throw new UnknownPermissionError(permission);
}

// ─── Diff builder (pure function, testable without DI) ───────────────────────

export interface BuildDiffInput {
  subjectId: string;
  subjectKind: "user" | "api_key" | "governance";
  actorWalletHash: string;
  before: PermissionName[];
  after: PermissionName[];
  inheritedPermissions?: PermissionName[];
  changedAt?: Date;
}

/**
 * Build a semantic permission diff from before/after permission sets.
 *
 * @param input.before  Complete set of permissions before the change.
 * @param input.after   Complete set of permissions after the change.
 * @param input.inheritedPermissions  Permissions that are inherited (not explicitly set).
 *
 * Both before and after are expanded to include inherited permissions explicitly,
 * so the snapshot is complete even when the caller did not change them.
 */
export function buildPermissionDiff(input: BuildDiffInput): PermissionDiff {
  const {
    subjectId,
    subjectKind,
    actorWalletHash,
    before,
    after,
    inheritedPermissions = [],
    changedAt = new Date(),
  } = input;

  // Validate all permissions — unknown values are rejected
  validatePermissions([...before, ...after, ...inheritedPermissions]);

  const inherited = new Set(inheritedPermissions);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);

  // Build all permissions ever mentioned (union of all three sets)
  const allMentioned = new Set([...beforeSet, ...afterSet, ...inherited]);

  // Build before-snapshot (explicit + inherited)
  const beforeEntries: PermissionDiffEntry[] = [...allMentioned]
    .sort()
    .filter((p) => beforeSet.has(p) || inherited.has(p))
    .map((p) => ({
      permission: p,
      kind: inferKind(p),
      operation: (inherited.has(p) ? "inherit" : "unchanged") as PermissionOperation,
      inherited: inherited.has(p),
    }));

  // Build after-snapshot
  const afterEntries: PermissionDiffEntry[] = [...allMentioned]
    .sort()
    .filter((p) => afterSet.has(p) || inherited.has(p))
    .map((p) => ({
      permission: p,
      kind: inferKind(p),
      operation: (inherited.has(p) ? "inherit" : "unchanged") as PermissionOperation,
      inherited: inherited.has(p),
    }));

  // Changes: permissions that moved between before and after (excluding inherited)
  const changes: PermissionDiffEntry[] = [];

  // Granted: in after but not in before (and not inherited)
  for (const p of afterSet) {
    if (!beforeSet.has(p) && !inherited.has(p)) {
      changes.push({
        permission: p,
        kind: inferKind(p),
        operation: "grant",
        inherited: false,
      });
    }
  }

  // Revoked: in before but not in after (and not inherited)
  for (const p of beforeSet) {
    if (!afterSet.has(p) && !inherited.has(p)) {
      changes.push({
        permission: p,
        kind: inferKind(p),
        operation: "revoke",
        inherited: false,
      });
    }
  }

  // Sort changes for determinism
  changes.sort((a, b) =>
    a.operation !== b.operation
      ? a.operation.localeCompare(b.operation)
      : a.permission.localeCompare(b.permission),
  );

  // Actor hash — never store raw wallet address
  const actorHash = `sha256:${sha256(actorWalletHash)}`;

  // Canonical body for deterministic hashing
  const body = {
    version: PERMISSION_DIFF_VERSION,
    subjectId,
    subjectKind,
    actorHash,
    before: beforeEntries,
    after: afterEntries,
    changes,
    changedAt: changedAt.toISOString(),
  };

  const diffHash = `sha256:${sha256(canonicalize(body))}`;

  return { ...body, diffHash };
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class PermissionDiffService {
  private readonly logger = new Logger(PermissionDiffService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate a diff and persist it, returning the stored record.
   *
   * Replay detection: if a diff with the same diffHash already exists the
   * call is idempotent — the existing record is returned.
   */
  async persistDiff(
    input: BuildDiffInput,
    auditLogId?: string,
  ): Promise<PermissionDiff> {
    const diff = buildPermissionDiff(input);

    // Replay detection
    const existing = await this.prisma.permissionChangeDiff.findUnique({
      where: { diffHash: diff.diffHash },
    });

    if (existing) {
      this.logger.debug(
        `Duplicate diff ${diff.diffHash} for subject ${input.subjectId} — returning existing`,
      );
      return diff;
    }

    await this.prisma.permissionChangeDiff.create({
      data: {
        id: randomUUID(),
        version: PERMISSION_DIFF_VERSION,
        subjectId: diff.subjectId,
        subjectKind: diff.subjectKind,
        actorHash: diff.actorHash,
        before: diff.before as unknown as never,
        after: diff.after as unknown as never,
        changes: diff.changes as unknown as never,
        diffHash: diff.diffHash,
        changedAt: new Date(diff.changedAt),
        auditLogId: auditLogId ?? null,
      },
    });

    this.logger.log(
      `Permission diff persisted for ${diff.subjectKind}:${diff.subjectId} ` +
        `(${diff.changes.length} change(s), hash=${diff.diffHash})`,
    );

    return diff;
  }

  /**
   * Retrieve a persisted diff by its stable hash.
   */
  async getDiffByHash(diffHash: string): Promise<PermissionDiff | null> {
    const row = await this.prisma.permissionChangeDiff.findUnique({
      where: { diffHash },
    });

    if (!row) return null;

    return {
      version: row.version as typeof PERMISSION_DIFF_VERSION,
      subjectId: row.subjectId,
      subjectKind: row.subjectKind as PermissionDiff["subjectKind"],
      actorHash: row.actorHash,
      before: row.before as unknown as PermissionDiffEntry[],
      after: row.after as unknown as PermissionDiffEntry[],
      changes: row.changes as unknown as PermissionDiffEntry[],
      diffHash: row.diffHash,
      changedAt: row.changedAt.toISOString(),
    };
  }

  /**
   * List all diffs for a subject, newest first.
   */
  async listDiffsForSubject(subjectId: string): Promise<PermissionDiff[]> {
    const rows = await this.prisma.permissionChangeDiff.findMany({
      where: { subjectId },
      orderBy: { changedAt: "desc" },
    });

    return rows.map((row) => ({
      version: row.version as typeof PERMISSION_DIFF_VERSION,
      subjectId: row.subjectId,
      subjectKind: row.subjectKind as PermissionDiff["subjectKind"],
      actorHash: row.actorHash,
      before: row.before as unknown as PermissionDiffEntry[],
      after: row.after as unknown as PermissionDiffEntry[],
      changes: row.changes as unknown as PermissionDiffEntry[],
      diffHash: row.diffHash,
      changedAt: row.changedAt.toISOString(),
    }));
  }
}
