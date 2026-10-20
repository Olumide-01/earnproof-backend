import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import {
  Prisma,
  ProofShareScope,
  ProofStatus,
  VerificationOutcome,
} from "@prisma/client";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { VerificationEventService } from "../../audit/verification-event.service";
import { AuthenticatedUser } from "../../auth/auth.types";
import { SessionService } from "../../auth/session.service";
import { sha256 } from "../../common/crypto/hash";
import { AuthGuard } from "../../common/guards/auth.guard";
import {
  ProofShareTokensController,
  ProofSharesController,
} from "./proof-share-tokens.controller";
import { ProofShareTokensService } from "./proof-share-tokens.service";

// ---------------------------------------------------------------------------
// In-memory store with the database guarantees the service relies on:
// - `updateMany` evaluates its WHERE and applies its SET atomically;
// - the partial unique index allows one live token per (proof, scope).
// ---------------------------------------------------------------------------

type TokenRow = {
  id: string;
  proofId: string;
  ownerId: string;
  tokenHash: string;
  scope: ProofShareScope;
  label: string | null;
  maxUses: number | null;
  useCount: number;
  expiresAt: Date;
  revokedAt: Date | null;
  supersededAt: Date | null;
  supersededById: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

type ProofRow = {
  id: string;
  userId: string;
  status: ProofStatus;
  expiresAt: Date;
};

const IMMUTABLE_FIELDS = [
  "proofId",
  "ownerId",
  "tokenHash",
  "scope",
  "label",
  "maxUses",
  "expiresAt",
  "createdAt",
];

function matches(row: TokenRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key as keyof TokenRow];
    if (cond === null) return value === null;
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(value);
      if ("gt" in c) return (value as Date | number) > (c.gt as Date | number);
      if ("lt" in c) return (value as number) < (c.lt as number);
      return false;
    }
    return value === cond;
  });
}

function buildStore(proofs: ProofRow[]) {
  const tokens = new Map<string, TokenRow>();
  const audit: Array<Record<string, unknown>> = [];
  const writes: Array<Record<string, unknown>> = [];
  let seq = 0;

  const proofShareToken = {
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...tokens.values()].filter((t) => matches(t, where)),
    ),
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...tokens.values()].find((t) => matches(t, where)) ?? null,
    ),
    findUnique: jest.fn(
      async ({ where }: { where: { tokenHash: string } }) => {
        const row = [...tokens.values()].find(
          (t) => t.tokenHash === where.tokenHash,
        );
        if (!row) return null;
        const proof = proofs.find((p) => p.id === row.proofId)!;
        return { ...row, proof: { id: proof.id, userId: proof.userId } };
      },
    ),
    create: jest.fn(async ({ data }: { data: Partial<TokenRow> }) => {
      const live = [...tokens.values()].some(
        (t) =>
          t.proofId === data.proofId &&
          t.scope === data.scope &&
          t.revokedAt === null &&
          t.supersededAt === null,
      );
      if (live) {
        throw new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "test",
        });
      }
      const row = Object.assign(
        {
          id: `tok_${++seq}`,
          useCount: 0,
          revokedAt: null,
          supersededAt: null,
          supersededById: null,
          lastUsedAt: null,
          label: null,
          maxUses: null,
          createdAt: new Date(),
        },
        data,
      ) as TokenRow;
      tokens.set(row.id, row);
      return { ...row };
    }),
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        writes.push(data);
        let count = 0;
        for (const row of tokens.values()) {
          if (!matches(row, where)) continue;
          for (const [key, value] of Object.entries(data)) {
            if (IMMUTABLE_FIELDS.includes(key)) {
              throw new Error(`immutable field ${key} updated`);
            }
            const v =
              value && typeof value === "object" && "increment" in value
                ? (row[key as keyof TokenRow] as number) +
                  (value as { increment: number }).increment
                : value;
            (row as Record<string, unknown>)[key] = v;
          }
          count += 1;
        }
        return { count };
      },
    ),
  };

  const base = {
    proof: {
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; userId: string } }) =>
          proofs.find((p) => p.id === where.id && p.userId === where.userId) ??
          null,
      ),
    },
    proofShareToken,
    auditLog: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audit.push(data);
        return data;
      }),
    },
  };
  const prisma = {
    ...base,
    $transaction: jest.fn(async (fn: (tx: typeof base) => unknown) => fn(base)),
  };

  return { prisma, tokens, audit, writes };
}

