import { AnchoringOperation, AnchoringStatus } from "@prisma/client";
import { AnchoringWorkerService } from "./anchoring-worker.service";

/**
 * Backpressure behaviour (issue #203): the worker consults the contract
 * dependency circuits before claiming intents, and returns an intent unclaimed
 * — without consuming an attempt — when a call is refused by an open circuit.
 *
 * These tests drive the claim query through a captured `$queryRaw` so the exact
 * operation filter and budget are assertable, rather than needing a database.
 */

function makeConfig(enabled = true) {
  return {
    get: jest.fn((key: string) =>
      key === "contractAnchoring.enabled" ? enabled : undefined,
    ),
  };
}

/** Anchoring stub whose per-operation circuit states are scriptable. */
function makeAnchoring(states: {
  register?: string;
  revoke?: string;
  read?: string;
}) {
  return {
    anchorProof: jest.fn(),
    revokeProof: jest.fn(),
    circuitState: jest.fn((operation: string) => {
      const map: Record<string, string> = {
        register: states.register ?? "closed",
        revoke: states.revoke ?? "closed",
        read: states.read ?? "closed",
      };
      return map[operation];
    }),
  };
}

function makePrisma() {
  return {
    anchoringIntent: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

function build(states: Parameters<typeof makeAnchoring>[0], enabled = true) {
  const prisma = makePrisma();
  const anchoring = makeAnchoring(states);
  const worker = new AnchoringWorkerService(
    prisma as never,
    anchoring as never,
    makeConfig(enabled) as never,
  );
  return { worker, prisma, anchoring };
}

/** The interpolated values of the claim query, in template order. */
function claimValues(prisma: ReturnType<typeof makePrisma>): unknown[] {
  const call = prisma.$queryRaw.mock.calls[0];
  // call[0] is the template strings array; the rest are interpolated values.
  return call.slice(1);
}

describe("AnchoringWorkerService backpressure", () => {
  it("claims both operations at the full batch budget when circuits are closed", async () => {
    const { worker, prisma } = build({});
    await worker.poll();

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const values = claimValues(prisma);
    // values: [PENDING, now, allowedOperations, budget, PROCESSING, now]
    expect(values[2]).toEqual([
      AnchoringOperation.REGISTER,
      AnchoringOperation.REVOKE,
    ]);
    expect(values[3]).toBe(5);
  });

  it("does not claim anything when every contract circuit is open", async () => {
    const { worker, prisma } = build({ register: "open", revoke: "open" });
    await worker.poll();

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("excludes an operation whose circuit is open, keeping the other", async () => {
    const { worker, prisma } = build({ register: "open", revoke: "closed" });
    await worker.poll();

    const values = claimValues(prisma);
    expect(values[2]).toEqual([AnchoringOperation.REVOKE]);
    expect(values[3]).toBe(5);
  });

  it("admits a single probe when a circuit is half-open", async () => {
    const { worker, prisma } = build({ register: "half_open", revoke: "closed" });
    await worker.poll();

    const values = claimValues(prisma);
    expect(values[2]).toEqual([
      AnchoringOperation.REGISTER,
      AnchoringOperation.REVOKE,
    ]);
    // Half-open forces the whole cycle down to one probing intent.
    expect(values[3]).toBe(1);
  });

  it("releases an intent unclaimed, without consuming an attempt, on circuit_open", async () => {
    const { worker, prisma, anchoring } = build({});
    prisma.anchoringIntent.findUnique.mockResolvedValue({
      id: "intent_1",
      proofId: "proof_1",
      operation: AnchoringOperation.REGISTER,
      status: AnchoringStatus.PENDING,
      attemptCount: 2,
      proof: { commitment: "c", expiresAt: new Date() },
    });
    anchoring.anchorProof.mockResolvedValue({
      anchored: false,
      reason: "circuit_open",
    });

    await worker.processIntent("intent_1");

    // The intent is returned to PENDING; attemptCount is NOT incremented and
    // the row is not marked FAILED.
    expect(prisma.anchoringIntent.update).toHaveBeenCalledWith({
      where: { id: "intent_1" },
      data: expect.objectContaining({ status: AnchoringStatus.PENDING }),
    });
    const data = prisma.anchoringIntent.update.mock.calls[0][0].data;
    expect(data.attemptCount).toBeUndefined();
    expect(data.permanentError).toBeUndefined();
  });
});
