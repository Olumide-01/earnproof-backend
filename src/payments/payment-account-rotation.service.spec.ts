import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Keypair } from "@stellar/stellar-base";
import { FixedClock } from "../../test/time/fixed-clock";
import { sep53MessageHash } from "../auth/wallet-signature";
import { PaymentAccountResolver } from "./payment-account.resolver";
import { PaymentAccountRotationService } from "./payment-account-rotation.service";
import { InMemoryRotationPrisma } from "./testing/in-memory-rotation-prisma";

const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const MIN = 60_000;
const TTL = 10 * MIN;
const WINDOW = 24 * 60 * MIN;
const TESTNET = "Test SDF Network ; September 2015";

function config(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    "stellar.network": "testnet",
    "stellar.networkPassphrase": TESTNET,
    appUrl: "https://app.example",
    "paymentAccountRotation.challengeTtlMs": TTL,
    "paymentAccountRotation.rollbackWindowMs": WINDOW,
    ...overrides,
  };
  const get = jest.fn((key: string) => values[key]);
  const getOrThrow = jest.fn((key: string) => {
    if (values[key] === undefined) throw new Error(`missing ${key}`);
    return values[key];
  });
  return { get, getOrThrow } as unknown as ConfigService;
}

/** Synthetic keypairs generated per run; nothing here is real key material. */
function sign(keypair: Keypair, message: string): string {
  return keypair.sign(sep53MessageHash(message)).toString("base64");
}

async function setup(overrides: Record<string, unknown> = {}) {
  const clock = new FixedClock(T0);
  const prisma = new InMemoryRotationPrisma();
  const wallet = Keypair.random();
  const user = { id: "user-1", walletAddress: wallet.publicKey(), walletHash: "h1", role: "WORKER" };
  await prisma.user.create({ data: { id: user.id, walletAddress: user.walletAddress, createdAt: new Date(T0 - 365 * 24 * 60 * MIN) } });
  const cfg = config(overrides);
  const resolver = new PaymentAccountResolver(prisma as never, cfg);
  const service = new PaymentAccountRotationService(prisma as never, resolver, cfg, clock);
  return { clock, prisma, user, wallet, resolver, service };
}

async function seedCheckpoint(prisma: InMemoryRotationPrisma, userId: string, overrides: Record<string, unknown> = {}) {
  return prisma.paymentSyncCheckpoint.create({
    data: {
      userId,
      pagingToken: "4294967296001",
      operationId: "4294967296001",
      transactionHash: "a".repeat(64),
      ledgerSequence: 1_000_000,
      ledgerHash: "b".repeat(64),
      verifiedAt: new Date(T0 - MIN),
      ...overrides,
    },
  });
}

async function verified(ctx: Awaited<ReturnType<typeof setup>>, backfillFromLedger?: number) {
  const target = Keypair.random();
  const requested = await ctx.service.request(ctx.user, {
    network: "testnet",
    newAccountId: target.publicKey(),
    backfillFromLedger,
  });
  const view = await ctx.service.verify(ctx.user, requested.id, sign(target, requested.challengeMessage!));
  return { target, requested, view };
}

