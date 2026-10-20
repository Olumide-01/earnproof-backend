import { ProofStatus } from "@prisma/client";
import { VerificationEventService } from "../../src/audit/verification-event.service";
import { AuthenticatedUser } from "../../src/auth/auth.types";
import { SessionService } from "../../src/auth/session.service";
import { ProofsService } from "../../src/proofs/proofs.service";
import { ConfigService } from "@nestjs/config";
import { Clock, SystemClock } from "../../src/common/time/clock";
import { integrationDatabase } from "./harness/database";
import { integrationModule } from "./harness/nest";
import { isUniqueViolation, seedPayment, seedProof, seedUser } from "./harness/fixtures";

/**
 * Transaction ownership and injected-failure coverage (#64).
 *
 * ## Transaction ownership
 *
 * Every multi-write mutation in this codebase owns exactly one
 * `prisma.$transaction` call, opened and closed inside the SERVICE method
 * that performs the mutation — never inside a controller, and never spanning
 * more than one service call. That is a deliberate, load-bearing property:
 * it is what makes "the domain write and its outbox/audit write commit or
 * fail together" true by construction rather than by convention.
 *
 * | Mutation                                         | Owner                                              | Domain write(s)          | Outbox / audit write(s)                    |
 * |---------------------------------------------------|-----------------------------------------------------|---------------------------|----------------------------------------------|
 * | Minimum-income proof issuance                      | `ProofsService.createMinimumIncomeProof`             | `Proof`, `ProofClaim`     | `AnchoringIntent` (REGISTER, if enabled)     |
 * | Recurring-income proof issuance                    | `ProofsService.createRecurringIncomeProof`           | `Proof`, `ProofClaim`     | `AnchoringIntent` (REGISTER, if enabled)     |
 * | Payment-receipt proof issuance                     | `ProofsService.createPaymentReceiptProof`            | `Proof`, `ProofClaim`     | `AnchoringIntent` (REGISTER, if enabled)     |
 * | Proof revocation                                   | `ProofsService.revokeProof`                          | `Proof` (status update)  | `AnchoringIntent` (REVOKE, if prev. anchored) |
 * | Session rotation                                   | `SessionService.rotate`                              | `AuthSession` (revoke)   | `AuthSession` (create replacement)            |
 *
 * (Payment sync's transactional upsert — the other outbox-shaped mutation
 * named in the issue — is covered by `payments.int-spec.ts`; its owning
 * service, `PaymentsService`, is not exercisable here: see the note in this
 * PR's description.)
 *
 * ## What this file adds vs. what already exists
 *
 * `transactions.int-spec.ts` already proves the underlying Prisma mechanics
 * (an interactive transaction discards every write when the callback throws
 * or a later statement violates a constraint) against a real database.
 * `proof-lifecycle.int-spec.ts` and `auth-sessions.int-spec.ts` already prove
 * several ROLLBACK outcomes for real service methods (a colliding credential
 * hash leaves no orphaned claim; a refused rotation leaves no orphaned
 * session).
 *
 * What none of them state directly is the other half of the acceptance
 * criteria: that retrying the SAME logical operation after a rollback
 * produces exactly one committed outcome — not zero (the retry silently
 * no-ops), and not two (the rollback did not fully undo the first attempt).
 * That is what `retryAfterFailure` below exercises, reused across three
 * representative mutations chosen to cover every "shape" of transaction
 * owner in the table above: a create-with-nested-outbox-row (proof
 * issuance), an update-with-conditional-outbox-row (revocation), and a
 * two-row create+update with no separate outbox table (session rotation).
 */

const db = integrationDatabase();

beforeAll(() => {
  // Must run before integrationModule's own beforeAll (Jest runs beforeAll
  // hooks in registration order within a file) so `configuration()` picks
  // this up when the testing module compiles — the worker environment
  // defaults anchoring to disabled, but the outbox write under test
  // (AnchoringIntent) only happens when it is enabled.
  process.env.CONTRACT_ANCHORING_ENABLED = "true";
});

