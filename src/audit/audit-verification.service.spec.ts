import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../database/prisma.service";
import { computeAuditHash } from "./audit-chain";
import { AuditVerificationService } from "./audit-verification.service";

interface Row {
  id: string;
  sequence: bigint;
  hashVersion: number;
  prevHash: string | null;
  hash: string;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: unknown;
  createdAt: Date;
}

/** Builds a valid, self-consistent chain of `count` records for `chainKey`,
 * starting after `startingPrevHash`/`startingSequence` (so a truncated chain
 * -- as retention cleanup would leave behind -- can be modeled too). */
function buildChain(
  chainKey: string,
  count: number,
  startSequence = 1,
  startingPrevHash: string | null = null,
): Row[] {
  const rows: Row[] = [];
  let prevHash = startingPrevHash;
  for (let i = 0; i < count; i++) {
    const sequence = BigInt(startSequence + i);
    const createdAt = new Date(2026, 0, 1 + i);
    const base = {
      chainKey,
      sequence,
      hashVersion: 1,
      actorType: "USER",
      actorId: `user-${i}`,
      action: "ACTION",
      resourceType: "Resource",
      resourceId: `res-${i}`,
      metadata: { i },
      createdAt,
    };
    const hash = computeAuditHash(prevHash, base);
    rows.push({
      id: `row-${sequence.toString()}`,
      sequence,
      hashVersion: 1,
      prevHash,
      hash,
      actorType: base.actorType,
      actorId: base.actorId,
      action: base.action,
      resourceType: base.resourceType,
      resourceId: base.resourceId,
      metadata: base.metadata,
      createdAt,
    });
    prevHash = hash;
  }
  return rows;
}

describe("AuditVerificationService", () => {
  let service: AuditVerificationService;
  let findMany: jest.Mock;

  beforeEach(async () => {
    findMany = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditVerificationService,
        {
          provide: PrismaService,
          useValue: {
            auditLog: { findMany },
          },
        },
      ],
    }).compile();

    service = module.get(AuditVerificationService);
  });

  /** Serves rows page by page, mimicking Prisma's `sequence: { gt: cursor }`
   * pagination so the walker's internal pagination is genuinely exercised. */
  function servePaginated(rows: Row[], pageSize: number) {
    findMany.mockImplementation(async ({ where }: { where: { sequence?: { gt: bigint } } }) => {
      const after = where.sequence?.gt;
      const remaining = after === undefined ? rows : rows.filter((r) => r.sequence > after);
      return remaining.slice(0, pageSize);
    });
  }

  it("reports ok for a valid, untampered chain (positive)", async () => {
    const rows = buildChain("org-1", 10);
    servePaginated(rows, 500);

    const result = await service.verifyChain("org-1");

    expect(result.ok).toBe(true);
    expect(result.break).toBeNull();
    expect(result.recordsChecked).toBe(10);
    expect(result.retentionTruncated).toBe(false);
  });

  it("walks a long chain across multiple internal pages without loading it all at once", async () => {
    const rows = buildChain("org-1", 1200);
    servePaginated(rows, 500); // forces 3 internal pages

    const result = await service.verifyChain("org-1");

    expect(result.ok).toBe(true);
    expect(result.recordsChecked).toBe(1200);
    // 1200 rows / 500 page size -> pages of 500, 500, 200. The walker stops
    // as soon as a short page (< WALK_PAGE_SIZE) is returned, so this is 3
    // findMany calls, not one per whole chain.
    expect(findMany.mock.calls.length).toBe(3);
  });

  it("detects tampering: a record's stored hash no longer matches its recomputed hash (negative)", async () => {
    const rows = buildChain("org-1", 5);
    rows[2].hash = "tampered-hash-value";
    servePaginated(rows, 500);

    const result = await service.verifyChain("org-1");

    expect(result.ok).toBe(false);
    expect(result.break).not.toBeNull();
    expect(result.break?.reason).toBe("HASH_MISMATCH");
    expect(result.break?.recordId).toBe(rows[2].id);
  });

  it("detects tampering: a record's prevHash no longer matches the actual previous record's hash", async () => {
    const rows = buildChain("org-1", 5);
    // Re-point record 3's prevHash at a hash that isn't record 2's hash, but
    // recompute record 3's own hash consistently with that forged prevHash
    // so the HASH_MISMATCH check alone would not catch it -- only the link
    // check does.
    const forgedPrevHash = "forged-prev-hash";
    rows[2].prevHash = forgedPrevHash;
    rows[2].hash = computeAuditHash(forgedPrevHash, {
      chainKey: "org-1",
      sequence: rows[2].sequence,
      hashVersion: rows[2].hashVersion,
      actorType: rows[2].actorType,
      actorId: rows[2].actorId,
      action: rows[2].action,
      resourceType: rows[2].resourceType,
      resourceId: rows[2].resourceId,
      metadata: rows[2].metadata,
      createdAt: rows[2].createdAt,
    });
    servePaginated(rows, 500);

    const result = await service.verifyChain("org-1");

    expect(result.ok).toBe(false);
    expect(result.break?.reason).toBe("PREV_HASH_MISMATCH");
    expect(result.break?.recordId).toBe(rows[2].id);
  });

  it("treats an empty chain as ok (boundary)", async () => {
    servePaginated([], 500);

    const result = await service.verifyChain("org-1");

    expect(result.ok).toBe(true);
    expect(result.recordsChecked).toBe(0);
    expect(result.firstSequenceChecked).toBeNull();
  });

  it("does not report a false tamper finding when retention has removed the earliest records (retention boundary)", async () => {
    // Simulates retention cleanup having deleted sequences 1-10: the
    // remaining chain starts at sequence 11 with a prevHash pointing at a
    // (now-deleted) record's hash.
    const remaining = buildChain("org-1", 5, 11, "hash-of-deleted-record-10");
    servePaginated(remaining, 500);

    const result = await service.verifyChain("org-1");

    expect(result.ok).toBe(true);
    expect(result.break).toBeNull();
    expect(result.retentionTruncated).toBe(true);
    expect(result.firstSequenceChecked).toBe("11");
  });

  it("still detects genuine tampering on a retention-truncated chain (regression: boundary must not mask tamper findings)", async () => {
    const remaining = buildChain("org-1", 5, 11, "hash-of-deleted-record-10");
    remaining[3].hash = "tampered";
    servePaginated(remaining, 500);

    const result = await service.verifyChain("org-1");

    expect(result.ok).toBe(false);
    expect(result.retentionTruncated).toBe(true);
    expect(result.break?.recordId).toBe(remaining[3].id);
  });

  it("scopes verification by organization id via chainKey", async () => {
    servePaginated([], 500);
    await service.verifyChain("org-42");
    expect(findMany.mock.calls[0][0].where.chainKey).toBe("org-42");
  });

  it("falls back to the SYSTEM chain key when no organization id is given", async () => {
    servePaginated([], 500);
    await service.verifyChain(null);
    expect(findMany.mock.calls[0][0].where.chainKey).toBe("SYSTEM");
  });
});
