import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma, WalletRotationStatus } from "@prisma/client";
import { Keypair } from "@stellar/stellar-base";
import { sha256 } from "../common/crypto/hash";
import { FixedClock } from "../../test/time/fixed-clock";
import { AuthenticatedUser } from "./auth.types";
import {
  WALLET_ROTATION_TTL_MS,
  WalletRotationFailure,
  WalletRotationService,
} from "./wallet-rotation.service";
import { sep53MessageHash } from "./wallet-signature";

const NETWORK = "Test SDF Network ; September 2015";
const APP_URL = "http://localhost:3000";

const currentKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 31));
const replacementKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 32));
const strangerKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 33));

const walletHash = (address: string) => `sha256:${sha256(address)}`;

function sign(key: Keypair, message: string): string {
  return key.sign(sep53MessageHash(message)).toString("base64");
}

type Row = Record<string, unknown>;

/**
 * A small in-memory stand-in for the tables the rotation touches.
 *
 * Conditional `updateMany` calls are atomic (JavaScript runs each one to
 * completion), and `$transaction` restores a snapshot when its callback
 * throws, so replay, concurrency and partial-failure behaviour are exercised
 * for real rather than asserted against mock call lists.
 */
class Store {
  users: Row[] = [];
  sessions: Row[] = [];
  rotations: Row[] = [];
  audit: Row[] = [];
  failAudit = false;
  failUserUpdateWith?: Error;

  private matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, condition]) => {
      const value = row[key];
      if (condition && typeof condition === "object" && !(condition instanceof Date)) {
        const c = condition as { gt?: Date; not?: unknown };
        if ("gt" in c) return value instanceof Date && value > (c.gt as Date);
        if ("not" in c) return value !== c.not;
      }
      return value === condition;
    });
  }

  private table(rows: Row[], defaults: Row = {}) {
    return {
      findUnique: async ({ where }: { where: Row }) =>
        rows.find((row) => this.matches(row, where)) ?? null,
      create: async ({ data }: { data: Row }) => {
        rows.push({ ...defaults, ...data });
        return data;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = rows.find((candidate) => this.matches(candidate, where));
        if (!row) throw new Error("record not found");
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = rows.filter((row) => this.matches(row, where));
        hit.forEach((row) => Object.assign(row, data));
        return { count: hit.length };
      },
    };
  }

  client() {
    const users = this.table(this.users);
    return {
      user: {
        ...users,
        updateMany: async (args: { where: Row; data: Row }) => {
          if (this.failUserUpdateWith) throw this.failUserUpdateWith;
          return users.updateMany(args);
        },
      },
      authSession: this.table(this.sessions),
      // Mirrors the column defaults in schema.prisma.
      walletRotation: this.table(this.rotations, {
        status: WalletRotationStatus.PENDING,
        failureReason: null,
        consumedAt: null,
        completedAt: null,
      }),
      auditLog: {
        create: async ({ data }: { data: Row }) => {
          if (this.failAudit) throw new Error("audit store unavailable");
          this.audit.push(data);
          return data;
        },
      },
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
        const snapshot = JSON.stringify([this.users, this.sessions, this.rotations, this.audit]);
        try {
          return await run(this.client());
        } catch (error) {
          const [users, sessions, rotations, audit] = JSON.parse(snapshot, (key, value) =>
            typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : value,
          );
          this.users.splice(0, this.users.length, ...users);
          this.sessions.splice(0, this.sessions.length, ...sessions);
          this.rotations.splice(0, this.rotations.length, ...rotations);
          this.audit.splice(0, this.audit.length, ...audit);
          throw error;
        }
      },
    };
  }
}

function config(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    appUrl: APP_URL,
    "stellar.networkPassphrase": NETWORK,
    ...overrides,
  };
  return { getOrThrow: (key: string) => values[key] } as never;
}

function setup() {
  const store = new Store();
  const clock = new FixedClock("2030-01-01T00:00:00.000Z");
  store.users.push({
    id: "user_1",
    walletAddress: currentKey.publicKey(),
    walletHash: walletHash(currentKey.publicKey()),
  });
  store.sessions.push(
    { id: "s1", userId: "user_1", revokedAt: null },
    { id: "s2", userId: "user_1", revokedAt: null },
    { id: "s_other", userId: "user_2", revokedAt: null },
  );
  const service = new WalletRotationService(store.client() as never, config(), clock);
  const user: AuthenticatedUser = {
    id: "user_1",
    walletAddress: currentKey.publicKey(),
    walletHash: walletHash(currentKey.publicKey()),
    role: "WORKER",
  };
  return { store, clock, service, user };
}