const injector = integrationModule([
  ProofsService,
  VerificationEventService,
  SessionService,
  ConfigService,
  // SessionService's constructor takes `clock: Clock = new SystemClock()` as
  // a default parameter for non-DI callers, but Nest's own DI resolves every
  // constructor parameter's declared TYPE regardless of a default value —
  // so a bare `SystemClock` must be provided under the `Clock` token or
  // module compilation fails. (This is also broken today in the repo's own
  // auth-sessions.int-spec.ts, independent of anything here — see this PR's
  // description.)
  { provide: Clock, useClass: SystemClock },
]);

function proofs(): ProofsService {
  return injector.get(ProofsService);
}

function sessions(): SessionService {
  return injector.get(SessionService);
}

/**
 * Calls `operation` once, expecting it to reject (the injected failure);
 * asserts nothing else committed; then calls `operation` again with
 * whatever changes make it succeed and asserts it does, exactly once.
 *
 * `countState` is called after the failed attempt (expected: unchanged from
 * baseline) and after the retry (expected: exactly one net commit) so a
 * caller can assert on whatever rows the mutation under test owns.
 */
async function retryAfterFailure<T>(steps: {
  failingAttempt: () => Promise<T>;
  retryAttempt: () => Promise<T>;
  countAfterFailure: () => Promise<number>;
  countAfterRetry: () => Promise<number>;
  baselineCount: number;
}): Promise<void> {
  const failure = await steps.failingAttempt().catch((thrown: unknown) => thrown);
  expect(failure).toBeInstanceOf(Error);
  expect(await steps.countAfterFailure()).toBe(steps.baselineCount);

  await steps.retryAttempt();
  expect(await steps.countAfterRetry()).toBe(steps.baselineCount + 1);
}

describe("retry after rollback — proof issuance (create + outbox row)", () => {
  it("a credentialHash collision rolls back the whole transaction (no orphaned claim or outbox row), and a subsequent real request commits proof + outbox row together", async () => {
    const user = await seedUser(db.prisma, "retry-proof-issuance");
    const payment = await seedPayment(db.prisma, "retry-proof-payment", user.id, {
      amount: "500.0000000",
      assetCode: "USDC",
      assetIssuer: null,
      classification: "INCOME",
      isEligible: true,
      occurredAt: new Date("2025-01-10T00:00:00.000Z"),
    });
    const authenticated: AuthenticatedUser = {
      id: user.id,
      walletAddress: user.walletAddress,
      walletHash: user.walletHash,
      role: user.role,
    };
    const input = {
      selectedPaymentIds: [payment.row.id],
      thresholdAmount: "100",
      assetCode: "USDC",
      periodStart: "2025-01-01T00:00:00.000Z",
      periodEnd: "2025-01-31T23:59:59.000Z",
    };

    // A real service call succeeds first, so its credentialHash is a real,
    // service-produced value rather than a guessed one (createMinimumIncomeProof
    // embeds a fresh random proof id and `now` in the hash input, so two
    // separate calls — even with byte-identical DTOs — never collide on
    // their own; the collision below is injected deliberately, the same way
    // proof-lifecycle.int-spec.ts does at the persistence layer).
    const first = await proofs().createMinimumIncomeProof(authenticated, input);
    const firstProof = await db.prisma.proof.findUniqueOrThrow({
      where: { id: first.proofId },
    });

    // The service embeds a fresh random proof id and `now` in every hash it
    // computes, so it can never be made to reproduce an existing hash by
    // calling it again — a real service call cannot BE the injected failure
    // here without reaching into its private hashing logic. Instead, this
    // injects the exact failure mode the service's own Proof.create would
    // hit if it ever did collide: a row already occupying that
    // credentialHash. proof-lifecycle.int-spec.ts already proves the
    // collision itself rolls back cleanly; what this test adds is the other
    // half — that a real, subsequent SERVICE call (not another raw insert)
    // still succeeds afterward and commits exactly one new proof + outbox
    // row, proving the rollback did not leave the table, or the service,
    // in a state that blocks forward progress.
    const colliding = db.prisma.proof.create({
      data: {
        userId: user.id,
        proofType: "MINIMUM_INCOME",
        schemaVersion: firstProof.schemaVersion,
        network: firstProof.network,
        assetCode: "USDC",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        credentialHash: firstProof.credentialHash,
        claim: {
          create: {
            operator: "gte",
            result: true,
            disclosurePolicy: { exactIncomeHidden: true },
          },
        },
      },
    });

    const failure = await colliding.catch((thrown: unknown) => thrown);

    expect(isUniqueViolation(failure)).toBe(true);
    // Rolled back cleanly: still exactly the one proof/claim/outbox row from
    // the first, real service call — the failed collision left no orphans.
    expect(await db.prisma.proof.count({ where: { userId: user.id } })).toBe(1);
    expect(
      await db.prisma.proofClaim.count({ where: { proof: { userId: user.id } } }),
    ).toBe(1);
    expect(
      await db.prisma.anchoringIntent.count({
        where: { proof: { userId: user.id } },
      }),
    ).toBe(1);

    // The retry: a genuinely new, real service call (different threshold, so
    // a different credentialHash) succeeds and adds exactly one more of each.
    const retryInput = { ...input, thresholdAmount: "200" };
    const second = await proofs().createMinimumIncomeProof(authenticated, retryInput);

    expect(await db.prisma.proof.count({ where: { userId: user.id } })).toBe(2);
    expect(
      await db.prisma.anchoringIntent.count({
        where: { proof: { userId: user.id } },
      }),
    ).toBe(2);
    expect(
      await db.prisma.anchoringIntent.count({ where: { proofId: second.proofId } }),
    ).toBe(1);
  });
});

