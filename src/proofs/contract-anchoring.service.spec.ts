import { ConfigService } from "@nestjs/config";
import {
  AnchorProofInput,
  ContractAnchoringService,
} from "./contract-anchoring.service";
import { sha256 } from "../common/crypto/hash";
import { CircuitBreakerRegistry } from "../common/resilience/circuit-breaker.registry";

// The REAL child_process.execFile carries a `util.promisify.custom` symbol
// so that `promisify(execFile)` — used internally by ContractAnchoringService
// — resolves with `{ stdout, stderr }`. A bare `jest.fn()` replacement has no
// such symbol, so `promisify()` would silently fall back to its GENERIC
// wrapper (which resolves with only the callback's 2nd argument, a bare
// string, not an object), breaking the service's `{ stdout } = await ...`
// destructuring. The mock factory below attaches that same symbol to its
// `execFile` export so the real promisify contract holds under test; the
// callback spy (`mockExecFileCallback`) is what tests actually control.
jest.mock("child_process", () => {
  const { promisify } = jest.requireActual("util");
  const mockExecFileCallback = jest.fn();

  function execFile(
    cmd: string,
    args: readonly string[],
    opts: unknown,
    callback: (error: Error | null, stdout: string) => void,
  ) {
    return mockExecFileCallback(cmd, args, opts, callback);
  }
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
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

type ConfigOverrides = Partial<{
  "contractAnchoring.enabled": boolean;
  "contractAnchoring.required": boolean;
  "contractAnchoring.stellarCliPath": string;
  "contractAnchoring.source": string;
  "stellar.network": string;
  "contractAnchoring.proofRegistryContractId": string;
  "contractAnchoring.issuerAddress": string;
  "contractAnchoring.schemaVersion": number;
}>;

const DEFAULT_CONFIG: Required<ConfigOverrides> = {
  "contractAnchoring.enabled": true,
  "contractAnchoring.required": false,
  "contractAnchoring.stellarCliPath": "stellar",
  "contractAnchoring.source": "SOURCE_ACCOUNT",
  "stellar.network": "testnet",
  "contractAnchoring.proofRegistryContractId": "CONTRACT_ID",
  "contractAnchoring.issuerAddress": "GISSUER",
  "contractAnchoring.schemaVersion": 1,
};

function buildService(
  overrides: ConfigOverrides & Record<string, unknown> = {},
  registry?: CircuitBreakerRegistry,
) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const configService = {
    get: (key: string) => (config as Record<string, unknown>)[key],
  } as unknown as ConfigService;
  return new ContractAnchoringService(configService, registry);
}

// The REAL child_process.execFile has a `util.promisify.custom` symbol that
// makes `promisify(execFile)` resolve with `{ stdout, stderr }`. Once we
// jest.mock the module, our bare `jest.fn()` replacement has no such symbol,
// so `promisify()` falls back to its GENERIC wrapper — which resolves with
// only the callback's second argument (a bare string), not an object. The
// service destructures `{ stdout }` from the awaited call, so our mocked
// callback must be invoked as (error, stdout) — exactly two arguments — to
// match that generic-wrapper contract, not the three-argument node-style
// (error, stdout, stderr) the real (non-promisified) execFile callback uses.
function mockExecFileOnce(
  behavior: { stdout: string } | { error: Error & { code?: string } },
) {
  mockExecFile.mockImplementationOnce(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (
        error: (Error & { code?: string }) | null,
        stdout: string,
      ) => void,
    ) => {
      if ("error" in behavior) {
        callback(behavior.error, "");
      } else {
        callback(null, behavior.stdout);
      }
    },
  );
}

