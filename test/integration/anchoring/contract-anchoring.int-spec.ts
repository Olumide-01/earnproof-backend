/**
 * Contract Anchoring Integration Tests
 *
 * Tests the full lifecycle of anchoring intents: registration, revocation,
 * error handling, and retry/backoff behavior. These tests mock the Stellar CLI
 * at the execFile boundary to avoid real CLI calls or network hits.
 *
 * The test suite covers:
 * 1. Happy path — registration: anchoring record created, proof state updated
 * 2. Happy path — revocation: equivalent for revocation
 * 3. Error path — CLI failure: anchoring marked failed, error message is safe
 * 4. Retry path: transient errors trigger retry with exponential backoff
 * 5. State transition coverage: intermediate and final states are correct
 * 6. Logging safety: no secrets in error output
 */

import { promisify } from "util";
import { AnchoringOperation, AnchoringStatus, ProofStatus } from "@prisma/client";
import { ContractAnchoringService } from "../../../src/proofs/contract-anchoring.service";
import { AnchoringWorkerService } from "../../../src/jobs/anchoring-worker.service";
import { integrationDatabase } from "../harness/database";
import { integrationModule } from "../harness/nest";
import { seedUser, seedProof } from "../harness/fixtures";
import {
  mockSuccessfulRegistration,
  mockSuccessfulRevocation,
  mockNetworkError,
  mockTimeoutError,
  mockInvalidContractError,
  mockUnauthorizedError,
  mockAlreadyRegisteredError,
  mockTransientServerError,
  MockCliResponse,
} from "./mocks";
import { sha256 } from "../../../src/common/crypto/hash";

// Mock child_process.execFile at the module level, using the same promisify.custom
// pattern as the unit tests. This ensures the promisified version returns { stdout, stderr }
// as the service expects.
jest.mock("child_process", () => {
  const { promisify: realPromisify } = jest.requireActual("util");
  const mockExecFileCallback = jest.fn();

  function execFile(
    cmd: string,
    args: readonly string[],
    opts: unknown,
    callback: (error: Error | null, stdout: string) => void,
  ) {
    return mockExecFileCallback(cmd, args, opts, callback);
  }

  (execFile as unknown as Record<symbol, unknown>)[realPromisify.custom] = (
    cmd: string,
    args: readonly string[],
    opts: unknown,
  ) =>
    new Promise((resolve, reject) => {
      mockExecFileCallback(
        cmd,
        args,
        opts,
        (error: Error | null, stdout: string) => {
          if (error) reject(error);
          else resolve({ stdout, stderr: "" });
        },
      );
    });

  return { execFile, __mockExecFileCallback: mockExecFileCallback };
});

const mockExecFile = (
  jest.requireMock("child_process") as { __mockExecFileCallback: jest.Mock }
).__mockExecFileCallback;

// Helper to set up the mock for the next CLI call
function mockCliOnce(response: MockCliResponse) {
  mockExecFile.mockImplementationOnce(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (error: (Error & { code?: string }) | null, stdout: string) => void,
    ) => {
      if (response.type === "error") {
        callback(response.error, "");
      } else {
        callback(null, response.stdout);
      }
    },
  );
}

/**
 * Sets up multiple consecutive mock responses for multiple CLI calls.
 * Used when testing flows that make more than one call.
 */
function mockCliMultiple(responses: MockCliResponse[]) {
  responses.forEach((response) => {
    mockExecFile.mockImplementationOnce(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        callback: (error: (Error & { code?: string }) | null, stdout: string) => void,
      ) => {
        if (response.type === "error") {
          callback(response.error, "");
        } else {
          callback(null, response.stdout);
        }
      },
    );
  });
}

const db = integrationDatabase();
const injector = integrationModule([ContractAnchoringService, AnchoringWorkerService]);