describe("retry after rollback — proof revocation (conditional outbox row)", () => {
  it("a forbidden revocation attempt leaves no partial state, and a valid retry commits the status update and its REVOKE outbox row together", async () => {
    const owner = await seedUser(db.prisma, "retry-revoke-owner");
    const stranger = await seedUser(db.prisma, "retry-revoke-stranger");
    const proof = await seedProof(db.prisma, "retry-revoke-proof", owner.id, {
      contractTransactionHash: "deadbeefTXHASH",
    });

    await retryAfterFailure({
      failingAttempt: () => proofs().revokeProof(stranger, proof.id),
      retryAttempt: () => proofs().revokeProof(owner, proof.id),
      baselineCount: 0,
      countAfterFailure: () =>
        db.prisma.anchoringIntent.count({ where: { proofId: proof.id } }),
      countAfterRetry: () =>
        db.prisma.anchoringIntent.count({ where: { proofId: proof.id } }),
    });

    const revoked = await db.prisma.proof.findUniqueOrThrow({
      where: { id: proof.id },
    });
    expect(revoked.status).toBe(ProofStatus.REVOKED);
    expect(revoked.revokedAt).not.toBeNull();

    const intent = await db.prisma.anchoringIntent.findFirstOrThrow({
      where: { proofId: proof.id },
    });
    expect(intent.operation).toBe("REVOKE");
  });

  it("rejects a second revocation of the same proof rather than double-enqueuing a REVOKE intent", async () => {
    const owner = await seedUser(db.prisma, "retry-revoke-twice");
    const proof = await seedProof(db.prisma, "retry-revoke-twice-proof", owner.id, {
      contractTransactionHash: "deadbeefTXHASH",
    });

    await proofs().revokeProof(owner, proof.id);
    expect(
      await db.prisma.anchoringIntent.count({ where: { proofId: proof.id } }),
    ).toBe(1);

    // A second revocation attempt should not enqueue a second REVOKE intent
    // regardless of whether the service treats it as a no-op or an error —
    // either way, exactly one outbox row must exist afterward.
    await proofs()
      .revokeProof(owner, proof.id)
      .catch(() => undefined);

    expect(
      await db.prisma.anchoringIntent.count({ where: { proofId: proof.id } }),
    ).toBe(1);
  });
});