describe("PaymentAccountRotationService", () => {
  beforeEach(() => jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it("refuses to start when the network name and passphrase disagree", () => {
    const prisma = new InMemoryRotationPrisma();
    const cfg = config({ "stellar.networkPassphrase": "Public Global Stellar Network ; September 2015" });
    expect(() => new PaymentAccountRotationService(prisma as never, new PaymentAccountResolver(prisma as never, cfg), cfg)).toThrow(
      /disagree/,
    );
  });

  describe("request", () => {
    it("issues a challenge bound to both accounts and the network", async () => {
      const ctx = await setup();
      const target = Keypair.random();
      const view = await ctx.service.request(ctx.user, { network: "testnet", newAccountId: target.publicKey() });

      expect(view).toMatchObject({
        status: "PENDING_VERIFICATION",
        fromAccountId: ctx.user.walletAddress,
        toAccountId: target.publicKey(),
        network: "testnet",
        version: 0,
        expiresAt: new Date(T0 + TTL).toISOString(),
      });
      expect(view.challengeMessage).toContain(TESTNET);
      expect(view.challengeMessage).toContain(target.publicKey());
    });

    it("refuses another network's account (accounts and networks cannot be confused)", async () => {
      const ctx = await setup();
      await expect(
        ctx.service.request(ctx.user, { network: "mainnet", newAccountId: Keypair.random().publicKey() }),
      ).rejects.toThrow(new BadRequestException("Network does not match this deployment"));
    });

    it("refuses a secret seed without echoing it", async () => {
      const ctx = await setup();
      const seed = Keypair.random().secret();
      const error = await ctx.service
        .request(ctx.user, { network: "testnet", newAccountId: seed })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify((error as BadRequestException).getResponse())).not.toContain(seed);
      expect(ctx.prisma.paymentAccountRotation.rows).toHaveLength(0);
    });

    it.each([
      ["a contract id", () => `C${Keypair.random().publicKey().slice(1)}`],
      ["a malformed id", () => "GNOTANACCOUNT"],
    ])("refuses %s", async (_label, make) => {
      const ctx = await setup();
      await expect(ctx.service.request(ctx.user, { network: "testnet", newAccountId: make() })).rejects.toThrow(
        BadRequestException,
      );
    });

    it("refuses the current account", async () => {
      const ctx = await setup();
      await expect(
        ctx.service.request(ctx.user, { network: "testnet", newAccountId: ctx.user.walletAddress }),
      ).rejects.toThrow(BadRequestException);
    });

    it("allows one open rotation per user", async () => {
      const ctx = await setup();
      await ctx.service.request(ctx.user, { network: "testnet", newAccountId: Keypair.random().publicKey() });
      await expect(
        ctx.service.request(ctx.user, { network: "testnet", newAccountId: Keypair.random().publicKey() }),
      ).rejects.toThrow(ConflictException);
    });

    it("lets an expired, unverified challenge be replaced", async () => {
      const ctx = await setup();
      const first = await ctx.service.request(ctx.user, { network: "testnet", newAccountId: Keypair.random().publicKey() });
      ctx.clock.set(T0 + TTL);
      await expect(
        ctx.service.request(ctx.user, { network: "testnet", newAccountId: Keypair.random().publicKey() }),
      ).resolves.toMatchObject({ status: "PENDING_VERIFICATION" });
      await expect(ctx.service.get(ctx.user, first.id)).resolves.toMatchObject({ status: "EXPIRED" });
    });
  });

  describe("verify", () => {
    it("accepts the new account's signature exactly once", async () => {
      const ctx = await setup();
      const target = Keypair.random();
      const requested = await ctx.service.request(ctx.user, { network: "testnet", newAccountId: target.publicKey() });
      const signature = sign(target, requested.challengeMessage!);

      await expect(ctx.service.verify(ctx.user, requested.id, signature)).resolves.toMatchObject({
        status: "VERIFIED",
        version: 1,
        challengeMessage: null,
      });
      await expect(ctx.service.verify(ctx.user, requested.id, signature)).rejects.toThrow(UnauthorizedException);
    });

    it("rejects a signature from the current account instead of the new one", async () => {
      const ctx = await setup();
      const requested = await ctx.service.request(ctx.user, { network: "testnet", newAccountId: Keypair.random().publicKey() });
      await expect(
        ctx.service.verify(ctx.user, requested.id, sign(ctx.wallet, requested.challengeMessage!)),
      ).rejects.toThrow(UnauthorizedException);
      await expect(ctx.service.get(ctx.user, requested.id)).resolves.toMatchObject({
        status: "FAILED",
        failureReason: "signature_invalid",
      });
    });

    it("does not allow a retry after a failed attempt (single use)", async () => {
      const ctx = await setup();
      const target = Keypair.random();
      const requested = await ctx.service.request(ctx.user, { network: "testnet", newAccountId: target.publicKey() });
      await ctx.service.verify(ctx.user, requested.id, "AAAA").catch(() => undefined);
      await expect(
        ctx.service.verify(ctx.user, requested.id, sign(target, requested.challengeMessage!)),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("treats the expiry instant itself as expired", async () => {
      const ctx = await setup();
      const target = Keypair.random();
      const requested = await ctx.service.request(ctx.user, { network: "testnet", newAccountId: target.publicKey() });
      ctx.clock.set(T0 + TTL);
      await expect(
        ctx.service.verify(ctx.user, requested.id, sign(target, requested.challengeMessage!)),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("accepts a signature one millisecond before expiry", async () => {
      const ctx = await setup();
      const target = Keypair.random();
      const requested = await ctx.service.request(ctx.user, { network: "testnet", newAccountId: target.publicKey() });
      ctx.clock.set(T0 + TTL - 1);
      await expect(
        ctx.service.verify(ctx.user, requested.id, sign(target, requested.challengeMessage!)),
      ).resolves.toMatchObject({ status: "VERIFIED" });
    });

    it("rejects a signature over a different network's message", async () => {
      const ctx = await setup();
      const target = Keypair.random();
      const requested = await ctx.service.request(ctx.user, { network: "testnet", newAccountId: target.publicKey() });
      const mainnetMessage = requested.challengeMessage!.replace(TESTNET, "Public Global Stellar Network ; September 2015");
      await expect(ctx.service.verify(ctx.user, requested.id, sign(target, mainnetMessage))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("hides another user's rotation (authorization)", async () => {
      const ctx = await setup();
      const target = Keypair.random();
      const requested = await ctx.service.request(ctx.user, { network: "testnet", newAccountId: target.publicKey() });
      const intruder = { id: "user-2", walletAddress: Keypair.random().publicKey(), walletHash: "h2", role: "WORKER" };

      await expect(
        ctx.service.verify(intruder, requested.id, sign(target, requested.challengeMessage!)),
      ).rejects.toThrow(UnauthorizedException);
      await expect(ctx.service.get(intruder, requested.id)).rejects.toThrow(NotFoundException);
      await expect(ctx.service.activate(intruder, requested.id, 0)).rejects.toThrow(NotFoundException);
      await expect(ctx.service.cancel(intruder, requested.id, 0)).rejects.toThrow(NotFoundException);
      // The owner's challenge is untouched.
      await expect(ctx.service.get(ctx.user, requested.id)).resolves.toMatchObject({ status: "PENDING_VERIFICATION" });
    });

    it("refuses an account that is another user's wallet, after proof of control", async () => {
      const ctx = await setup();
      const other = Keypair.random();
      await ctx.prisma.user.create({ data: { id: "user-2", walletAddress: other.publicKey() } });
      const requested = await ctx.service.request(ctx.user, { network: "testnet", newAccountId: other.publicKey() });

      await expect(
        ctx.service.verify(ctx.user, requested.id, sign(other, requested.challengeMessage!)),
      ).rejects.toThrow(ConflictException);
      await expect(ctx.service.get(ctx.user, requested.id)).resolves.toMatchObject({ failureReason: "account_unavailable" });
    });

    it("refuses a secret seed submitted as the signature", async () => {
      const ctx = await setup();
      const requested = await ctx.service.request(ctx.user, { network: "testnet", newAccountId: Keypair.random().publicKey() });
      await expect(ctx.service.verify(ctx.user, requested.id, Keypair.random().secret())).rejects.toThrow(
        BadRequestException,
      );
      // Refused before consumption, so the challenge is still usable.
      await expect(ctx.service.get(ctx.user, requested.id)).resolves.toMatchObject({ status: "PENDING_VERIFICATION" });
    });
  });

  describe("activate", () => {
    it("hands off at the old account's final checkpoint and plans the new account's backfill", async () => {
      const ctx = await setup();
      await seedCheckpoint(ctx.prisma, ctx.user.id);
      const { target, view } = await verified(ctx, 999_000);

      const activated = await ctx.service.activate(ctx.user, view.id, view.version);

      expect(activated).toMatchObject({
        status: "ACTIVATED",
        finalCheckpoint: { ledgerSequence: 1_000_000, pagingToken: "4294967296001" },
        backfillPlan: { startLedger: 999_000, endLedger: 1_000_000, jobId: expect.any(String) },
        rollbackDeadline: new Date(T0 + WINDOW).toISOString(),
      });
      // The old checkpoint is gone: the new feed starts from its own checkpoint.
      expect(ctx.prisma.paymentSyncCheckpoint.rows).toHaveLength(0);
      // The backfill scans the new account, not the user's wallet.
      expect(ctx.prisma.paymentBackfillJob.rows).toEqual([
        expect.objectContaining({ accountId: target.publicKey(), startLedger: 999_000, endLedger: 1_000_000 }),
      ]);
      await expect(ctx.resolver.current(ctx.user)).resolves.toMatchObject({
        accountId: target.publicKey(),
        source: "rotation",
      });
      // The old account has an explicit, retired epoch.
      expect(ctx.prisma.paymentMonitoredAccount.rows.map((row) => [row.accountId, row.status])).toEqual([
        [ctx.user.walletAddress, "RETIRED"],
        [target.publicKey(), "ACTIVE"],
      ]);
    });

    it("plans no backfill when nothing was synced before", async () => {
      const ctx = await setup();
      const { view } = await verified(ctx, 999_000);
      await expect(ctx.service.activate(ctx.user, view.id, view.version)).resolves.toMatchObject({
        finalCheckpoint: null,
        backfillPlan: null,
      });
      expect(ctx.prisma.paymentBackfillJob.rows).toHaveLength(0);
    });

    it("refuses while the old history is diverged and changes nothing", async () => {
      const ctx = await setup();
      await seedCheckpoint(ctx.prisma, ctx.user.id, { status: "DIVERGED" });
      const { view } = await verified(ctx);

      await expect(ctx.service.activate(ctx.user, view.id, view.version)).rejects.toThrow(ConflictException);

      expect(ctx.prisma.paymentSyncCheckpoint.rows).toHaveLength(1);
      expect(ctx.prisma.paymentMonitoredAccount.rows).toHaveLength(0);
      await expect(ctx.service.get(ctx.user, view.id)).resolves.toMatchObject({ status: "VERIFIED" });
    });

    it("refuses an unverified rotation and a stale version", async () => {
      const ctx = await setup();
      const pending = await ctx.service.request(ctx.user, { network: "testnet", newAccountId: Keypair.random().publicKey() });
      await expect(ctx.service.activate(ctx.user, pending.id, 0)).rejects.toThrow(ConflictException);

      await ctx.service.cancel(ctx.user, pending.id, 0);
      const { view } = await verified(ctx);
      await expect(ctx.service.activate(ctx.user, view.id, view.version - 1)).rejects.toThrow(ConflictException);
    });

    it("lets exactly one of two concurrent activations win", async () => {
      const ctx = await setup();
      await seedCheckpoint(ctx.prisma, ctx.user.id);
      const { view } = await verified(ctx, 999_000);

      const results = await Promise.allSettled([
        ctx.service.activate(ctx.user, view.id, view.version),
        ctx.service.activate(ctx.user, view.id, view.version),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(ctx.prisma.paymentBackfillJob.rows).toHaveLength(1);
      expect(ctx.prisma.paymentMonitoredAccount.rows.filter((row) => row.status === "ACTIVE")).toHaveLength(1);
    });

    it("refuses an account another user activated in the meantime, rolling back every write", async () => {
      const ctx = await setup();
      await seedCheckpoint(ctx.prisma, ctx.user.id);
      const { target, view } = await verified(ctx);
      await ctx.prisma.paymentMonitoredAccount.create({
        data: {
          id: "epoch-other",
          userId: "user-2",
          network: "testnet",
          accountId: target.publicKey(),
          status: "ACTIVE",
          activatedAt: new Date(T0),
          activeUserKey: "user-2:testnet",
          activeAccountKey: `testnet:${target.publicKey()}`,
        },
      });

      await expect(ctx.service.activate(ctx.user, view.id, view.version)).rejects.toThrow(ConflictException);
      expect(ctx.prisma.paymentSyncCheckpoint.rows).toHaveLength(1);
      expect(ctx.prisma.paymentMonitoredAccount.rows).toHaveLength(1);
    });

    it("records hashed account ids, never raw ones, in the audit log", async () => {
      const ctx = await setup();
      const { target, view } = await verified(ctx);
      await ctx.service.activate(ctx.user, view.id, view.version);
      const audit = JSON.stringify(ctx.prisma.auditLog.rows);
      expect(audit).not.toContain(target.publicKey());
      expect(audit).not.toContain(ctx.user.walletAddress);
      expect(audit).toContain("payment_account.rotation_activated");
    });
  });

  describe("rollback", () => {
    async function activated(ctx: Awaited<ReturnType<typeof setup>>) {
      await seedCheckpoint(ctx.prisma, ctx.user.id);
      const { target, view } = await verified(ctx, 999_000);
      const active = await ctx.service.activate(ctx.user, view.id, view.version);
      // The new account's first sync establishes its own checkpoint.
      await seedCheckpoint(ctx.prisma, ctx.user.id, { pagingToken: "9", operationId: "9", ledgerSequence: 1_000_500 });
      return { target, active };
    }

    it("restores the old account and its final checkpoint, and cancels the backfill", async () => {
      const ctx = await setup();
      const { active } = await activated(ctx);

      const rolledBack = await ctx.service.rollback(ctx.user, active.id, {
        expectedVersion: active.version,
        reason: "wrong_account",
      });

      expect(rolledBack).toMatchObject({ status: "ROLLED_BACK", rolledBackAt: new Date(T0).toISOString() });
      await expect(ctx.resolver.current(ctx.user)).resolves.toMatchObject({ accountId: ctx.user.walletAddress });
      expect(ctx.prisma.paymentSyncCheckpoint.rows).toEqual([
        expect.objectContaining({ pagingToken: "4294967296001", ledgerSequence: 1_000_000, status: "VERIFIED" }),
      ]);
      expect(ctx.prisma.paymentBackfillJob.rows[0]).toMatchObject({ status: "CANCELLED" });
    });

    it("is allowed exactly at the deadline and refused one millisecond later", async () => {
      const ctx = await setup();
      const { active } = await activated(ctx);
      ctx.clock.set(T0 + WINDOW + 1);
      await expect(
        ctx.service.rollback(ctx.user, active.id, { expectedVersion: active.version, reason: "operator_request" }),
      ).rejects.toThrow(ConflictException);
      ctx.clock.set(T0 + WINDOW);
      await expect(
        ctx.service.rollback(ctx.user, active.id, { expectedVersion: active.version, reason: "operator_request" }),
      ).resolves.toMatchObject({ status: "ROLLED_BACK" });
    });

    it("refuses a replayed rollback", async () => {
      const ctx = await setup();
      const { active } = await activated(ctx);
      await ctx.service.rollback(ctx.user, active.id, { expectedVersion: active.version, reason: "incident" });
      await expect(
        ctx.service.rollback(ctx.user, active.id, { expectedVersion: active.version, reason: "incident" }),
      ).rejects.toThrow(ConflictException);
    });

    it("refuses once a later rotation superseded it", async () => {
      const ctx = await setup();
      const { active } = await activated(ctx);
      const { view } = await verified(ctx);
      await expect(ctx.service.activate(ctx.user, view.id, view.version)).resolves.toMatchObject({
        status: "ACTIVATED",
      });
      // The first rotation's new account is no longer the active one.
      await expect(
        ctx.service.rollback(ctx.user, active.id, { expectedVersion: active.version, reason: "incident" }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("cancel", () => {
    it("frees the user to request again", async () => {
      const ctx = await setup();
      const pending = await ctx.service.request(ctx.user, { network: "testnet", newAccountId: Keypair.random().publicKey() });
      await expect(ctx.service.cancel(ctx.user, pending.id, 0)).resolves.toMatchObject({ status: "CANCELLED" });
      await expect(
        ctx.service.request(ctx.user, { network: "testnet", newAccountId: Keypair.random().publicKey() }),
      ).resolves.toMatchObject({ status: "PENDING_VERIFICATION" });
    });

    it("refuses an activated rotation", async () => {
      const ctx = await setup();
      const { view } = await verified(ctx);
      const active = await ctx.service.activate(ctx.user, view.id, view.version);
      await expect(ctx.service.cancel(ctx.user, active.id, active.version)).rejects.toThrow(ConflictException);
    });
  });
});

describe("PaymentAccountResolver", () => {
  it("falls back to the wallet for users who never rotated (regression)", async () => {
    const ctx = await setup();
    await expect(ctx.resolver.current(ctx.user)).resolves.toEqual({
      accountId: ctx.user.walletAddress,
      network: "testnet",
      epochId: null,
      source: "wallet",
    });
  });

  it("discards a checkpoint written by a sync that straddled an activation", async () => {
    const ctx = await setup();
    const before = await ctx.resolver.current(ctx.user);
    const { view } = await verified(ctx);
    await ctx.service.activate(ctx.user, view.id, view.version);
    // The in-flight sync of the old account writes its checkpoint after cutover.
    await seedCheckpoint(ctx.prisma, ctx.user.id);

    await expect(ctx.resolver.discardStaleCheckpoint(ctx.user, before)).resolves.toBe(true);
    expect(ctx.prisma.paymentSyncCheckpoint.rows).toHaveLength(0);
  });

  it("keeps the checkpoint when the account did not change", async () => {
    const ctx = await setup();
    const before = await ctx.resolver.current(ctx.user);
    await seedCheckpoint(ctx.prisma, ctx.user.id);
    await expect(ctx.resolver.discardStaleCheckpoint(ctx.user, before)).resolves.toBe(false);
    expect(ctx.prisma.paymentSyncCheckpoint.rows).toHaveLength(1);
  });
});