async function begin(ctx: ReturnType<typeof setup>, replacement = replacementKey) {
  return ctx.service.initiate(ctx.user, replacement.publicKey());
}

function signaturesFor(
  challenge: { currentMessage: string; newMessage: string },
  keys: { current?: Keypair; replacement?: Keypair } = {},
) {
  return {
    currentSignature: sign(keys.current ?? currentKey, challenge.currentMessage),
    newSignature: sign(keys.replacement ?? replacementKey, challenge.newMessage),
  };
}

function expectNoIdentityChange(store: Store) {
  expect(store.users[0].walletAddress).toBe(currentKey.publicKey());
  expect(store.users[0].walletHash).toBe(walletHash(currentKey.publicKey()));
  expect(store.sessions.filter((s) => s.revokedAt === null)).toHaveLength(3);
  expect(store.audit).toHaveLength(0);
}

describe("WalletRotationService.initiate", () => {
  it("issues two distinct messages bound to network, origin, rotation, nonce and signer role", async () => {
    const ctx = setup();

    const challenge = await begin(ctx);

    expect(challenge.currentMessage).not.toEqual(challenge.newMessage);
    for (const message of [challenge.currentMessage, challenge.newMessage]) {
      expect(message).toContain(`Network: ${NETWORK}`);
      expect(message).toContain(`Origin: ${APP_URL}`);
      expect(message).toContain(`Rotation: ${challenge.rotationId}`);
      expect(message).toContain(`Current Wallet: ${currentKey.publicKey()}`);
      expect(message).toContain(`Replacement Wallet: ${replacementKey.publicKey()}`);
      expect(message).toMatch(/\nNonce: [A-Za-z0-9_-]{32}\n/);
    }
    expect(challenge.currentMessage).toContain("Signer: current wallet");
    expect(challenge.newMessage).toContain("Signer: replacement wallet");
  });

  it("persists a pending rotation that expires after the TTL, with a hashed nonce", async () => {
    const ctx = setup();

    const challenge = await begin(ctx);

    const [row] = ctx.store.rotations;
    const nonce = /Nonce: (\S+)/.exec(challenge.currentMessage)![1];
    expect(row).toMatchObject({
      id: challenge.rotationId,
      status: WalletRotationStatus.PENDING,
      networkPassphrase: NETWORK,
      origin: APP_URL,
      nonceHash: sha256(nonce),
    });
    expect((challenge.expiresAt as Date).getTime() - ctx.clock.nowMs()).toBe(WALLET_ROTATION_TTL_MS);
  });

  it("binds the normalized request origin when one is supplied", async () => {
    const ctx = setup();

    const challenge = await ctx.service.initiate(
      ctx.user,
      replacementKey.publicKey(),
      "HTTPS://App.Example.com/",
    );

    expect(challenge.currentMessage).toContain("Origin: https://app.example.com");
  });

  it.each([
    ["an invalid address", "GNOTANADDRESS"],
    ["a secret seed", currentKey.secret()],
    ["the current wallet", currentKey.publicKey()],
  ])("rejects %s as the replacement", async (_label, address) => {
    const ctx = setup();

    await expect(ctx.service.initiate(ctx.user, address)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(ctx.store.rotations).toHaveLength(0);
  });

  it("rejects an invalid origin", async () => {
    const ctx = setup();

    await expect(
      ctx.service.initiate(ctx.user, replacementKey.publicKey(), "*"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("does not reveal at initiation whether the replacement is already registered", async () => {
    const ctx = setup();
    ctx.store.users.push({ id: "user_2", walletAddress: strangerKey.publicKey() });

    await expect(ctx.service.initiate(ctx.user, strangerKey.publicKey())).resolves.toBeDefined();
  });

  it("cancels an earlier pending rotation, which can then no longer complete", async () => {
    const ctx = setup();
    const first = await begin(ctx);

    await begin(ctx);

    expect(ctx.store.rotations[0]).toMatchObject({
      status: WalletRotationStatus.CANCELLED,
      failureReason: WalletRotationFailure.SUPERSEDED,
    });
    await expect(
      ctx.service.complete(ctx.user, first.rotationId, signaturesFor(first)),
    ).rejects.toThrow("Rotation is expired or unavailable");
    expectNoIdentityChange(ctx.store);
  });
});

describe("WalletRotationService.complete", () => {
  const pending = begin;

  it("replaces the wallet, revokes every session and audits the transition", async () => {
    const ctx = setup();
    const challenge = await pending(ctx);

    const result = await ctx.service.complete(ctx.user, challenge.rotationId, signaturesFor(challenge));

    expect(result).toEqual({ walletAddress: replacementKey.publicKey(), sessionsRevoked: 2 });
    expect(ctx.store.users[0]).toMatchObject({
      walletAddress: replacementKey.publicKey(),
      walletHash: walletHash(replacementKey.publicKey()),
    });
    expect(ctx.store.sessions.find((s) => s.id === "s_other")!.revokedAt).toBeNull();
    expect(ctx.store.sessions.filter((s) => s.userId === "user_1" && s.revokedAt === null)).toHaveLength(0);
    expect(ctx.store.rotations[0]).toMatchObject({ status: WalletRotationStatus.COMPLETED });
    expect(ctx.store.audit).toEqual([
      {
        actorType: "user",
        actorId: "user_1",
        action: "user.wallet_rotated",
        resourceType: "user",
        resourceId: "user_1",
        metadata: {
          rotationId: challenge.rotationId,
          previousWalletHash: walletHash(currentKey.publicKey()),
          newWalletHash: walletHash(replacementKey.publicKey()),
          sessionsRevoked: 2,
        },
      },
    ]);
    expect(JSON.stringify(ctx.store.audit)).not.toContain(currentKey.publicKey());
    expect(JSON.stringify(ctx.store.audit)).not.toContain(replacementKey.publicKey());
  });

  it("accepts the rotation up to one millisecond before expiry", async () => {
    const ctx = setup();
    const challenge = await pending(ctx);
    ctx.clock.set(challenge.expiresAt.getTime() - 1);

    await expect(
      ctx.service.complete(ctx.user, challenge.rotationId, signaturesFor(challenge)),
    ).resolves.toBeDefined();
  });

  it("makes no identity change once the rotation has expired (inclusive boundary)", async () => {
    const ctx = setup();
    const challenge = await pending(ctx);
    ctx.clock.set(challenge.expiresAt.getTime());

    await expect(
      ctx.service.complete(ctx.user, challenge.rotationId, signaturesFor(challenge)),
    ).rejects.toThrow("Rotation is expired or unavailable");
    expectNoIdentityChange(ctx.store);
  });

  it("rejects a replay of a completed rotation", async () => {
    const ctx = setup();
    const challenge = await pending(ctx);
    const signatures = signaturesFor(challenge);
    await ctx.service.complete(ctx.user, challenge.rotationId, signatures);

    await expect(
      ctx.service.complete(ctx.user, challenge.rotationId, signatures),
    ).rejects.toThrow("Rotation is expired or unavailable");
    expect(ctx.store.audit).toHaveLength(1);
  });

  it("lets exactly one of several concurrent completions succeed", async () => {
    const ctx = setup();
    const challenge = await pending(ctx);
    const signatures = signaturesFor(challenge);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        ctx.service.complete(ctx.user, challenge.rotationId, signatures),
      ),
    );

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    for (const outcome of outcomes.filter((o) => o.status === "rejected")) {
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(UnauthorizedException);
    }
    expect(ctx.store.audit).toHaveLength(1);
  });

  it("refuses another user's rotation id with the same answer as an unknown one", async () => {
    const ctx = setup();
    const challenge = await pending(ctx);
    const intruder = { ...ctx.user, id: "user_2" };

    const denied = ctx.service.complete(intruder, challenge.rotationId, signaturesFor(challenge));
    const unknown = ctx.service.complete(ctx.user, "rotation_missing", signaturesFor(challenge));

    await expect(denied).rejects.toThrow("Rotation is expired or unavailable");
    await expect(unknown).rejects.toThrow("Rotation is expired or unavailable");
    expect(ctx.store.rotations[0].consumedAt).toBeNull();
    expectNoIdentityChange(ctx.store);
  });

  it.each([
    [
      "the current signature is invalid",
      { current: strangerKey },
      WalletRotationFailure.CURRENT_SIGNATURE_INVALID,
      "current wallet",
    ],
    [
      "the replacement signature is invalid",
      { replacement: strangerKey },
      WalletRotationFailure.REPLACEMENT_SIGNATURE_INVALID,
      "replacement wallet",
    ],
  ])("makes no change and burns the rotation when %s", async (_label, keys, reason, which) => {
    const ctx = setup();
    const challenge = await pending(ctx);

    await expect(
      ctx.service.complete(ctx.user, challenge.rotationId, signaturesFor(challenge, keys)),
    ).rejects.toThrow(`Invalid signature for the ${which}`);

    expectNoIdentityChange(ctx.store);
    expect(ctx.store.rotations[0]).toMatchObject({
      status: WalletRotationStatus.FAILED,
      failureReason: reason,
    });
    // A failed attempt cannot be retried with good signatures.
    await expect(
      ctx.service.complete(ctx.user, challenge.rotationId, signaturesFor(challenge)),
    ).rejects.toThrow("Rotation is expired or unavailable");
    expectNoIdentityChange(ctx.store);
  });

  it("rejects signatures swapped between the two messages", async () => {
    const ctx = setup();
    const challenge = await pending(ctx);

    await expect(
      ctx.service.complete(ctx.user, challenge.rotationId, {
        currentSignature: sign(currentKey, challenge.newMessage),
        newSignature: sign(replacementKey, challenge.currentMessage),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expectNoIdentityChange(ctx.store);
  });

  it("rejects signatures made for a different rotation", async () => {
    const ctx = setup();
    const stale = await pending(ctx);
    const fresh = await pending(ctx);

    await expect(
      ctx.service.complete(ctx.user, fresh.rotationId, signaturesFor(stale)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expectNoIdentityChange(ctx.store);
  });

  it("rejects a rotation issued for another network", async () => {
    const ctx = setup();
    const challenge = await pending(ctx);
    const mainnet = new WalletRotationService(
      ctx.store.client() as never,
      config({ "stellar.networkPassphrase": "Public Global Stellar Network ; September 2015" }),
      ctx.clock,
    );

    await expect(
      mainnet.complete(ctx.user, challenge.rotationId, signaturesFor(challenge)),
    ).rejects.toThrow("Rotation network mismatch");
    expectNoIdentityChange(ctx.store);
    expect(ctx.store.rotations[0].failureReason).toBe(WalletRotationFailure.NETWORK_MISMATCH);
  });

  it("rejects completion from a different origin", async () => {
    const ctx = setup();
    const challenge = await pending(ctx);

    await expect(
      ctx.service.complete(
        ctx.user,
        challenge.rotationId,
        signaturesFor(challenge),
        "https://evil.example.com",
      ),
    ).rejects.toThrow("Rotation origin mismatch");
    expectNoIdentityChange(ctx.store);
    expect(ctx.store.rotations[0].failureReason).toBe(WalletRotationFailure.ORIGIN_MISMATCH);
  });

  it("rejects a replacement that became bound to another account, after proof of control", async () => {
    const ctx = setup();
    const challenge = await pending(ctx);
    ctx.store.users.push({ id: "user_2", walletAddress: replacementKey.publicKey() });

    await expect(
      ctx.service.complete(ctx.user, challenge.rotationId, signaturesFor(challenge)),
    ).rejects.toBeInstanceOf(ConflictException);
    expectNoIdentityChange(ctx.store);
    expect(ctx.store.rotations[0]).toMatchObject({
      status: WalletRotationStatus.FAILED,
      failureReason: WalletRotationFailure.REPLACEMENT_UNAVAILABLE,
    });
  });

  it("maps a unique violation racing the commit to 409 with no change", async () => {
    const ctx = setup();
    const challenge = await pending(ctx);
    ctx.store.failUserUpdateWith = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    });

    await expect(
      ctx.service.complete(ctx.user, challenge.rotationId, signaturesFor(challenge)),
    ).rejects.toThrow("Replacement wallet is already bound to an account");
    expectNoIdentityChange(ctx.store);
  });

  it("rejects the rotation when the account's wallet changed since it began", async () => {
    const ctx = setup();
    const challenge = await pending(ctx);
    const rotatedElsewhere = { ...ctx.user, walletAddress: strangerKey.publicKey() };

    await expect(
      ctx.service.complete(rotatedElsewhere, challenge.rotationId, signaturesFor(challenge)),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(ctx.store.rotations[0].failureReason).toBe(WalletRotationFailure.IDENTITY_CHANGED);
  });

  it("rejects the commit when the stored wallet no longer matches (conditional write)", async () => {
    const ctx = setup();
    const challenge = await pending(ctx);
    ctx.store.users[0].walletAddress = strangerKey.publicKey();

    await expect(
      ctx.service.complete(ctx.user, challenge.rotationId, signaturesFor(challenge)),
    ).rejects.toThrow("Account wallet changed since the rotation began");
    expect(ctx.store.audit).toHaveLength(0);
  });

  it("rolls the identity change back when the audit write fails", async () => {
    const ctx = setup();
    const challenge = await pending(ctx);
    ctx.store.failAudit = true;

    await expect(
      ctx.service.complete(ctx.user, challenge.rotationId, signaturesFor(challenge)),
    ).rejects.toThrow("audit store unavailable");
    expectNoIdentityChange(ctx.store);
  });
});
