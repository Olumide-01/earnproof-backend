process.env.DATABASE_URL ??=
  "postgresql://user:pass@localhost:5432/db?schema=public";

import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";

/**
 * Exercises the AuditLog chain-writer patch installed on PrismaService
 * (see installAuditChainWriter in prisma.service.ts). Since there is no
 * reachable Postgres in this environment, `$transaction`/`$queryRaw`/
 * `$executeRaw` are mocked; the fakes below model the row-lock semantics
 * (`SELECT ... FOR UPDATE`) closely enough to prove the sequencing/hash
 * logic reads a fresh cursor and writes back atomically, without needing a
 * real database.
 */
describe("PrismaService audit chain writer", () => {
  let service: PrismaService;

  beforeEach(() => {
    service = new PrismaService();
  });

  afterEach(async () => {
    // No real connection was ever opened (onModuleInit was never called),
    // so this is a no-op guard rather than an actual disconnect.
    jest.restoreAllMocks();
  });

  function installFakeDb(initial: {
    lastSequence: bigint;
    lastHash: string | null;
  }) {
    const cursor = { chainKey: "org-1", ...initial };
    const created: unknown[] = [];

    const fakeTx = {
      $executeRaw: jest.fn(async () => 1),
      $queryRaw: jest.fn(async () => [{ ...cursor }]),
      auditLog: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          const row = { id: `row-${created.length + 1}`, ...args.data };
          created.push(row);
          // Model the cursor update happening within the same transaction:
          // real code issues its own $executeRaw UPDATE afterward, so just
          // track what the assertions need here.
          return row;
        }),
      },
    };

    jest
      .spyOn(service, "$transaction")
      .mockImplementation(async (cb: unknown) => {
        const result = await (cb as (tx: unknown) => Promise<unknown>)(fakeTx);
        return result;
      });

    return { fakeTx, created, cursor };
  }

  it("chains the first record in a chain to the GENESIS sentinel", async () => {
    const { fakeTx, created } = installFakeDb({
      lastSequence: BigInt(0),
      lastHash: null,
    });

    await service.auditLog.create({
      data: {
        organizationId: "org-1",
        actorType: "USER",
        actorId: "user-1",
        action: "LOGIN",
        resourceType: "Session",
        resourceId: "session-1",
        metadata: { a: 1 },
      },
    } as unknown as Prisma.AuditLogCreateArgs);

    expect(fakeTx.auditLog.create).toHaveBeenCalledTimes(1);
    const row = created[0] as Record<string, unknown>;
    expect(row.chainKey).toBe("org-1");
    expect(row.sequence).toBe(BigInt(1));
    expect(row.prevHash).toBeNull();
    expect(typeof row.hash).toBe("string");
    expect((row.hash as string)).toHaveLength(64);
  });

  it("links sequence and prevHash to the locked cursor's current value", async () => {
    const { fakeTx, created } = installFakeDb({
      lastSequence: BigInt(5),
      lastHash: "prior-hash-abc",
    });

    await service.auditLog.create({
      data: {
        organizationId: "org-1",
        actorType: "USER",
        actorId: "user-2",
        action: "LOGOUT",
        resourceType: "Session",
        resourceId: "session-2",
        metadata: null,
      },
    } as unknown as Prisma.AuditLogCreateArgs);

    const row = created[0] as Record<string, unknown>;
    expect(row.sequence).toBe(BigInt(6));
    expect(row.prevHash).toBe("prior-hash-abc");
    expect(fakeTx.$executeRaw).toHaveBeenCalled(); // cursor insert-if-missing + advance
  });

  it("resolves organization-less records into the SYSTEM chain", async () => {
    const { created } = installFakeDb({
      lastSequence: BigInt(0),
      lastHash: null,
    });

    await service.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: "CLEANUP_RAN",
        resourceType: "Job",
        metadata: undefined,
      },
    } as unknown as Prisma.AuditLogCreateArgs);

    const row = created[0] as Record<string, unknown>;
    expect(row.chainKey).toBe("SYSTEM");
    expect(row.organizationId).toBeNull();
  });

  it("serializes concurrent appends to the same chain into a gapless, correctly-linked sequence", async () => {
    // Models `SELECT ... FOR UPDATE`: a shared, mutable "row" plus a lock
    // queue that only lets one transaction body run at a time, mirroring
    // how Postgres would block a second transaction on the same locked row
    // until the first commits.
    const row = { lastSequence: BigInt(0), lastHash: null as string | null };
    let lockChain: Promise<unknown> = Promise.resolve();
    const created: Array<Record<string, unknown>> = [];

    jest.spyOn(service, "$transaction").mockImplementation((cb: unknown) => {
      const runExclusive = lockChain.then(async () => {
        const tx = {
          $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
            // The writer's UPDATE statement is the one carrying two bound
            // values (sequence, hash); apply it to the shared row so the
            // next queued transaction observes the advance.
            if (String(strings).includes("UPDATE")) {
              const [sequence, hash] = vals as [bigint, string];
              row.lastSequence = sequence;
              row.lastHash = hash;
            }
            return 1;
          }),
          $queryRaw: jest.fn(async () => [{ chainKey: "org-1", ...row }]),
          auditLog: {
            create: jest.fn(async (args: { data: Record<string, unknown> }) => {
              const created_row = { id: `row-${created.length + 1}`, ...args.data };
              created.push(created_row);
              return created_row;
            }),
          },
        };
        return (cb as (tx: unknown) => Promise<unknown>)(tx);
      });
      lockChain = runExclusive.catch(() => undefined);
      return runExclusive as Promise<unknown>;
    });

    const makeArgs = (n: number) =>
      ({
        data: {
          organizationId: "org-1",
          actorType: "USER",
          actorId: `user-${n}`,
          action: "CONCURRENT_ACTION",
          resourceType: "Resource",
          resourceId: `res-${n}`,
          metadata: { n },
        },
      }) as unknown as Prisma.AuditLogCreateArgs;

    await Promise.all([
      service.auditLog.create(makeArgs(1)),
      service.auditLog.create(makeArgs(2)),
    ]);

    expect(created).toHaveLength(2);
    const sequences = created
      .map((r) => r.sequence as bigint)
      .sort((a, b) => (a < b ? -1 : 1));
    expect(sequences).toEqual([BigInt(1), BigInt(2)]);

    const first = created.find((r) => r.sequence === BigInt(1))!;
    const second = created.find((r) => r.sequence === BigInt(2))!;
    expect(first.prevHash).toBeNull();
    expect(second.prevHash).toBe(first.hash);
    expect(first.hash).not.toBe(second.hash);
  });
});
