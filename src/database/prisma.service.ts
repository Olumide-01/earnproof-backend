import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  computeAuditHash,
  CURRENT_HASH_VERSION,
  resolveChainKey,
} from "../audit/audit-chain";

/** Row shape read back from `AuditChainCursor` via raw SQL. */
interface ChainCursorRow {
  chainKey: string;
  lastSequence: bigint;
  lastHash: string | null;
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super();
    this.installAuditChainWriter();
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  get webhookCircuitState() {
    return (this as any).webhookCircuit;
  }

  /**
   * Makes every `auditLog.create(...)` call transparently participate in the
   * per-chain tamper-evidence hash chain, regardless of which service issued
   * it.
   *
   * Why an instance patch instead of `$extends`: a Prisma Client Extension
   * (`this.$extends(...)`) returns a *new* client object with an extended
   * type; it does not mutate `this` in place. Every service in this codebase
   * injects and type-annotates `PrismaService` (the class this constructor
   * belongs to), including lifecycle methods (`onModuleInit`/
   * `onModuleDestroy`) that a bare `$extends(...)` result does not have, so
   * swapping in an extended client would require re-typing every injection
   * site. Overriding the `auditLog.create` method on the already-constructed
   * delegate keeps the same `PrismaService` type and DI token everywhere,
   * while still intercepting every call site transparently — including the
   * existing ones in api-keys, organizations, issuers, payments,
   * trusted-sources and webhooks, none of which need to change.
   *
   * Concurrency: appends to the same chain (same `chainKey`) are made safe
   * with a Postgres row lock. Each call opens its own `$transaction`,
   * `SELECT ... FOR UPDATE`s the chain's `AuditChainCursor` row (inserting it
   * first via `INSERT ... ON CONFLICT DO NOTHING` if this is the chain's
   * first record), computes the next `sequence`/`hash` from the locked
   * cursor, inserts the audit row, and advances the cursor — all before the
   * lock is released at commit. A pessimistic lock (rather than an optimistic
   * compare-and-swap retry loop) was chosen because audit writes are already
   * wrapped one-at-a-time per call and are not expected to be a high-throughput
   * hot path; a short-lived row lock is simpler to reason about here than a
   * retry loop and cannot livelock under contention.
   */
  private installAuditChainWriter(): void {
    // `appendAuditLog` performs the insert through `tx.auditLog.create`, the
    // interactive-transaction client's *unpatched* delegate, so this override
    // never recurses into itself.
    this.auditLog.create = ((args: Prisma.AuditLogCreateArgs) =>
      this.$transaction((tx) => this.appendAuditLog(tx, args))) as unknown as typeof this.auditLog.create;
  }

  /**
   * Appends one audit record to its hash chain inside the caller's
   * transaction, so the record commits or rolls back with the change it
   * describes.
   *
   * Use this instead of `tx.auditLog.create(...)` inside `$transaction`: the
   * interactive-transaction client is a different object from `this`, so its
   * `auditLog.create` is the unpatched delegate and would write a row with the
   * column defaults (`chainKey` "SYSTEM", `sequence` 0) — colliding on the
   * `(chainKey, sequence)` unique index from the second such write onwards.
   * The cursor row lock below is held until the caller's transaction ends.
   */
  async appendAuditLog(tx: Prisma.TransactionClient, args: Prisma.AuditLogCreateArgs) {
    const data = args.data;
    const organizationId = (data.organizationId as string | null | undefined) ?? null;
    const chainKey = resolveChainKey(organizationId);

    await tx.$executeRaw`
      INSERT INTO "AuditChainCursor" ("chainKey", "lastSequence", "lastHash", "updatedAt")
      VALUES (${chainKey}, 0, NULL, now())
      ON CONFLICT ("chainKey") DO NOTHING
    `;

    const rows = await tx.$queryRaw<ChainCursorRow[]>`
      SELECT "chainKey", "lastSequence", "lastHash"
      FROM "AuditChainCursor"
      WHERE "chainKey" = ${chainKey}
      FOR UPDATE
    `;
    const cursor = rows[0];
    if (!cursor) {
      throw new Error(
        `Audit chain cursor for "${chainKey}" could not be locked`,
      );
    }

    const sequence = cursor.lastSequence + BigInt(1);
    const prevHash = cursor.lastHash;
    const createdAt = (data.createdAt as Date | undefined) ?? new Date();
    const actorType = data.actorType as string;
    const actorId = (data.actorId as string | null | undefined) ?? null;
    const action = data.action as string;
    const resourceType = data.resourceType as string;
    const resourceId = (data.resourceId as string | null | undefined) ?? null;
    const metadata = (data.metadata as Prisma.InputJsonValue | null | undefined) ?? null;

    const hash = computeAuditHash(prevHash, {
      chainKey,
      sequence,
      hashVersion: CURRENT_HASH_VERSION,
      actorType,
      actorId,
      action,
      resourceType,
      resourceId,
      metadata,
      createdAt,
    });

    const created = await tx.auditLog.create({
      ...args,
      data: {
        ...data,
        organizationId,
        chainKey,
        sequence,
        hashVersion: CURRENT_HASH_VERSION,
        prevHash,
        hash,
        createdAt,
      },
    } as Prisma.AuditLogCreateArgs);

    await tx.$executeRaw`
      UPDATE "AuditChainCursor"
      SET "lastSequence" = ${sequence}, "lastHash" = ${hash}, "updatedAt" = now()
      WHERE "chainKey" = ${chainKey}
    `;

    return created;
  }
}
