import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
  BadRequestException,
} from "@nestjs/common";
import {
  AnchoringOperation,
  Prisma,
  ProofStatus,
  ProofType,
  VerificationResult,
} from "@prisma/client";
import { VerificationEventService } from "../audit/verification-event.service";
import {
  evaluateRenewalEligibility,
  evaluateSupersessionCompatibility,
  MAX_SUPERSESSION_CHAIN_DEPTH,
  RENEWAL_GRACE_PERIOD_DAYS,
  renewalRequestHash,
  RenewableProof,
  wouldCreateCycle,
} from "./proof-renewal.policy";
import { ProofsService } from "./proofs.service";

const DAY_MS = 86_400_000;
const OWNER = {
  id: "user_owner",
  walletAddress: "GOWNER",
  walletHash: "sha256:owner-wallet",
  role: "WORKER",
};
const STRANGER = {
  id: "user_stranger",
  walletAddress: "GSTRANGER",
  walletHash: "sha256:stranger-wallet",
  role: "WORKER",
};

type Row = Record<string, unknown> & { id: string };
type Claim = Record<string, unknown> & { proofId: string };
type Callback = (tx: unknown) => Promise<unknown>;

/**
 * In-memory Prisma double covering exactly the proof queries renewal uses.
 *
 * It enforces the two properties the real database provides and renewal
 * depends on: `supersedesId` is unique (P2002 on a second successor), and a
 * `$transaction` that throws leaves no writes behind.
 */