describe("Contract Anchoring Integration", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    // Enable contract anchoring for these tests
    process.env.CONTRACT_ANCHORING_ENABLED = "true";
    process.env.STELLAR_NETWORK = "testnet";
  });

  afterEach(() => {
    delete process.env.CONTRACT_ANCHORING_ENABLED;
    delete process.env.STELLAR_NETWORK;
  });

  /**
   * Scenario 1: Happy Path — Registration
   *
   * Verifies that:
   * - An AnchoringIntent is created with PENDING status
   * - The worker processes it, calls the CLI with register_proof
   * - The intent transitions to CONFIRMED with the transaction hash
   * - The associated Proof's contractTransactionHash is updated
   */
  describe("Happy path — registration", () => {
    it("creates anchoring intent and updates proof state on successful registration", async () => {
      const user = await seedUser(db.prisma, "anchor-reg-user");
      const proof = await seedProof(db.prisma, "anchor-reg-proof", user.id, {
        status: "ACTIVE",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      });

      // Create an AnchoringIntent manually to simulate the proof creation flow
      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PENDING,
          attemptCount: 0,
        },
      });

      // Mock successful registration
      mockCliOnce(mockSuccessfulRegistration("tx_hash_123"));

      // Process the intent
      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      // Verify intent is CONFIRMED
      const updatedIntent = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      expect(updatedIntent.status).toBe(AnchoringStatus.CONFIRMED);
      expect(updatedIntent.transactionHash).toBe("tx_hash_123");
      expect(updatedIntent.attemptCount).toBe(1);
      expect(updatedIntent.lastErrorSafe).toBeNull();

      // Verify proof's contractTransactionHash is updated
      const updatedProof = await db.prisma.proof.findUniqueOrThrow({
        where: { id: proof.id },
      });
      expect(updatedProof.contractTransactionHash).toBe("tx_hash_123");
      expect(updatedProof.status).toBe(ProofStatus.ACTIVE); // State unchanged by worker
    });

    it("calls CLI with correct register_proof arguments", async () => {
      const user = await seedUser(db.prisma, "anchor-args-user");
      const proof = await seedProof(db.prisma, "anchor-args-proof", user.id, {
        expiresAt: new Date("2027-06-15T12:30:45.000Z"),
      });

      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PENDING,
        },
      });

      mockCliOnce(mockSuccessfulRegistration("tx_456"));

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      // Verify the CLI was called with the expected arguments
      expect(mockExecFile).toHaveBeenCalledWith(
        expect.anything(), // command
        expect.arrayContaining([
          "contract",
          "invoke",
          "--",
          "register_proof",
          "--proof_id_hash",
          sha256(proof.id),
        ]),
        expect.anything(), // options
        expect.any(Function), // callback
      );
    });

    it("extracts transaction hash from last line of CLI output", async () => {
      const user = await seedUser(db.prisma, "anchor-txhash-user");
      const proof = await seedProof(db.prisma, "anchor-txhash-proof", user.id);

      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PENDING,
        },
      });

      // Mock CLI output with multiple lines; expect last line to be extracted
      mockCliOnce({
        type: "success",
        stdout: "Processing...\nSubmitting transaction...\nconfirmed_tx_hash_xyz\n",
      });

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      const updatedIntent = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      expect(updatedIntent.transactionHash).toBe("confirmed_tx_hash_xyz");
    });
  });

  /**
   * Scenario 2: Happy Path — Revocation
   *
   * Verifies that:
   * - An AnchoringIntent with REVOKE operation is processed
   * - The worker calls CLI with revoke_proof
   * - The intent transitions to CONFIRMED
   * - The Proof's contractTransactionHash is updated
   */
  describe("Happy path — revocation", () => {
    it("creates anchoring intent and updates proof state on successful revocation", async () => {
      const user = await seedUser(db.prisma, "anchor-revoke-user");
      const proof = await seedProof(db.prisma, "anchor-revoke-proof", user.id, {
        status: "ACTIVE",
        contractTransactionHash: "original_tx_hash",
      });

      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REVOKE,
          status: AnchoringStatus.PENDING,
        },
      });

      mockCliOnce(mockSuccessfulRevocation("revoke_tx_hash_789"));

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      const updatedIntent = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      expect(updatedIntent.status).toBe(AnchoringStatus.CONFIRMED);
      expect(updatedIntent.operation).toBe(AnchoringOperation.REVOKE);
      expect(updatedIntent.transactionHash).toBe("revoke_tx_hash_789");

      const updatedProof = await db.prisma.proof.findUniqueOrThrow({
        where: { id: proof.id },
      });
      expect(updatedProof.contractTransactionHash).toBe("revoke_tx_hash_789");
    });

    it("calls CLI with correct revoke_proof arguments", async () => {
      const user = await seedUser(db.prisma, "revoke-args-user");
      const proof = await seedProof(db.prisma, "revoke-args-proof", user.id);

      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REVOKE,
          status: AnchoringStatus.PENDING,
        },
      });

      mockCliOnce(mockSuccessfulRevocation("revoke_tx"));

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      expect(mockExecFile).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([
          "contract",
          "invoke",
          "--",
          "revoke_proof",
          "--proof_id_hash",
          sha256(proof.id),
        ]),
        expect.anything(),
        expect.any(Function),
      );
    });
  });

  /**
   * Scenario 3: Error Path — CLI Failure
   *
   * Verifies that:
   * - CLI errors are caught and marked as FAILED
   * - Error messages are redacted (no secrets, no internal paths)
   * - Permanent errors do not retry
   * - Transient errors are retried with backoff
   */
  describe("Error path — CLI failure", () => {
    it("marks intent FAILED on permanent error (invalid contract)", async () => {
      const user = await seedUser(db.prisma, "anchor-fail-user");
      const proof = await seedProof(db.prisma, "anchor-fail-proof", user.id);

      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PENDING,
        },
      });

      // Permanent error: contract not found
      mockCliOnce(mockInvalidContractError());

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      const updatedIntent = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      expect(updatedIntent.status).toBe(AnchoringStatus.FAILED);
      expect(updatedIntent.permanentError).toBe(true);
      expect(updatedIntent.nextRetryAt).toBeNull(); // No retry scheduled
      expect(updatedIntent.lastErrorSafe).toContain("Invalid contract id");
    });

    it("redacts error message to prevent secret leakage", async () => {
      const user = await seedUser(db.prisma, "anchor-redact-user");
      const proof = await seedProof(db.prisma, "anchor-redact-proof", user.id);

      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PENDING,
        },
      });

      // Simulate Node embedding a secret key in the error message (from argv)
      const secretKey = "S" + "A".repeat(55);
      mockCliOnce({
        type: "error",
        error: new Error(
          `Command failed: stellar contract invoke --source ${secretKey} --network testnet`,
        ),
      });

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      const updatedIntent = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });

      // Verify the secret key is not in the stored error message
      expect(updatedIntent.lastErrorSafe).not.toContain(secretKey);
      // Should contain a redaction marker instead
      expect(updatedIntent.lastErrorSafe).toContain("[REDACTED");
    });

    it("does not leak internal config values in error message", async () => {
      const user = await seedUser(db.prisma, "anchor-config-user");
      const proof = await seedProof(db.prisma, "anchor-config-proof", user.id);

      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PENDING,
        },
      });

      mockCliOnce(mockUnauthorizedError());

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      const updatedIntent = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });

      // Verify common config values are not in the error
      expect(updatedIntent.lastErrorSafe).not.toContain("CONTRACT_ID");
      expect(updatedIntent.lastErrorSafe).not.toContain("SOURCE_ACCOUNT");
      expect(updatedIntent.lastErrorSafe).not.toContain("GISSUER");
    });
  });

  /**
   * Scenario 4: Retry Path — Exponential Backoff
   *
   * Verifies that:
   * - Transient errors (network, timeout) trigger retry
   * - nextRetryAt is set to a future date
   * - Backoff intervals increase exponentially
   * - MAX_ATTEMPTS boundary is respected
   */
  describe("Retry path — exponential backoff", () => {
    it("schedules retry on transient network error with backoff", async () => {
      const user = await seedUser(db.prisma, "anchor-retry-user");
      const proof = await seedProof(db.prisma, "anchor-retry-proof", user.id);

      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PENDING,
          attemptCount: 0,
        },
      });

      const beforeTime = Date.now();
      mockCliOnce(mockNetworkError());

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      const updatedIntent = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });

      // Should be back to PENDING with a scheduled retry
      expect(updatedIntent.status).toBe(AnchoringStatus.PENDING);
      expect(updatedIntent.permanentError).toBe(false);
      expect(updatedIntent.attemptCount).toBe(1);
      expect(updatedIntent.nextRetryAt).not.toBeNull();

      // Verify backoff: first retry should be ~30s (BACKOFF_BASE_MS)
      const delayMs = updatedIntent.nextRetryAt!.getTime() - beforeTime;
      expect(delayMs).toBeGreaterThan(29_000); // Allow small jitter
      expect(delayMs).toBeLessThan(32_000);
    });

    it("increases backoff exponentially with each retry", async () => {
      const user = await seedUser(db.prisma, "anchor-exp-backoff-user");
      const proof = await seedProof(db.prisma, "anchor-exp-backoff-proof", user.id);

      // Start with attemptCount = 2 (simulating 2 prior failures)
      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PENDING,
          attemptCount: 2,
        },
      });

      const beforeTime = Date.now();
      mockCliOnce(mockTimeoutError());

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      const updatedIntent = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });

      // Third attempt: backoff should be 30s * 2^(3-1) = 30s * 4 = 120s
      const delayMs = updatedIntent.nextRetryAt!.getTime() - beforeTime;
      expect(delayMs).toBeGreaterThan(119_000);
      expect(delayMs).toBeLessThan(122_000);
    });

    it("stops retrying after MAX_ATTEMPTS (10) is reached", async () => {
      const user = await seedUser(db.prisma, "anchor-maxattempts-user");
      const proof = await seedProof(db.prisma, "anchor-maxattempts-proof", user.id);

      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PENDING,
          attemptCount: 9, // Already at 9 attempts
        },
      });

      mockCliOnce(mockTransientServerError());

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      const updatedIntent = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });

      // 10th attempt hit; should be FAILED (MAX_ATTEMPTS exceeded)
      expect(updatedIntent.status).toBe(AnchoringStatus.FAILED);
      expect(updatedIntent.permanentError).toBe(true);
      expect(updatedIntent.nextRetryAt).toBeNull();
      expect(updatedIntent.attemptCount).toBe(10);
    });

    it("distinguishes transient from permanent errors", async () => {
      const user = await seedUser(db.prisma, "anchor-distinguish-user");

      // Test 1: Transient error (network)
      const transientProof = await seedProof(
        db.prisma,
        "anchor-transient-proof",
        user.id,
      );
      const transientIntent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: transientProof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PENDING,
          attemptCount: 0,
        },
      });

      mockCliOnce(mockNetworkError());

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(transientIntent.id);

      const transientUpdated = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: transientIntent.id },
      });
      expect(transientUpdated.status).toBe(AnchoringStatus.PENDING); // Retrying
      expect(transientUpdated.permanentError).toBe(false);
      expect(transientUpdated.nextRetryAt).not.toBeNull();

      // Test 2: Permanent error (already registered)
      const permanentProof = await seedProof(
        db.prisma,
        "anchor-permanent-proof",
        user.id,
      );
      const permanentIntent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: permanentProof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PENDING,
          attemptCount: 0,
        },
      });

      mockCliOnce(mockAlreadyRegisteredError());

      await worker.processIntent(permanentIntent.id);

      const permanentUpdated = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: permanentIntent.id },
      });
      expect(permanentUpdated.status).toBe(AnchoringStatus.FAILED); // Not retrying
      expect(permanentUpdated.permanentError).toBe(true);
      expect(permanentUpdated.nextRetryAt).toBeNull();
    });
  });

  /**
   * Scenario 5: State Transition Coverage
   *
   * Verifies that intermediate and final states are correct at each step.
   */
  describe("State transition coverage", () => {
    it("transitions PENDING → CONFIRMED on success", async () => {
      const user = await seedUser(db.prisma, "anchor-state-user");
      const proof = await seedProof(db.prisma, "anchor-state-proof", user.id);

      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PENDING,
          attemptCount: 0,
        },
      });

      expect(intent.status).toBe(AnchoringStatus.PENDING);
      expect(intent.lastAttemptAt).toBeNull();

      mockCliOnce(mockSuccessfulRegistration("tx_state"));

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      const updated = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });

      expect(updated.status).toBe(AnchoringStatus.CONFIRMED);
      expect(updated.lastAttemptAt).not.toBeNull();
      expect(updated.attemptCount).toBe(1);
      expect(updated.transactionHash).toBe("tx_state");
    });

    it("transitions PENDING → FAILED on permanent error", async () => {
      const user = await seedUser(db.prisma, "anchor-fail-state-user");
      const proof = await seedProof(db.prisma, "anchor-fail-state-proof", user.id);

      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PENDING,
          attemptCount: 0,
        },
      });

      mockCliOnce(mockInvalidContractError());

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      const updated = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });

      expect(updated.status).toBe(AnchoringStatus.FAILED);
      expect(updated.lastAttemptAt).not.toBeNull();
      expect(updated.attemptCount).toBe(1);
    });

    it("maintains PENDING on transient error but schedules nextRetryAt", async () => {
      const user = await seedUser(db.prisma, "anchor-retry-state-user");
      const proof = await seedProof(db.prisma, "anchor-retry-state-proof", user.id);

      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PENDING,
          attemptCount: 1,
        },
      });

      mockCliOnce(mockNetworkError());

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      const updated = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });

      expect(updated.status).toBe(AnchoringStatus.PENDING); // Still pending
      expect(updated.attemptCount).toBe(2);
      expect(updated.lastAttemptAt).not.toBeNull();
      expect(updated.nextRetryAt).not.toBeNull();
      expect(updated.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  /**
   * Scenario 6: Idempotency
   *
   * Verifies that processing the same intent multiple times does not cause
   * double-anchoring or other issues.
   */
  describe("Idempotency", () => {
    it("does not re-anchor an already-confirmed intent", async () => {
      const user = await seedUser(db.prisma, "anchor-idempotent-user");
      const proof = await seedProof(db.prisma, "anchor-idempotent-proof", user.id);

      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.CONFIRMED,
          transactionHash: "already_confirmed_tx",
          attemptCount: 1,
        },
      });

      // No mock setup — if the worker tries to call CLI, the test will fail

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      // Should not have called CLI (verify no call was made)
      expect(mockExecFile).not.toHaveBeenCalled();

      // Intent should remain CONFIRMED
      const unchanged = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      expect(unchanged.status).toBe(AnchoringStatus.CONFIRMED);
      expect(unchanged.transactionHash).toBe("already_confirmed_tx");
    });

    it("does not re-anchor a permanently-failed intent", async () => {
      const user = await seedUser(db.prisma, "anchor-perm-fail-user");
      const proof = await seedProof(db.prisma, "anchor-perm-fail-proof", user.id);

      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.FAILED,
          lastErrorSafe: "permanent error",
          permanentError: true,
          attemptCount: 1,
        },
      });

      // No mock setup

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      expect(mockExecFile).not.toHaveBeenCalled();

      const unchanged = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      expect(unchanged.status).toBe(AnchoringStatus.FAILED);
    });
  });

  /**
   * Scenario 7: Logging Safety
   *
   * Verifies that logged error output during failure paths does not contain
   * secrets (API keys, private keys, signing material, full CLI command).
   */
  describe("Logging safety", () => {
    it("does not log raw secrets in error messages", async () => {
      const user = await seedUser(db.prisma, "anchor-log-user");
      const proof = await seedProof(db.prisma, "anchor-log-proof", user.id);

      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PENDING,
        },
      });

      const secretKey = "S" + "A".repeat(55);
      mockCliOnce({
        type: "error",
        error: new Error(
          `Command failed with env: RPC_TOKEN=super_secret_token SIGNING_KEY=${secretKey}`,
        ),
      });

      const loggerErrorSpy = jest.spyOn(
        injector.get(AnchoringWorkerService) as any,
        "logger",
        "get",
      );

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      // Verify the stored error message is safe (not the raw error)
      const updated = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });

      expect(updated.lastErrorSafe).not.toContain(secretKey);
      expect(updated.lastErrorSafe).not.toContain("super_secret_token");
    });

    it("sanitizes RPC/API tokens from error messages", async () => {
      const user = await seedUser(db.prisma, "anchor-token-user");
      const proof = await seedProof(db.prisma, "anchor-token-proof", user.id);

      const intent = await db.prisma.anchoringIntent.create({
        data: {
          proofId: proof.id,
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PENDING,
        },
      });

      mockCliOnce({
        type: "error",
        error: new Error(
          "RPC_TOKEN=abc123def456 not authorized for this account",
        ),
      });

      const worker = injector.get(AnchoringWorkerService);
      await worker.processIntent(intent.id);

      const updated = await db.prisma.anchoringIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });

      expect(updated.lastErrorSafe).not.toContain("abc123def456");
    });
  });
});