describe("ContractAnchoringService", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  const proofInput: AnchorProofInput = {
    proofId: "proof_123",
    commitment: "sha256:" + "a".repeat(64),
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
  };

  describe("disabled / misconfigured", () => {
    it("skips anchoring (no CLI call) when disabled", async () => {
      const service = buildService({ "contractAnchoring.enabled": false });
      const result = await service.anchorProof(proofInput);

      expect(result).toEqual({ anchored: false, reason: "disabled" });
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("skips anchoring when enabled but missing required config (source)", async () => {
      const service = buildService({ "contractAnchoring.source": undefined });
      const result = await service.anchorProof(proofInput);

      expect(result).toEqual({ anchored: false, reason: "disabled" });
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("skips getProofStatus when disabled", async () => {
      const service = buildService({ "contractAnchoring.enabled": false });
      const result = await service.getProofStatus("proof_123");

      expect(result).toEqual({ checked: false, reason: "disabled" });
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("skips revokeProof when disabled", async () => {
      const service = buildService({ "contractAnchoring.enabled": false });
      const result = await service.revokeProof("proof_123");

      expect(result).toEqual({ anchored: false, reason: "disabled" });
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  describe("anchorProof — happy path", () => {
    it("registers the proof and returns the transaction hash from the last CLI output line", async () => {
      const service = buildService();
      mockExecFileOnce({
        stdout: "Submitting transaction...\ndeadbeefTXHASH\n",
      });

      const result = await service.anchorProof(proofInput);

      expect(result).toEqual({
        anchored: true,
        transactionHash: "deadbeefTXHASH",
      });
    });

    it("invokes the CLI with the expected register_proof arguments", async () => {
      const service = buildService();
      mockExecFileOnce({ stdout: "TXHASH" });

      await service.anchorProof(proofInput);

      expect(mockExecFile).toHaveBeenCalledWith(
        "stellar",
        [
          "contract",
          "invoke",
          "--source",
          "SOURCE_ACCOUNT",
          "--network",
          "testnet",
          "--id",
          "CONTRACT_ID",
          "--",
          "register_proof",
          "--proof_id_hash",
          sha256("proof_123"),
          "--commitment_hash",
          "a".repeat(64),
          "--issuer_address",
          "GISSUER",
          "--schema_version",
          "1",
          "--expires_at",
          String(Math.floor(proofInput.expiresAt.getTime() / 1000)),
        ],
        expect.objectContaining({ timeout: 120_000 }),
        expect.any(Function),
      );
    });

    it("hashes a commitment that isn't already a sha256: digest before sending it", async () => {
      const service = buildService();
      mockExecFileOnce({ stdout: "TXHASH" });

      await service.anchorProof({ ...proofInput, commitment: "raw-commitment-value" });

      const [, args] = mockExecFile.mock.calls[0];
      const commitmentIndex = args.indexOf("--commitment_hash");
      expect(args[commitmentIndex + 1]).toBe(sha256("raw-commitment-value"));
    });
  });

  describe("anchorProof — CLI failure (not required)", () => {
    it("returns a safe failure result without throwing, and logs a warning", async () => {
      const service = buildService({ "contractAnchoring.required": false });
      const loggerWarnSpy = jest.spyOn(
        (service as unknown as { logger: { warn: jest.Mock } }).logger,
        "warn",
      );
      mockExecFileOnce({
        error: Object.assign(new Error("Network error: connection refused"), {
          code: "ECONNREFUSED",
        }),
      });

      const result = await service.anchorProof(proofInput);

      expect(result).toEqual({
        anchored: false,
        reason: "failed",
        error: "Network error: connection refused",
      });
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Network error: connection refused"),
      );
    });

    it("never leaks the CLI source account or contract id into the logged error message", async () => {
      const service = buildService();
      const loggerWarnSpy = jest.spyOn(
        (service as unknown as { logger: { warn: jest.Mock } }).logger,
        "warn",
      );
      mockExecFileOnce({
        error: new Error("exit code 1: invalid response"),
      });

      await service.anchorProof(proofInput);

      const loggedMessage = loggerWarnSpy.mock.calls[0][0] as string;
      expect(loggedMessage).not.toContain("SOURCE_ACCOUNT");
      expect(loggedMessage).not.toContain("CONTRACT_ID");
      expect(loggedMessage).not.toContain("GISSUER");
    });

    it("redacts signing material embedded by Node in a failed command's argv", async () => {
      const service = buildService();
      const secret = `S${"A".repeat(55)}`;
      const loggerWarnSpy = jest.spyOn(
        (service as unknown as { logger: { warn: jest.Mock } }).logger,
        "warn",
      );
      mockExecFileOnce({
        error: new Error(`Command failed: stellar contract invoke --source ${secret} RPC_TOKEN=synthetic`),
      });

      const result = await service.anchorProof(proofInput);
      expect(result).toEqual(expect.objectContaining({ anchored: false, reason: "failed" }));
      expect(result.anchored ? "" : result.error).not.toContain(secret);
      expect(loggerWarnSpy.mock.calls[0][0]).not.toContain(secret);
      expect(loggerWarnSpy.mock.calls[0][0]).toContain("[REDACTED_SECRET]");
    });

    it("falls back to a generic message when the thrown value isn't an Error", async () => {
      const service = buildService();
      mockExecFile.mockImplementationOnce(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          callback: (error: unknown, stdout: string) => void,
        ) => {
          callback("a raw string rejection, not an Error instance", "");
        },
      );

      const result = await service.anchorProof(proofInput);

      expect(result).toEqual({
        anchored: false,
        reason: "failed",
        error: "Unknown error",
      });
    });
  });

  describe("anchorProof — CLI failure (required)", () => {
    it("re-throws instead of swallowing the error when anchoring is required", async () => {
      const service = buildService({ "contractAnchoring.required": true });
      mockExecFileOnce({ error: new Error("Network error") });

      await expect(service.anchorProof(proofInput)).rejects.toThrow(
        "Network error",
      );
    });
  });

  describe("revokeProof", () => {
    it("invokes revoke_proof and returns the transaction hash on success", async () => {
      const service = buildService();
      mockExecFileOnce({ stdout: "REVOKE_TX_HASH" });

      const result = await service.revokeProof("proof_123");

      expect(result).toEqual({
        anchored: true,
        transactionHash: "REVOKE_TX_HASH",
      });
      expect(mockExecFile).toHaveBeenCalledWith(
        "stellar",
        expect.arrayContaining([
          "revoke_proof",
          "--proof_id_hash",
          sha256("proof_123"),
        ]),
        expect.anything(),
        expect.any(Function),
      );
    });

    it("returns a safe failure result on CLI error when not required", async () => {
      const service = buildService();
      mockExecFileOnce({ error: new Error("revoke failed") });

      const result = await service.revokeProof("proof_123");

      expect(result).toEqual({
        anchored: false,
        reason: "failed",
        error: "revoke failed",
      });
    });

    it("re-throws on CLI error when anchoring is required", async () => {
      const service = buildService({ "contractAnchoring.required": true });
      mockExecFileOnce({ error: new Error("revoke failed") });

      await expect(service.revokeProof("proof_123")).rejects.toThrow(
        "revoke failed",
      );
    });
  });

  describe("getProofStatus", () => {
    it("reports checked:true with revoked/valid parsed from CLI output", async () => {
      const service = buildService();
      // getProofStatus fires is_revoked and is_valid_proof concurrently via
      // Promise.all — order of the two execFile calls is not guaranteed, so
      // this mock responds based on which function name each call carries.
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          args: string[],
          _opts: unknown,
          callback: (error: null, stdout: string) => void,
        ) => {
          const isRevokedCall = args.includes("is_revoked");
          callback(null, isRevokedCall ? "false" : "true");
        },
      );

      const result = await service.getProofStatus("proof_123");

      expect(result).toEqual({ checked: true, revoked: false, valid: true });
    });

    it("parses CLI boolean output case-insensitively and trims whitespace", async () => {
      const service = buildService();
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          args: string[],
          _opts: unknown,
          callback: (error: null, stdout: string) => void,
        ) => {
          const isRevokedCall = args.includes("is_revoked");
          callback(null, isRevokedCall ? "  TRUE  \n" : "False\n");
        },
      );

      const result = await service.getProofStatus("proof_123");

      expect(result).toEqual({ checked: true, revoked: true, valid: false });
    });

    it("returns a safe failure result without throwing when the CLI errors and anchoring is not required", async () => {
      const service = buildService({ "contractAnchoring.required": false });
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          callback: (error: Error, stdout: string) => void,
        ) => {
          callback(new Error("CLI unreachable"), "");
        },
      );

      const result = await service.getProofStatus("proof_123");

      expect(result).toEqual({
        checked: false,
        reason: "failed",
        error: "CLI unreachable",
      });
    });

    it("re-throws when the CLI errors and anchoring is required", async () => {
      const service = buildService({ "contractAnchoring.required": true });
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          callback: (error: Error, stdout: string) => void,
        ) => {
          callback(new Error("CLI unreachable"), "");
        },
      );

      await expect(service.getProofStatus("proof_123")).rejects.toThrow(
        "CLI unreachable",
      );
    });
  });

  // Retry / exponential-backoff behavior is an explicit acceptance criterion
  // in issue #109, but ContractAnchoringService currently has NO retry logic
  // anywhere (anchorProof/revokeProof/getProofStatus each make exactly one
  // execFile call and either return a "failed" result or throw once). There
  // is nothing to test here without first adding that behavior to the
  // service, which is out of scope for a test-coverage issue — see this PR's
  // description for the full disclosure and a suggested follow-up issue.

  describe("circuit breaker (issue #203)", () => {
    /** Fails every execFile call with a transient error until reset. */
    function failEveryCall(message = "rpc timeout") {
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          callback: (error: Error | null, stdout: string) => void,
        ) => callback(new Error(message), ""),
      );
    }

    const circuitConfig = {
      "contractAnchoring.circuitBreaker.failureThreshold": 2,
      "contractAnchoring.circuitBreaker.openDurationMs": 60_000,
    };

    it("opens after repeated transient failures, then refuses without touching the CLI", async () => {
      const registry = new CircuitBreakerRegistry();
      const service = buildService(circuitConfig, registry);
      failEveryCall();

      // Two transient failures reach the failure threshold.
      await service.anchorProof(proofInput);
      await service.anchorProof(proofInput);
      expect(service.circuitState("register")).toBe("open");

      mockExecFile.mockClear();
      const result = await service.anchorProof(proofInput);
      // Refused by the open circuit: reported as circuit_open, CLI not called.
      expect(result).toEqual({ anchored: false, reason: "circuit_open" });
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("does not open on a permanent contract error", async () => {
      const registry = new CircuitBreakerRegistry();
      const service = buildService(circuitConfig, registry);
      failEveryCall("proof already registered");

      for (let i = 0; i < 5; i += 1) {
        await service.anchorProof(proofInput);
      }
      // The dependency answered every time; the circuit stays closed.
      expect(service.circuitState("register")).toBe("closed");
    });

    it("tracks register, revoke, and read as independent circuits", async () => {
      const registry = new CircuitBreakerRegistry();
      const service = buildService(circuitConfig, registry);
      failEveryCall();

      await service.anchorProof(proofInput);
      await service.anchorProof(proofInput);

      expect(service.circuitState("register")).toBe("open");
      // A revoke circuit is untouched by register failures.
      expect(service.circuitState("revoke")).toBe("closed");
      expect(service.circuitState("read")).toBe("closed");
    });

    it("reports closed when no registry is wired (breaker disabled)", () => {
      const service = buildService();
      expect(service.circuitState("register")).toBe("closed");
    });
  });
});