const OWNER: AuthenticatedUser = {
  id: "user_owner",
  walletAddress: "GOWNER",
  walletHash: "hash_owner",
  role: "WORKER",
};
const OTHER: AuthenticatedUser = {
  id: "user_other",
  walletAddress: "GOTHER",
  walletHash: "hash_other",
  role: "WORKER",
};

const NOW = new Date("2026-09-10T12:00:00.000Z");
const PROOF_EXPIRES = new Date("2026-10-10T12:00:00.000Z");

function verificationFor(proofId: string) {
  return {
    result: "VALID",
    status: "valid",
    credential: {
      id: proofId,
      subject: { walletHash: "hash_owner" },
      proof: { signature: "hmac-sha256:sig" },
    },
    proof: {
      id: proofId,
      type: "MINIMUM_INCOME",
      schemaVersion: "earnproof.minimum-income.v1",
      network: "testnet",
      issuedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: PROOF_EXPIRES.toISOString(),
      revokedAt: null,
      contractStatus: { checked: false, reason: "disabled" },
    },
  };
}

function setup(
  proofs: ProofRow[] = [
    {
      id: "proof_1",
      userId: OWNER.id,
      status: ProofStatus.ACTIVE,
      expiresAt: PROOF_EXPIRES,
    },
    {
      id: "proof_other",
      userId: OTHER.id,
      status: ProofStatus.ACTIVE,
      expiresAt: PROOF_EXPIRES,
    },
  ],
) {
  const store = buildStore(proofs);
  const proofsService = {
    verifyProof: jest.fn(async (proofId: string) => verificationFor(proofId)),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === "proofSharing.maxTtlMinutes"
        ? 10_080
        : key === "proofSharing.defaultTtlMinutes"
          ? 1_440
          : undefined,
    ),
  };
  const service = new ProofShareTokensService(
    store.prisma as never,
    proofsService as never,
    config as never,
  );
  return { service, proofsService, ...store };
}