function createStore(options: { bypassSupersededGuard?: boolean } = {}) {
  let proofs = new Map<string, Row>();
  let claims = new Map<string, Claim>();
  let intents: Array<{ proofId: string; operation: AnchoringOperation }> = [];
  const walletHashes = new Map([
    [OWNER.id, OWNER.walletHash],
    [STRANGER.id, STRANGER.walletHash],
  ]);
  const verificationEvents: unknown[] = [];
  let lock: Promise<unknown> = Promise.resolve();

  const successorOf = (id: string) =>
    [...proofs.values()].find((row) => row.supersedesId === id) ?? null;

  function project(
    row: Row | null,
    spec: Record<string, unknown> = {},
  ): Record<string, unknown> | null {
    if (!row) return null;
    const select = spec.select as Record<string, unknown> | undefined;
    const include = spec.include as Record<string, unknown> | undefined;
    const relation = (key: string, value: unknown): unknown => {
      if (key === "claim") return claims.get(row.id) ?? null;
      if (key === "user") return { walletHash: walletHashes.get(row.userId as string) };
      if (key === "supersededBy") {
        return project(successorOf(row.id), value === true ? {} : (value as Record<string, unknown>));
      }
      return undefined;
    };

    if (select) {
      return Object.fromEntries(
        Object.entries(select).map(([key, value]): [string, unknown] => [
          key,
          key in row ? row[key] : relation(key, value),
        ]),
      );
    }
    const result: Record<string, unknown> = { ...row };
    for (const [key, value] of Object.entries(include ?? {})) {
      result[key] = relation(key, value);
    }
    return result;
  }

  function matches(row: Row, where: Record<string, unknown>) {
    return Object.entries(where).every(([key, expected]) => {
      if (expected && typeof expected === "object" && !(expected instanceof Date)) {
        const notIn = (expected as { notIn?: unknown[] }).notIn;
        return notIn ? !notIn.includes(row[key]) : true;
      }
      return (row[key] ?? null) === expected;
    });
  }

  const proofDelegate = {
    findUnique: jest.fn(async (args: { where: { id: string } }) =>
      project(proofs.get(args.where.id) ?? null, args as never),
    ),
    findUniqueOrThrow: jest.fn(async (args: { where: { id: string } }) => {
      const row = proofs.get(args.where.id);
      if (!row) throw new Error("not found");
      return project(row, args as never);
    }),
    findFirst: jest.fn(async (args: { where: Record<string, unknown> }) =>
      project(
        [...proofs.values()].find((row) => matches(row, args.where)) ?? null,
        args as never,
      ),
    ),
    updateMany: jest.fn(
      async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const targets = [...proofs.values()].filter((row) => {
          const where = options.bypassSupersededGuard
            ? Object.fromEntries(
                Object.entries(args.where).filter(([key]) => key !== "supersededAt"),
              )
            : args.where;
          return matches(row, where);
        });
        for (const row of targets) Object.assign(row, args.data);
        return { count: targets.length };
      },
    ),
    create: jest.fn(async (args: { data: Record<string, unknown> }) => {
      const { claim, ...data } = args.data as Record<string, unknown> & {
        claim?: { create: Record<string, unknown> };
      };
      if (data.supersedesId && successorOf(data.supersedesId as string)) {
        throw new Prisma.PrismaClientKnownRequestError(
          "Unique constraint failed on the fields: (`supersedesId`)",
          { code: "P2002", clientVersion: "test" },
        );
      }
      const row: Row = {
        contractTransactionHash: null,
        revokedAt: null,
        supersededAt: null,
        renewalRequestHash: null,
        commitment: null,
        ...data,
        id: data.id as string,
      };
      proofs.set(row.id, row);
      if (claim) claims.set(row.id, { ...claim.create, proofId: row.id });
      return { ...row };
    }),
  };

  const prisma: {
    proof: typeof proofDelegate;
    anchoringIntent: { create: jest.Mock };
    verificationEvent: { create: jest.Mock };
    $transaction: jest.Mock<Promise<unknown>, [Callback]>;
  } = {
    proof: proofDelegate,
    anchoringIntent: {
      create: jest.fn(async (args: { data: { proofId: string; operation: AnchoringOperation } }) => {
        intents.push(args.data);
        return args.data;
      }),
    },
    verificationEvent: {
      create: jest.fn(async (args: unknown) => {
        verificationEvents.push(args);
        return args;
      }),
    },
    // Transactions run one at a time, as conflicting row locks force them to
    // in PostgreSQL; a throwing callback rolls its writes back.
    $transaction: jest.fn((callback: Callback): Promise<unknown> => {
      const run: Promise<unknown> = lock.then(() => execute(callback));
      lock = run.catch(() => undefined);
      return run;
    }),
  };

  async function execute(callback: Callback): Promise<unknown> {
    {
      const snapshot = {
        proofs: new Map([...proofs].map(([k, v]) => [k, { ...v }])),
        claims: new Map(claims),
        intents: [...intents],
      };
      try {
        return await callback(prisma);
      } catch (error) {
        proofs = snapshot.proofs;
        claims = snapshot.claims;
        intents = snapshot.intents;
        throw error;
      }
    }
  }

  return {
    prisma,
    proofs: () => proofs,
    claims: () => claims,
    intents: () => intents,
    verificationEvents,
    seed(overrides: Partial<Row> & { id: string }, claim: Partial<Claim> = {}) {
      const row: Row = {
        userId: OWNER.id,
        proofType: ProofType.MINIMUM_INCOME,
        schemaVersion: "earnproof.minimum-income.v1",
        status: ProofStatus.ACTIVE,
        network: "testnet",
        assetCode: "USDC",
        assetIssuer: "GISSUER",
        periodStart: new Date("2026-08-01T00:00:00.000Z"),
        periodEnd: new Date("2026-08-31T23:59:59.000Z"),
        expiresAt: new Date(Date.now() + 10 * DAY_MS),
        createdAt: new Date(Date.now() - 20 * DAY_MS),
        commitment: null,
        credentialHash: `sha256:seed-${overrides.id}`,
        contractTransactionHash: null,
        revokedAt: null,
        supersedesId: null,
        supersededAt: null,
        renewalRequestHash: null,
        ...overrides,
      };
      proofs.set(row.id, row);
      claims.set(row.id, {
        proofId: row.id,
        operator: "gte",
        thresholdEncrypted: `redacted:${Buffer.from("150").toString("base64url")}`,
        frequency: null,
        result: true,
        disclosurePolicy: {
          exactIncomeHidden: true,
          sourceTransactionsHidden: true,
          qualifyingPaymentCount: 2,
        },
        ...claim,
      });
      return row;
    },
  };
}