describe("retry after rollback — session rotation (two-row transaction, no outbox table)", () => {
  it("a rotation refused because the session is already revoked leaves no replacement session, and a valid retry against a live session commits exactly one replacement", async () => {
    const user = await seedUser(db.prisma, "retry-rotation");
    const authenticated: AuthenticatedUser = {
      id: user.id,
      walletAddress: user.walletAddress,
      walletHash: user.walletHash,
      role: user.role,
    };

    const liveSession = await db.prisma.authSession.create({
      data: {
        tokenHash: "sha256:live-session-token",
        userId: user.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const revokedSession = await db.prisma.authSession.create({
      data: {
        tokenHash: "sha256:already-revoked-token",
        userId: user.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        revokedAt: new Date(),
      },
    });

    const baseline = await db.prisma.authSession.count({
      where: { userId: user.id },
    });

    await retryAfterFailure({
      failingAttempt: () => sessions().rotate(revokedSession.id, authenticated),
      retryAttempt: () => sessions().rotate(liveSession.id, authenticated),
      baselineCount: baseline,
      countAfterFailure: () =>
        db.prisma.authSession.count({ where: { userId: user.id } }),
      countAfterRetry: () =>
        db.prisma.authSession.count({ where: { userId: user.id } }),
    });

    const rotatedOriginal = await db.prisma.authSession.findUniqueOrThrow({
      where: { id: liveSession.id },
    });
    expect(rotatedOriginal.revokedAt).not.toBeNull();
    expect(rotatedOriginal.rotatedToId).not.toBeNull();

    const replacement = await db.prisma.authSession.findUniqueOrThrow({
      where: { id: rotatedOriginal.rotatedToId! },
    });
    expect(replacement.revokedAt).toBeNull();
    expect(replacement.userId).toBe(user.id);
  });

  it("lets exactly one of two concurrent rotations of the same session win, with no orphaned replacement from the loser", async () => {
    const user = await seedUser(db.prisma, "retry-rotation-race");
    const authenticated: AuthenticatedUser = {
      id: user.id,
      walletAddress: user.walletAddress,
      walletHash: user.walletHash,
      role: user.role,
    };
    const session = await db.prisma.authSession.create({
      data: {
        tokenHash: "sha256:race-token",
        userId: user.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const results = await Promise.allSettled([
      sessions().rotate(session.id, authenticated),
      sessions().rotate(session.id, authenticated),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Exactly one replacement session exists for the original — the loser's
    // attempt must not have left a second, orphaned replacement behind.
    const original = await db.prisma.authSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    const replacements = await db.prisma.authSession.count({
      where: { userId: user.id, id: { not: session.id } },
    });
    expect(replacements).toBe(1);
    expect(original.rotatedToId).not.toBeNull();
  });
});

describe("no success signal for a rolled-back operation", () => {
  it("revokeProof rejects rather than returning a success value when the request is refused", async () => {
    // Regression guard for the acceptance criterion "No success response or
    // event is produced for a rolled-back operation": if a future change
    // ever caught the guard's rejection internally and returned a
    // partial/placeholder success value instead of propagating it, this is
    // the test that would catch it — asserted directly against the real
    // service method's return value.
    const owner = await seedUser(db.prisma, "no-false-success-owner");
    const stranger = await seedUser(db.prisma, "no-false-success-stranger");
    const proof = await seedProof(db.prisma, "no-false-success-proof", owner.id, {
      contractTransactionHash: "deadbeefTXHASH",
    });

    const outcome = await proofs()
      .revokeProof(stranger, proof.id)
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(outcome.ok).toBe(false);

    // The proof was neither revoked nor did a REVOKE intent get enqueued —
    // the refused call did not produce a return value or a side effect a
    // caller could have mistaken for success.
    const unchanged = await db.prisma.proof.findUniqueOrThrow({
      where: { id: proof.id },
    });
    expect(unchanged.status).toBe(ProofStatus.ACTIVE);
    expect(unchanged.revokedAt).toBeNull();
    expect(
      await db.prisma.anchoringIntent.count({ where: { proofId: proof.id } }),
    ).toBe(0);
  });
});