describe("ProofShareTokensService", () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  describe("issue", () => {
    it("returns the raw token once and persists only its hash", async () => {
      const { service, tokens, audit } = setup();

      const result = await service.issue(OWNER, "proof_1", {
        scope: ProofShareScope.VERIFY_STATUS,
      });

      expect(result.token).toMatch(/^eps_[A-Za-z0-9_-]{43}$/);
      const [row] = [...tokens.values()];
      expect(row.tokenHash).toBe(sha256(result.token));
      expect(JSON.stringify([...tokens.values()])).not.toContain(result.token);
      expect(JSON.stringify(audit)).not.toContain(result.token);
      expect(JSON.stringify(audit)).not.toContain(row.tokenHash);
      expect(result.shareToken).not.toHaveProperty("tokenHash");
      expect(result.shareToken).not.toHaveProperty("token");
      expect(result.shareToken.expiresAt).toBe("2026-09-11T12:00:00.000Z");
    });

    it("never lets a token outlive its proof", async () => {
      const { service } = setup([
        {
          id: "proof_1",
          userId: OWNER.id,
          status: ProofStatus.ACTIVE,
          expiresAt: new Date("2026-09-10T13:00:00.000Z"),
        },
      ]);

      const { shareToken } = await service.issue(OWNER, "proof_1", {
        scope: ProofShareScope.VERIFY_STATUS,
        expiresInMinutes: 10_000,
      });

      expect(shareToken.expiresAt).toBe("2026-09-10T13:00:00.000Z");
    });

    it("rejects a lifetime above the configured maximum", async () => {
      const { service, tokens } = setup();
      await expect(
        service.issue(OWNER, "proof_1", {
          scope: ProofShareScope.VERIFY_STATUS,
          expiresInMinutes: 10_081,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tokens.size).toBe(0);
    });

    it("hides another user's proof as not found (tenant isolation)", async () => {
      const { service, tokens } = setup();
      await expect(
        service.issue(OWNER, "proof_other", {
          scope: ProofShareScope.VERIFY_CREDENTIAL,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tokens.size).toBe(0);
    });

    it.each([
      ["revoked", ProofStatus.REVOKED, PROOF_EXPIRES],
      ["expired", ProofStatus.ACTIVE, new Date("2026-09-10T12:00:00.000Z")],
    ])("refuses to share a %s proof", async (_label, status, expiresAt) => {
      const { service, tokens } = setup([
        { id: "proof_1", userId: OWNER.id, status, expiresAt },
      ]);
      await expect(
        service.issue(OWNER, "proof_1", {
          scope: ProofShareScope.VERIFY_STATUS,
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(tokens.size).toBe(0);
    });

    it("supersedes the live token for the same proof and scope only", async () => {
      const { service, tokens } = setup();
      const first = await service.issue(OWNER, "proof_1", {
        scope: ProofShareScope.VERIFY_STATUS,
      });
      const other = await service.issue(OWNER, "proof_1", {
        scope: ProofShareScope.VERIFY_CREDENTIAL,
      });
      const second = await service.issue(OWNER, "proof_1", {
        scope: ProofShareScope.VERIFY_STATUS,
      });

      const firstRow = tokens.get(first.shareToken.id)!;
      expect(firstRow.supersededAt).toEqual(NOW);
      expect(firstRow.supersededById).toBe(second.shareToken.id);
      expect(tokens.get(other.shareToken.id)!.supersededAt).toBeNull();

      await expect(service.resolve(first.token)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.resolve(second.token)).resolves.toBeDefined();
      await expect(service.resolve(other.token)).resolves.toBeDefined();
    });

    it("maps a concurrent issuance collision to 409", async () => {
      const { service, prisma } = setup();
      prisma.proofShareToken.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "test",
        }),
      );
      await expect(
        service.issue(OWNER, "proof_1", {
          scope: ProofShareScope.VERIFY_STATUS,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("never writes an issuance field after creation (immutable scope)", async () => {
      const { service, writes } = setup();
      const { token } = await service.issue(OWNER, "proof_1", {
        scope: ProofShareScope.VERIFY_STATUS,
        maxUses: 3,
      });
      await service.issue(OWNER, "proof_1", {
        scope: ProofShareScope.VERIFY_STATUS,
      });
      await expect(service.resolve(token)).rejects.toThrow();

      for (const data of writes) {
        for (const field of IMMUTABLE_FIELDS) {
          expect(data).not.toHaveProperty(field);
        }
      }
    });
  });

  describe("listActive", () => {
    it("returns only live, unexpired, unexhausted tokens owned by the caller", async () => {
      const { service, tokens } = setup();
      const live = await service.issue(OWNER, "proof_1", {
        scope: ProofShareScope.VERIFY_STATUS,
      });
      const exhausted = await service.issue(OWNER, "proof_1", {
        scope: ProofShareScope.VERIFY_CREDENTIAL,
        maxUses: 1,
      });
      await service.resolve(exhausted.token);
      await service.issue(OTHER, "proof_other", {
        scope: ProofShareScope.VERIFY_STATUS,
      });
      // An expired row for the owner.
      tokens.set("tok_expired", {
        ...tokens.get(live.shareToken.id)!,
        id: "tok_expired",
        scope: ProofShareScope.VERIFY_CREDENTIAL,
        tokenHash: "x",
        expiresAt: new Date(NOW.getTime() - 1),
      });

      const listed = await service.listActive(OWNER, "proof_1");

      expect(listed.map((t) => t.id)).toEqual([live.shareToken.id]);
      expect(JSON.stringify(listed)).not.toMatch(/tokenHash|eps_/);
    });

    it("refuses to list another user's proof", async () => {
      const { service } = setup();
      await service.issue(OTHER, "proof_other", {
        scope: ProofShareScope.VERIFY_STATUS,
      });
      await expect(
        service.listActive(OWNER, "proof_other"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("revoke", () => {
    it("fails closed immediately and is idempotent", async () => {
      const { service, audit } = setup();
      const { token, shareToken } = await service.issue(OWNER, "proof_1", {
        scope: ProofShareScope.VERIFY_STATUS,
      });

      const first = await service.revoke(OWNER, "proof_1", shareToken.id);
      const again = await service.revoke(OWNER, "proof_1", shareToken.id);

      expect(first.revokedAt).toEqual(NOW);
      expect(again.revokedAt).toEqual(NOW);
      expect(
        audit.filter((a) => a.action === "proof.share_token.revoked"),
      ).toHaveLength(1);
      await expect(service.resolve(token)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("cannot revoke another user's token, which stays usable", async () => {
      const { service } = setup();
      const other = await service.issue(OTHER, "proof_other", {
        scope: ProofShareScope.VERIFY_STATUS,
      });

      await expect(
        service.revoke(OWNER, "proof_other", other.shareToken.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Addressing it through the owner's own proof id does not help either.
      await expect(
        service.revoke(OWNER, "proof_1", other.shareToken.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.resolve(other.token)).resolves.toBeDefined();
    });
  });

  describe("resolve", () => {
    it("VERIFY_STATUS discloses the result and public metadata only", async () => {
      const { service, proofsService, tokens } = setup();
      const { token, shareToken } = await service.issue(OWNER, "proof_1", {
        scope: ProofShareScope.VERIFY_STATUS,
      });

      const result = await service.resolve(token);

      expect(result).toEqual({
        scope: ProofShareScope.VERIFY_STATUS,
        result: "VALID",
        status: "valid",
        shareExpiresAt: "2026-09-11T12:00:00.000Z",
        proof: {
          type: "MINIMUM_INCOME",
          schemaVersion: "earnproof.minimum-income.v1",
          network: "testnet",
          issuedAt: "2026-09-01T00:00:00.000Z",
          expiresAt: PROOF_EXPIRES.toISOString(),
          revokedAt: null,
        },
      });
      expect(JSON.stringify(result)).not.toMatch(/proof_1|walletHash|signature/);
      expect(proofsService.verifyProof).toHaveBeenCalledWith("proof_1", {
        shareTokenId: shareToken.id,
      });
      expect(tokens.get(shareToken.id)!.useCount).toBe(1);
      expect(tokens.get(shareToken.id)!.lastUsedAt).toEqual(NOW);
    });

    it("VERIFY_CREDENTIAL also discloses the signed credential", async () => {
      const { service } = setup();
      const { token } = await service.issue(OWNER, "proof_1", {
        scope: ProofShareScope.VERIFY_CREDENTIAL,
      });

      const result = await service.resolve(token);

      expect(result).toMatchObject({
        scope: ProofShareScope.VERIFY_CREDENTIAL,
        proof: { id: "proof_1" },
        credential: { id: "proof_1" },
      });
      expect(result.proof).not.toHaveProperty("contractStatus");
    });

    it("is valid one millisecond before expiry and invalid at expiry", async () => {
      const { service } = setup();
      const { token } = await service.issue(OWNER, "proof_1", {
        scope: ProofShareScope.VERIFY_STATUS,
        expiresInMinutes: 5,
      });
      const expiry = NOW.getTime() + 5 * 60_000;

      jest.setSystemTime(expiry - 1);
      await expect(service.resolve(token)).resolves.toBeDefined();

      jest.setSystemTime(expiry);
      await expect(service.resolve(token)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("refuses replay beyond maxUses", async () => {
      const { service, proofsService } = setup();
      const { token } = await service.issue(OWNER, "proof_1", {
        scope: ProofShareScope.VERIFY_STATUS,
        maxUses: 1,
      });

      await expect(service.resolve(token)).resolves.toBeDefined();
      await expect(service.resolve(token)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(proofsService.verifyProof).toHaveBeenCalledTimes(1);
    });

    it("allows exactly maxUses concurrent resolutions", async () => {
      const { service, tokens } = setup();
      const { token, shareToken } = await service.issue(OWNER, "proof_1", {
        scope: ProofShareScope.VERIFY_STATUS,
        maxUses: 3,
      });

      const outcomes = await Promise.allSettled(
        Array.from({ length: 10 }, () => service.resolve(token)),
      );

      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(3);
      expect(tokens.get(shareToken.id)!.useCount).toBe(3);
    });

    it("fails closed when revoked between lookup and consumption", async () => {
      const { service, prisma, proofsService } = setup();
      const { token, shareToken } = await service.issue(OWNER, "proof_1", {
        scope: ProofShareScope.VERIFY_STATUS,
      });
      const realFind = prisma.proofShareToken.findUnique.getMockImplementation()!;
      prisma.proofShareToken.findUnique.mockImplementationOnce(async (args: { where: { tokenHash: string } }) => {
        const snapshot = await realFind(args);
        await service.revoke(OWNER, "proof_1", shareToken.id);
        return snapshot;
      });

      await expect(service.resolve(token)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(proofsService.verifyProof).not.toHaveBeenCalled();
    });

    it("gives the same answer for every unusable token", async () => {
      const { service, prisma } = setup();
      const inputs = [
        "",
        "not-a-token",
        `eps_${"A".repeat(43)}`, // well-formed, unknown
        `${"a".repeat(16)}.${"b".repeat(64)}`, // session-token shaped
      ];
      const messages = new Set<string>();
      for (const input of inputs) {
        const error = await service.resolve(input).catch((e: Error) => e);
        expect(error).toBeInstanceOf(NotFoundException);
        messages.add((error as Error).message);
      }
      expect(messages.size).toBe(1);
      // Malformed inputs never reach the database.
      expect(prisma.proofShareToken.findUnique).toHaveBeenCalledTimes(1);
    });

    it("refuses a token whose proof no longer belongs to the issuing owner", async () => {
      const { service, tokens } = setup();
      const { token, shareToken } = await service.issue(OWNER, "proof_1", {
        scope: ProofShareScope.VERIFY_STATUS,
      });
      tokens.get(shareToken.id)!.ownerId = OTHER.id;

      await expect(service.resolve(token)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});

describe("share tokens and sessions are not interchangeable", () => {
  it("a share token is rejected by the session layer before any lookup", async () => {
    const prisma = { authSession: { findUnique: jest.fn() } };
    const sessions = new SessionService(prisma as never, {
      getOrThrow: () => "session_secret_123",
      get: () => undefined,
    } as never);

    await expect(
      sessions.validate(`eps_${"A".repeat(43)}`),
    ).rejects.toThrow("Malformed session token");
    expect(prisma.authSession.findUnique).not.toHaveBeenCalled();
  });

  it("the public resolve route has no auth guard; owner routes do", () => {
    const publicGuards =
      Reflect.getMetadata(GUARDS_METADATA, ProofSharesController) ?? [];
    const resolveGuards =
      Reflect.getMetadata(
        GUARDS_METADATA,
        ProofSharesController.prototype.resolve,
      ) ?? [];
    expect([...publicGuards, ...resolveGuards]).toEqual([]);

    expect(
      Reflect.getMetadata(GUARDS_METADATA, ProofShareTokensController),
    ).toEqual([AuthGuard]);
  });
});

describe("share-token usage in verification events", () => {
  it("records the token row id, never the token, alongside the outcome", async () => {
    const create = jest.fn().mockResolvedValue({});
    const events = new VerificationEventService(
      { verificationEventLog: { create } } as never,
      {
        get: (key: string) =>
          key === "credentialSigningSecret" ? "salt_secret" : undefined,
      } as never,
    );

    await events.recordEvent(
      VerificationOutcome.VALID,
      "proof_1",
      { outcome: "VALID" },
      { shareTokenId: "tok_1" },
    );
    await events.recordEvent(VerificationOutcome.VALID, "proof_1", {
      outcome: "VALID",
    });

    expect(create.mock.calls[0][0].data.shareTokenId).toBe("tok_1");
    expect(create.mock.calls[1][0].data.shareTokenId).toBeNull();
  });
});

describe("share-token immutability at the database layer", () => {
  it("the migration installs a trigger rejecting issuance-field updates", () => {
    const migrations = join(__dirname, "..", "..", "..", "prisma", "migrations");
    const dir = readdirSync(migrations).find((d) =>
      d.endsWith("_proof_share_tokens"),
    )!;
    const sql = readFileSync(join(migrations, dir, "migration.sql"), "utf8");

    expect(sql).toMatch(/BEFORE UPDATE ON "ProofShareToken"/);
    for (const field of IMMUTABLE_FIELDS) {
      expect(sql).toContain(`NEW."${field}"`);
    }
    expect(sql).toMatch(
      /UNIQUE INDEX "ProofShareToken_live_proof_scope_key"[\s\S]*WHERE "revokedAt" IS NULL AND "supersededAt" IS NULL/,
    );
  });
});
