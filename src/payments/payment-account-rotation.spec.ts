import { Keypair } from "@stellar/stellar-base";
import {
  activeAccountKey,
  activeUserKey,
  assertNoSecretMaterial,
  buildRotationMessage,
  isPublicAccountId,
  planBackfill,
  SecretMaterialError,
  withinRollbackWindow,
} from "./payment-account-rotation";

describe("payment account rotation rules", () => {
  const account = Keypair.random();

  describe("assertNoSecretMaterial", () => {
    it("refuses a secret seed in any position without echoing it", () => {
      const seed = Keypair.random().secret();
      let caught: unknown;
      try {
        assertNoSecretMaterial(["testnet", seed]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SecretMaterialError);
      expect(String((caught as Error).message)).not.toContain(seed);
    });

    it("refuses a seed embedded in a longer string", () => {
      expect(() => assertNoSecretMaterial([`key=${Keypair.random().secret()}`])).toThrow(SecretMaterialError);
    });

    it("accepts public ids and non-strings", () => {
      expect(() => assertNoSecretMaterial([account.publicKey(), 42, undefined])).not.toThrow();
    });
  });

  describe("isPublicAccountId", () => {
    it("accepts a plain Ed25519 account id", () => {
      expect(isPublicAccountId(account.publicKey())).toBe(true);
    });

    it.each([
      ["a secret seed", () => Keypair.random().secret()],
      ["a bad checksum", () => `${account.publicKey().slice(0, 55)}${account.publicKey().endsWith("A") ? "B" : "A"}`],
      ["a contract id", () => `C${account.publicKey().slice(1)}`],
      ["a muxed account", () => `M${account.publicKey().slice(1)}`],
      ["lower case", () => account.publicKey().toLowerCase()],
      ["empty", () => ""],
    ])("refuses %s", (_label, make) => {
      expect(isPublicAccountId(make())).toBe(false);
    });
  });

  describe("buildRotationMessage", () => {
    const binding = {
      appUrl: "https://app.example",
      networkPassphrase: "Test SDF Network ; September 2015",
      userId: "user-1",
      fromAccountId: "GFROM",
      toAccountId: "GTO",
      rotationId: "rot-1",
      nonce: "nonce-1",
      expiresAt: new Date("2030-01-01T00:10:00.000Z"),
    };

    it("binds every field that must not be transplanted", () => {
      const message = buildRotationMessage(binding);
      for (const value of [
        binding.appUrl,
        binding.networkPassphrase,
        binding.userId,
        binding.fromAccountId,
        binding.toAccountId,
        binding.rotationId,
        binding.nonce,
        binding.expiresAt.toISOString(),
      ]) {
        expect(message).toContain(value);
      }
    });

    it("has a protocol-specific first line, so login and wallet-rotation signatures cannot be replayed", () => {
      expect(buildRotationMessage(binding).split("\n")[0]).toBe("EarnProof payment account rotation");
    });

    it("differs per network, so a testnet signature is useless on mainnet", () => {
      expect(buildRotationMessage(binding)).not.toBe(
        buildRotationMessage({ ...binding, networkPassphrase: "Public Global Stellar Network ; September 2015" }),
      );
    });
  });

  describe("planBackfill", () => {
    it("plans nothing without a requested start or a final checkpoint", () => {
      expect(planBackfill(null, 1_000)).toBeNull();
      expect(planBackfill(500, null)).toBeNull();
    });

    it("ends exactly at the handoff boundary", () => {
      expect(planBackfill(500, 1_000)).toEqual({ startLedger: 500, endLedger: 1_000 });
    });

    it("allows a single-ledger plan at the boundary", () => {
      expect(planBackfill(1_000, 1_000)).toEqual({ startLedger: 1_000, endLedger: 1_000 });
    });

    it("plans nothing when the start is past the boundary", () => {
      expect(planBackfill(1_001, 1_000)).toBeNull();
    });

    it("clamps to the maximum span, keeping the most recent ledgers", () => {
      expect(planBackfill(2, 1_000_000, 100)).toEqual({ startLedger: 999_901, endLedger: 1_000_000 });
    });

    it("never starts below the worker's minimum ledger", () => {
      expect(planBackfill(1, 10)).toEqual({ startLedger: 2, endLedger: 10 });
    });
  });

  describe("withinRollbackWindow", () => {
    const deadline = new Date("2030-01-02T00:00:00.000Z");
    it("is inclusive of the deadline", () => {
      expect(withinRollbackWindow(deadline.getTime(), deadline)).toBe(true);
      expect(withinRollbackWindow(deadline.getTime() + 1, deadline)).toBe(false);
      expect(withinRollbackWindow(0, null)).toBe(false);
    });
  });

  it("keys active accounts by user+network and network+account", () => {
    expect(activeUserKey("u1", "testnet")).toBe("u1:testnet");
    expect(activeAccountKey("testnet", "GABC")).toBe("testnet:GABC");
    expect(activeAccountKey("testnet", "GABC")).not.toBe(activeAccountKey("mainnet", "GABC"));
  });
});
