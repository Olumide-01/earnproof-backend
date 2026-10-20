import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { computeAuditHash, resolveChainKey } from "./audit-chain";

/** Rows read per page while walking a chain. Keeps memory bounded regardless
 * of how long the chain is (explicit "works across pagination" requirement). */
const WALK_PAGE_SIZE = 500;

export type ChainVerificationReason =
  | "HASH_MISMATCH"
  | "PREV_HASH_MISMATCH"
  | "SEQUENCE_GAP";

export interface ChainBreak {
  recordId: string;
  sequence: string;
  reason: ChainVerificationReason;
  detail: string;
}

export interface ChainVerificationResult {
  chainKey: string;
  ok: boolean;
  recordsChecked: number;
  firstSequenceChecked: string | null;
  lastSequenceChecked: string | null;
  /** True when the first record examined has sequence > 1, i.e. earlier
   * records are missing. This is expected after retention cleanup has
   * deleted the oldest rows in the chain, and is reported separately from a
   * tamper finding rather than folded into `break`. */
  retentionTruncated: boolean;
  break: ChainBreak | null;
}

/**
 * Walks an AuditLog hash chain in sequence order, recomputing each record's
 * hash (using that record's own stored `hashVersion`) and confirming it links
 * to the previous record's stored hash. Returns the first broken link found,
 * if any.
 *
 * Retention boundary handling: retention cleanup deletes the oldest AuditLog
 * rows (see src/jobs/retention/retention-cleanup.service.ts), which can leave
 * a chain's first remaining record at sequence > 1 with a `prevHash` that
 * points at a row that no longer exists. That is a legitimate consequence of
 * retention, not tampering, so verification only treats a `prevHash`
 * mismatch as a break when it has the actual prior record to compare
 * against; a gap at the very start of the walk is instead surfaced via
 * `retentionTruncated`.
 */
@Injectable()
export class AuditVerificationService {
  constructor(private readonly prisma: PrismaService) {}

  async verifyChain(
    organizationId: string | null,
  ): Promise<ChainVerificationResult> {
    const chainKey = resolveChainKey(organizationId);

    let cursor: bigint | null = null;
    let previousHash: string | null = null;
    let previousSequence: bigint | null = null;
    let recordsChecked = 0;
    let firstSequenceChecked: bigint | null = null;
    let lastSequenceChecked: bigint | null = null;
    let retentionTruncated = false;

    while (true) {
      const where: Prisma.AuditLogWhereInput = {
        chainKey,
        ...(cursor !== null ? { sequence: { gt: cursor } } : {}),
      };
      const page = await this.prisma.auditLog.findMany({
        where,
        orderBy: { sequence: "asc" },
        take: WALK_PAGE_SIZE,
        select: {
          id: true,
          sequence: true,
          hashVersion: true,
          prevHash: true,
          hash: true,
          actorType: true,
          actorId: true,
          action: true,
          resourceType: true,
          resourceId: true,
          metadata: true,
          createdAt: true,
        },
      });

      if (page.length === 0) break;

      for (const record of page) {
        if (firstSequenceChecked === null) {
          firstSequenceChecked = record.sequence;
          // A first remaining sequence greater than 1 means earlier records
          // were removed (retention), not that the chain never had them.
          if (record.sequence > BigInt(1)) {
            retentionTruncated = true;
          }
        }

        const recomputedHash = computeAuditHash(
          record.prevHash,
          {
            chainKey,
            sequence: record.sequence,
            hashVersion: record.hashVersion,
            actorType: record.actorType,
            actorId: record.actorId,
            action: record.action,
            resourceType: record.resourceType,
            resourceId: record.resourceId,
            metadata: record.metadata,
            createdAt: record.createdAt,
          },
          record.hashVersion,
        );

        if (recomputedHash !== record.hash) {
          return {
            chainKey,
            ok: false,
            recordsChecked: recordsChecked + 1,
            firstSequenceChecked: firstSequenceChecked?.toString() ?? null,
            lastSequenceChecked: record.sequence.toString(),
            retentionTruncated,
            break: {
              recordId: record.id,
              sequence: record.sequence.toString(),
              reason: "HASH_MISMATCH",
              detail:
                "Recomputed hash does not match the stored hash for this record.",
            },
          };
        }

        // Only compare prevHash against an actual previous record we just
        // verified in this walk. At the very start of the walk there may be
        // no previous record in hand (either true genesis, or a retention
        // boundary) -- neither case is verifiable from this vantage point,
        // and `retentionTruncated` already flags the boundary case.
        if (previousHash !== null || previousSequence !== null) {
          if (record.prevHash !== previousHash) {
            return {
              chainKey,
              ok: false,
              recordsChecked: recordsChecked + 1,
              firstSequenceChecked: firstSequenceChecked?.toString() ?? null,
              lastSequenceChecked: record.sequence.toString(),
              retentionTruncated,
              break: {
                recordId: record.id,
                sequence: record.sequence.toString(),
                reason: "PREV_HASH_MISMATCH",
                detail: `Record's prevHash does not match the previous record's hash (previous sequence ${previousSequence?.toString()}).`,
              },
            };
          }

          if (record.sequence !== previousSequence! + BigInt(1)) {
            return {
              chainKey,
              ok: false,
              recordsChecked: recordsChecked + 1,
              firstSequenceChecked: firstSequenceChecked?.toString() ?? null,
              lastSequenceChecked: record.sequence.toString(),
              retentionTruncated,
              break: {
                recordId: record.id,
                sequence: record.sequence.toString(),
                reason: "SEQUENCE_GAP",
                detail: `Expected sequence ${(previousSequence! + BigInt(1)).toString()} but found ${record.sequence.toString()}, with no intervening retention explanation.`,
              },
            };
          }
        }

        previousHash = record.hash;
        previousSequence = record.sequence;
        recordsChecked += 1;
        lastSequenceChecked = record.sequence;
      }

      cursor = page[page.length - 1].sequence;
      if (page.length < WALK_PAGE_SIZE) break;
    }

    return {
      chainKey,
      ok: true,
      recordsChecked,
      firstSequenceChecked: firstSequenceChecked?.toString() ?? null,
      lastSequenceChecked: lastSequenceChecked?.toString() ?? null,
      retentionTruncated,
      break: null,
    };
  }
}