function createService(
  store: ReturnType<typeof createStore>,
  config: { anchoringEnabled?: boolean } = {},
) {
  const verificationEvents = {
    recordEvent: jest.fn().mockResolvedValue(undefined),
    getAggregateStats: jest.fn(),
  } as unknown as VerificationEventService;

  return new ProofsService(
    store.prisma as never,
    {
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, string> = {
          credentialSigningSecret: "renewal-signing-secret",
          paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
          "stellar.network": "testnet",
        };
        return values[key];
      }),
      get: jest.fn((key: string) => {
        const values: Record<string, boolean | string | undefined> = {
          paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
          "contractAnchoring.enabled": config.anchoringEnabled ?? false,
          "contractAnchoring.required": false,
        };
        return values[key];
      }),
    } as never,
    verificationEvents,
  );
}

function asRenewable(row: Row, claim?: Partial<Claim>): RenewableProof {
  return {
    ...(row as unknown as RenewableProof),
    claim: {
      operator: "gte",
      frequency: null,
      disclosurePolicy: { exactIncomeHidden: true, sourceTransactionsHidden: true },
      ...(claim as object),
    } as RenewableProof["claim"],
  };
}

describe("proof renewal", () => {
  describe("valid renewal", () => {
    it("issues a successor with the same claim, links it, and it verifies", async () => {
      const store = createStore();
      store.seed({ id: "proof_a" });
      const service = createService(store);

      const renewed = await service.renewProof(OWNER, "proof_a", { expiresInDays: 14 });

      expect(renewed).toMatchObject({
        predecessorId: "proof_a",
        status: ProofStatus.ACTIVE,
        mode: "issued",
        replayed: false,
      });
      const successor = store.proofs().get(renewed.proofId)!;
      const predecessor = store.proofs().get("proof_a")!;
      expect(successor.supersedesId).toBe("proof_a");
      expect(predecessor.supersededAt).toBeInstanceOf(Date);
      // Predecessor stays ACTIVE: supersession is metadata, not revocation.
      expect(predecessor.status).toBe(ProofStatus.ACTIVE);
      for (const field of ["proofType", "schemaVersion", "network", "assetCode", "assetIssuer"]) {
        expect(successor[field]).toEqual(predecessor[field]);
      }
      expect(
        (successor.expiresAt as Date).getTime() - (successor.createdAt as Date).getTime(),
      ).toBe(14 * DAY_MS);
      expect(renewed.credential.claim).toMatchObject({ thresholdAmount: "150" });
      expect(renewed.credential.proof.signature).toMatch(/^hmac-sha256:/);

      // The successor is rebuilt by the same code verification uses, so the
      // stored hash must reproduce exactly.
      const verification = await service.verifyProof(renewed.proofId);
      expect(verification.result).toBe(VerificationResult.VALID);
    });

    it("enqueues REGISTER anchoring for the successor only when anchoring is enabled", async () => {
      const store = createStore();
      store.seed({ id: "proof_a" });

      const renewed = await createService(store, { anchoringEnabled: true }).renewProof(
        OWNER,
        "proof_a",
        {},
      );

      expect(store.intents()).toEqual([
        { proofId: renewed.proofId, operation: AnchoringOperation.REGISTER, status: "PENDING" },
      ]);
      expect(renewed.anchoring).toEqual({ anchored: false, reason: "pending" });
    });

    it("links an existing compatible proof as successor", async () => {
      const store = createStore();
      store.seed({ id: "proof_a" });
      store.seed({ id: "proof_b", createdAt: new Date() });

      const renewed = await createService(store).renewProof(OWNER, "proof_a", {
        successorProofId: "proof_b",
      });

      expect(renewed).toMatchObject({ proofId: "proof_b", mode: "linked" });
      expect(store.proofs().get("proof_b")!.supersedesId).toBe("proof_a");
      expect(store.proofs().size).toBe(2);
    });
  });

  describe("authorization", () => {
    it("rejects renewal by a non-owner without writing anything", async () => {
      const store = createStore();
      store.seed({ id: "proof_a" });

      await expect(
        createService(store).renewProof(STRANGER, "proof_a", {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(store.prisma.$transaction).not.toHaveBeenCalled();
      expect(store.proofs().get("proof_a")!.supersededAt).toBeNull();
    });

    it("rejects eligibility checks by a non-owner", async () => {
      const store = createStore();
      store.seed({ id: "proof_a" });

      await expect(
        createService(store).getRenewalEligibility(STRANGER.id, "proof_a"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("returns not found for unknown proofs", async () => {
      await expect(
        createService(createStore()).renewProof(OWNER, "missing", {}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("hides another user's proof when used as the successor", async () => {
      const store = createStore();
      store.seed({ id: "proof_a" });
      store.seed({ id: "proof_other", userId: STRANGER.id, createdAt: new Date() });

      await expect(
        createService(store).renewProof(OWNER, "proof_a", {
          successorProofId: "proof_other",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(store.proofs().get("proof_a")!.supersededAt).toBeNull();
    });
  });

  describe("incompatible predecessor", () => {
    it.each([
      ["proof type", { proofType: ProofType.RECURRING_INCOME }, {}, "proof_type_mismatch"],
      ["asset code", { assetCode: "XLM" }, {}, "asset_mismatch"],
      ["asset issuer", { assetIssuer: "GOTHER" }, {}, "asset_mismatch"],
      ["network", { network: "mainnet" }, {}, "network_mismatch"],
      ["schema version", { schemaVersion: "earnproof.minimum-income.v2" }, {}, "policy_mismatch"],
      [
        "disclosure policy",
        {},
        { disclosurePolicy: { exactIncomeHidden: false, sourceTransactionsHidden: true } },
        "policy_mismatch",
      ],
      ["claim operator", {}, { operator: "lte" }, "policy_mismatch"],
      ["inactive successor", { status: ProofStatus.REVOKED }, {}, "successor_not_active"],
      ["expired successor", { expiresAt: new Date(Date.now() - 1) }, {}, "successor_expired"],
      ["older successor", { createdAt: new Date(Date.now() - 99 * DAY_MS) }, {}, "successor_predates_predecessor"],
    ])("rejects a successor with a different %s", async (_label, row, claim, reason) => {
      const store = createStore();
      store.seed({ id: "proof_a" });
      store.seed({ id: "proof_b", createdAt: new Date(), ...row }, claim);

      const attempt = createService(store).renewProof(OWNER, "proof_a", {
        successorProofId: "proof_b",
      });

      await expect(attempt).rejects.toBeInstanceOf(UnprocessableEntityException);
      await expect(attempt).rejects.toThrow(reason);
      expect(store.proofs().get("proof_a")!.supersededAt).toBeNull();
      expect(store.proofs().get("proof_b")!.supersedesId).toBeNull();
    });

    it("reports issuer mismatch and every other dimension in one pass", () => {
      const base = asRenewable({
        id: "a",
        userId: "u",
        proofType: ProofType.MINIMUM_INCOME,
        schemaVersion: "v1",
        status: ProofStatus.ACTIVE,
        network: "testnet",
        assetCode: "USDC",
        assetIssuer: null,
        expiresAt: new Date(Date.now() + DAY_MS),
        createdAt: new Date(0),
        supersedesId: null,
        supersededAt: null,
      });
      const other = {
        ...base,
        id: "b",
        userId: "v",
        proofType: ProofType.PAYMENT_RECEIPT,
        network: "mainnet",
        assetCode: "XLM",
        createdAt: new Date(1),
      };

      expect(
        evaluateSupersessionCompatibility(base, other, new Date(), false),
      ).toEqual([
        "owner_mismatch",
        "proof_type_mismatch",
        "asset_mismatch",
        "network_mismatch",
      ]);
      // Rows carry no issuer today, so both default to this backend...
      expect(
        evaluateSupersessionCompatibility(base, { ...base, id: "c" }, new Date(), false),
      ).not.toContain("issuer_mismatch");
      // ...but an explicit issuer is enforced rather than assumed.
      expect(
        evaluateSupersessionCompatibility(
          base,
          { ...base, id: "c", issuer: "another-issuer" },
          new Date(),
          false,
        ),
      ).toContain("issuer_mismatch");
    });
  });

  describe("renewal chains", () => {
    it("renews a successor again, forming an ordered chain", async () => {
      const store = createStore();
      store.seed({ id: "proof_a" });
      const service = createService(store);

      const first = await service.renewProof(OWNER, "proof_a", {});
      const second = await service.renewProof(OWNER, first.proofId, {});

      expect(store.proofs().get(second.proofId)!.supersedesId).toBe(first.proofId);
      expect(store.proofs().get(first.proofId)!.supersedesId).toBe("proof_a");

      const middle = await service.getRenewalEligibility(OWNER.id, first.proofId);
      expect(middle).toMatchObject({
        eligible: false,
        reasons: ["already_superseded"],
        supersession: { supersedesId: "proof_a", supersededById: second.proofId },
      });
      const leaf = await service.getRenewalEligibility(OWNER.id, second.proofId);
      expect(leaf).toMatchObject({ eligible: true, reasons: [] });
    });
  });

  describe("conflicting forks", () => {
    it("refuses a different second renewal of the same predecessor", async () => {
      const store = createStore();
      store.seed({ id: "proof_a" });
      const service = createService(store);

      await service.renewProof(OWNER, "proof_a", { expiresInDays: 10 });

      await expect(
        service.renewProof(OWNER, "proof_a", { expiresInDays: 20 }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(
        [...store.proofs().values()].filter((row) => row.supersedesId === "proof_a"),
      ).toHaveLength(1);
    });

    it("refuses to link a successor that already supersedes another proof", async () => {
      const store = createStore();
      store.seed({ id: "proof_a" });
      store.seed({ id: "proof_x" });
      store.seed({ id: "proof_b", createdAt: new Date(), supersedesId: "proof_x" });

      await expect(
        createService(store).renewProof(OWNER, "proof_a", { successorProofId: "proof_b" }),
      ).rejects.toThrow("successor_already_linked");
    });
  });

  describe("expiry", () => {
    it("renews an expired proof inside the grace period", async () => {
      const store = createStore();
      store.seed({
        id: "proof_a",
        status: ProofStatus.EXPIRED,
        expiresAt: new Date(Date.now() - (RENEWAL_GRACE_PERIOD_DAYS - 1) * DAY_MS),
      });

      const renewed = await createService(store).renewProof(OWNER, "proof_a", {});
      expect(renewed.status).toBe(ProofStatus.ACTIVE);
    });

    it("refuses once the grace period has elapsed", async () => {
      const store = createStore();
      store.seed({
        id: "proof_a",
        expiresAt: new Date(Date.now() - RENEWAL_GRACE_PERIOD_DAYS * DAY_MS - 1),
      });

      await expect(
        createService(store).renewProof(OWNER, "proof_a", {}),
      ).rejects.toThrow("expired_beyond_grace");
    });

    it("treats the grace boundary itself as expired", () => {
      const expiresAt = new Date("2026-01-01T00:00:00.000Z");
      const boundary = new Date(expiresAt.getTime() + RENEWAL_GRACE_PERIOD_DAYS * DAY_MS);

      expect(
        evaluateRenewalEligibility(
          { status: ProofStatus.ACTIVE, expiresAt, supersededAt: null },
          new Date(boundary.getTime() - 1),
          false,
        ).eligible,
      ).toBe(true);
      expect(
        evaluateRenewalEligibility(
          { status: ProofStatus.ACTIVE, expiresAt, supersededAt: null },
          boundary,
          false,
        ).reasons,
      ).toEqual(["expired_beyond_grace"]);
    });
  });

  describe("revocation", () => {
    it.each([
      [ProofStatus.REVOKED, "revoked"],
      [ProofStatus.INVALID, "invalid"],
    ])("refuses to renew a %s proof", async (status, reason) => {
      const store = createStore();
      store.seed({ id: "proof_a", status });

      await expect(
        createService(store).renewProof(OWNER, "proof_a", {}),
      ).rejects.toThrow(reason);
      expect(store.proofs().size).toBe(1);
    });

    it("refuses when the predecessor is revoked between check and commit", async () => {
      const store = createStore();
      store.seed({ id: "proof_a" });
      const service = createService(store);
      const original = store.prisma.$transaction.getMockImplementation()!;
      store.prisma.$transaction.mockImplementationOnce(async (callback: Callback) => {
        store.proofs().get("proof_a")!.status = ProofStatus.REVOKED;
        return original(callback);
      });

      await expect(service.renewProof(OWNER, "proof_a", {})).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(store.proofs().size).toBe(1);
    });
  });

  describe("idempotency", () => {
    it("replays an identical request instead of creating a second successor", async () => {
      const store = createStore();
      store.seed({ id: "proof_a" });
      const service = createService(store);

      const first = await service.renewProof(OWNER, "proof_a", { expiresInDays: 7 }, "key-1");
      const again = await service.renewProof(OWNER, "proof_a", { expiresInDays: 7 }, "key-1");

      expect(again).toMatchObject({ proofId: first.proofId, replayed: true, mode: "issued" });
      expect(again.credential.proof.credentialHash).toBe(first.credential.proof.credentialHash);
      expect(store.proofs().size).toBe(2);
    });

    it("replays a linked renewal as linked", async () => {
      const store = createStore();
      store.seed({ id: "proof_a" });
      store.seed({ id: "proof_b", createdAt: new Date() });
      const service = createService(store);

      await service.renewProof(OWNER, "proof_a", { successorProofId: "proof_b" });
      await expect(
        service.renewProof(OWNER, "proof_a", { successorProofId: "proof_b" }),
      ).resolves.toMatchObject({ proofId: "proof_b", replayed: true, mode: "linked" });
    });

    it("treats a different Idempotency-Key as a conflicting request", async () => {
      const store = createStore();
      store.seed({ id: "proof_a" });
      const service = createService(store);

      await service.renewProof(OWNER, "proof_a", {}, "key-1");
      await expect(
        service.renewProof(OWNER, "proof_a", {}, "key-2"),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("scopes the request hash to the owner", () => {
      const shared = { predecessorId: "p", idempotencyKey: "k" };
      expect(renewalRequestHash({ ...shared, userId: "a" })).not.toBe(
        renewalRequestHash({ ...shared, userId: "b" }),
      );
    });

    it.each(["", "   ", "k".repeat(129)])(
      "rejects an invalid Idempotency-Key %j",
      async (key) => {
        const store = createStore();
        store.seed({ id: "proof_a" });
        await expect(
          createService(store).renewProof(OWNER, "proof_a", {}, key),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );
  });

  describe("cycle prevention", () => {
    it("refuses to link an ancestor as a successor", async () => {
      const store = createStore();
      // Chain: root <- mid <- leaf. Linking leaf -> root would close a loop.
      store.seed({ id: "root", createdAt: new Date(Date.now() - DAY_MS) });
      store.seed({ id: "mid", supersedesId: "root" });
      store.seed({ id: "leaf", supersedesId: "mid" });
      // Make root look like an otherwise-valid, unlinked, newer leaf so the
      // cycle check is the only thing standing in the way.
      Object.assign(store.proofs().get("root")!, { supersededAt: null });
      Object.assign(store.proofs().get("leaf")!, { createdAt: new Date(Date.now() - 2 * DAY_MS) });

      await expect(
        createService(store).renewProof(OWNER, "leaf", { successorProofId: "root" }),
      ).rejects.toThrow("supersession_cycle");
    });

    it("refuses a proof as its own successor", async () => {
      const store = createStore();
      store.seed({ id: "proof_a" });

      await expect(
        createService(store).renewProof(OWNER, "proof_a", { successorProofId: "proof_a" }),
      ).rejects.toThrow("same_proof");
    });

    it("detects cycles and treats a corrupt or runaway chain as one", async () => {
      const chain: Record<string, string | null> = { c: "b", b: "a", a: null };
      await expect(wouldCreateCycle("c", "a", async (id) => chain[id])).resolves.toBe(true);
      await expect(wouldCreateCycle("c", "z", async (id) => chain[id])).resolves.toBe(false);

      const loop: Record<string, string> = { x: "y", y: "x" };
      await expect(wouldCreateCycle("x", "z", async (id) => loop[id])).resolves.toBe(true);

      let reads = 0;
      await expect(
        wouldCreateCycle("n0", "z", async () => `n${++reads}`),
      ).resolves.toBe(true);
      expect(reads).toBe(MAX_SUPERSESSION_CHAIN_DEPTH);
    });
  });

  describe("concurrent renewal attempts", () => {
    it("lets exactly one of several different concurrent renewals win", async () => {
      const store = createStore();
      store.seed({ id: "proof_a" });
      const service = createService(store);

      const results = await Promise.allSettled([
        service.renewProof(OWNER, "proof_a", { expiresInDays: 5 }),
        service.renewProof(OWNER, "proof_a", { expiresInDays: 6 }),
        service.renewProof(OWNER, "proof_a", { expiresInDays: 7 }),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      expect(rejected).toHaveLength(2);
      for (const failure of rejected) {
        expect(failure.reason).toBeInstanceOf(ConflictException);
      }
      expect(
        [...store.proofs().values()].filter((row) => row.supersedesId === "proof_a"),
      ).toHaveLength(1);
    });

    it("answers identical concurrent requests with the single winner's successor", async () => {
      const store = createStore();
      store.seed({ id: "proof_a" });
      const service = createService(store);

      const [one, two] = await Promise.all([
        service.renewProof(OWNER, "proof_a", {}, "same-key"),
        service.renewProof(OWNER, "proof_a", {}, "same-key"),
      ]);

      expect(one.proofId).toBe(two.proofId);
      expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
      expect(store.proofs().size).toBe(2);
    });

    it("falls back to the unique constraint (P2002) when the row guard is lost", async () => {
      // Simulates two transactions that both passed the conditional update
      // (e.g. a weaker isolation level): the unique index on supersedesId is
      // the last line of defence and must still yield one successor.
      const store = createStore({ bypassSupersededGuard: true });
      store.seed({ id: "proof_a" });
      const service = createService(store);

      // Concurrent, so both pass the pre-transaction "already superseded" read.
      const [first, second] = await Promise.allSettled([
        service.renewProof(OWNER, "proof_a", {}, "k1"),
        service.renewProof(OWNER, "proof_a", {}, "k2"),
      ]);

      expect(first.status).toBe("fulfilled");
      expect(second.status).toBe("rejected");
      expect((second as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
      expect(store.prisma.proof.create).toHaveBeenCalledTimes(2);
      expect(store.proofs().size).toBe(2);
    });
  });
});
