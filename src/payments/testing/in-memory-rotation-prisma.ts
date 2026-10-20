import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";

/**
 * A minimal in-memory stand-in for the Prisma delegates used by payment
 * account rotation (#321), for deterministic unit tests without a database.
 *
 * It implements just enough to make the tests meaningful:
 * - `where` equality plus `not`, `in`, `lt`, `lte`, `gt`, `gte`
 * - `{ increment }` updates
 * - unique constraints that raise a real `P2002` error
 * - `$transaction`, which is serialised and all-or-nothing: a throw restores
 *   every table to its state before the transaction began
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

interface TableSpec {
  uniques: string[][];
  defaults?: () => Row;
}

const SPECS: Record<string, TableSpec> = {
  user: { uniques: [["id"], ["walletAddress"]] },
  paymentAccountRotation: {
    uniques: [["id"], ["openUserKey"]],
    defaults: () => ({
      status: "PENDING_VERIFICATION",
      version: 0,
      consumedAt: null,
      verifiedAt: null,
      backfillFromLedger: null,
      finalPagingToken: null,
      finalOperationId: null,
      finalTransactionHash: null,
      finalLedgerSequence: null,
      finalLedgerHash: null,
      finalVerifiedAt: null,
      backfillStartLedger: null,
      backfillEndLedger: null,
      backfillJobId: null,
      fromEpochId: null,
      toEpochId: null,
      activatedAt: null,
      rollbackDeadline: null,
      rolledBackAt: null,
      rollbackReason: null,
      failureReason: null,
      openUserKey: null,
    }),
  },
  paymentMonitoredAccount: {
    uniques: [["id"], ["activeUserKey"], ["activeAccountKey"]],
    defaults: () => ({ retiredAt: null, rotationId: null, activeUserKey: null, activeAccountKey: null }),
  },
  paymentSyncCheckpoint: {
    uniques: [["id"], ["userId"]],
    defaults: () => ({
      status: "VERIFIED",
      version: 0,
      divergenceReason: null,
      divergedAt: null,
      reconciliationCursor: null,
    }),
  },
  paymentBackfillJob: {
    uniques: [["id"]],
    defaults: () => ({
      status: "PENDING",
      cancelRequestedAt: null,
      completedAt: null,
      accountId: null,
      checkpointCursor: null,
    }),
  },
  auditLog: { uniques: [["id"]] },
};

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const ops = condition as Record<string, unknown>;
      return Object.entries(ops).every(([op, operand]) => {
        switch (op) {
          case "not":
            return !equal(value, operand);
          case "in":
            return (operand as unknown[]).some((item) => equal(value, item));
          case "lt":
            return compare(value, operand) < 0;
          case "lte":
            return compare(value, operand) <= 0;
          case "gt":
            return compare(value, operand) > 0;
          case "gte":
            return compare(value, operand) >= 0;
          default:
            throw new Error(`Unsupported operator ${op}`);
        }
      });
    }
    return equal(value, condition);
  });
}

function equal(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return (a ?? null) === (b ?? null);
}

function compare(a: unknown, b: unknown): number {
  const left = a instanceof Date ? a.getTime() : (a as number);
  const right = b instanceof Date ? b.getTime() : (b as number);
  if (left === null || left === undefined) return Number.NaN;
  return left - right;
}

function apply(row: Row, data: Row): Row {
  const next = { ...row };
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && "increment" in (value as Row)) {
      next[key] = (row[key] as number) + ((value as { increment: number }).increment);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function select(row: Row, fields?: Record<string, boolean>): Row {
  if (!fields) return clone(row);
  return Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]]));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

class Table {
  rows: Row[] = [];

  constructor(private readonly spec: TableSpec) {}

  private assertUnique(candidate: Row, ignore?: Row): void {
    for (const columns of this.spec.uniques) {
      if (columns.some((column) => candidate[column] === null || candidate[column] === undefined)) continue;
      const clash = this.rows.find(
        (row) => row !== ignore && columns.every((column) => equal(row[column], candidate[column])),
      );
      if (clash) throw uniqueViolation();
    }
  }

  async create(args: { data: Row; select?: Record<string, boolean> }) {
    const now = new Date();
    const row = { id: randomUUID(), createdAt: now, updatedAt: now, ...(this.spec.defaults?.() ?? {}), ...args.data };
    this.assertUnique(row);
    this.rows.push(row);
    return select(row, args.select);
  }

  async findUnique(args: { where: Where; select?: Record<string, boolean> }) {
    const row = this.rows.find((candidate) => matches(candidate, args.where));
    return row ? select(row, args.select) : null;
  }

  async findUniqueOrThrow(args: { where: Where; select?: Record<string, boolean> }) {
    const row = await this.findUnique(args);
    if (!row) throw new Error("Not found");
    return row;
  }

  async findFirst(args: { where?: Where; select?: Record<string, boolean> } = {}) {
    return this.findUnique({ where: args.where ?? {}, select: args.select });
  }

  async findMany(args: { where?: Where } = {}) {
    return this.rows.filter((row) => matches(row, args.where)).map((row) => clone(row));
  }

  async updateMany(args: { where: Where; data: Row }) {
    const targets = this.rows.filter((row) => matches(row, args.where));
    for (const target of targets) {
      const next = apply(target, { ...args.data, updatedAt: new Date() });
      this.assertUnique(next, target);
      Object.assign(target, next);
    }
    return { count: targets.length };
  }

  async deleteMany(args: { where?: Where } = {}) {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !matches(row, args.where));
    return { count: before - this.rows.length };
  }
}

export class InMemoryRotationPrisma {
  readonly user = new Table(SPECS.user);
  readonly paymentAccountRotation = new Table(SPECS.paymentAccountRotation);
  readonly paymentMonitoredAccount = new Table(SPECS.paymentMonitoredAccount);
  readonly paymentSyncCheckpoint = new Table(SPECS.paymentSyncCheckpoint);
  readonly paymentBackfillJob = new Table(SPECS.paymentBackfillJob);
  readonly auditLog = new Table(SPECS.auditLog);

  private queue: Promise<unknown> = Promise.resolve();

  /** Mirrors PrismaService.appendAuditLog: a chain append inside `tx`. */
  appendAuditLog(tx: this, args: { data: Row }) {
    return tx.auditLog.create(args);
  }

  private tables(): Table[] {
    return [
      this.user,
      this.paymentAccountRotation,
      this.paymentMonitoredAccount,
      this.paymentSyncCheckpoint,
      this.paymentBackfillJob,
      this.auditLog,
    ];
  }

  /** Serialised, all-or-nothing transaction. */
  $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const snapshot = this.tables().map((table) => clone(table.rows));
      try {
        return await fn(this);
      } catch (error) {
        this.tables().forEach((table, index) => {
          table.rows = snapshot[index];
        });
        throw error;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
