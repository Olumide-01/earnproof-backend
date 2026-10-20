import { ConfigService } from "@nestjs/config";
import { HttpException, HttpStatus } from "@nestjs/common";
import { ProofVerificationAbuseService } from "./proof-verification-abuse.service";

function makeConfig(overrides: Record<string, number> = {}) {
  const values: Record<string, number> = {
    "rateLimit.proofVerificationWindowMs": 1_000,
    "rateLimit.proofVerificationUnknownLimit": 2,
    "rateLimit.proofVerificationRepeatedLimit": 2,
    "rateLimit.proofVerificationDistinctClientLimit": 2,
    ...overrides,
  };
  return {
    get: jest.fn((key: string, fallback: number) => values[key] ?? fallback),
  } as unknown as ConfigService;
}

describe("ProofVerificationAbuseService", () => {
  afterEach(() => jest.restoreAllMocks());

  it("bounds unknown identifier probes with a uniform error", () => {
    const service = new ProofVerificationAbuseService(makeConfig());
    const context = { ip: "203.0.113.10" };

    service.checkClientCardinality(context, "unknown-1");
    service.checkVerification(context, "unknown-1", false);
    service.checkClientCardinality(context, "unknown-2");
    service.checkVerification(context, "unknown-2", false);

    service.checkClientCardinality(context, "unknown-1");
    service.checkVerification(context, "unknown-1", false);
    expect(() => service.checkVerification(context, "unknown-1", false)).toThrow(
      HttpException,
    );
    expect(() => service.checkVerification(context, "unknown-1", false)).toThrow(
      expect.objectContaining({ status: HttpStatus.TOO_MANY_REQUESTS }),
    );
    expect(() => service.checkVerification(context, "unknown-1", false)).toThrow(
      "Verification temporarily unavailable",
    );
  });

  it("limits high-cardinality clients while allowing separate clients", () => {
    const service = new ProofVerificationAbuseService(makeConfig());
    const first = { ip: "203.0.113.10" };
    const second = { ip: "203.0.113.11" };

    service.checkClientCardinality(first, "proof-1");
    service.checkClientCardinality(first, "proof-2");
    expect(() => service.checkClientCardinality(first, "proof-3")).toThrow(
      "Verification temporarily unavailable",
    );
    expect(() => service.checkClientCardinality(second, "proof-3")).not.toThrow();
  });

  it("separates repeated-proof limits from unknown-probe limits", () => {
    const service = new ProofVerificationAbuseService(makeConfig());
    const context = { ip: "203.0.113.12" };

    service.checkVerification(context, "known", true);
    service.checkVerification(context, "known", true);
    expect(() => service.checkVerification(context, "known", true)).toThrow(
      "Verification temporarily unavailable",
    );
    expect(() => service.checkVerification(context, "known", false)).not.toThrow();
  });

  it("expires counters without retaining raw privacy-sensitive values", () => {
    let now = 1_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const service = new ProofVerificationAbuseService(makeConfig());
    const context = { ip: "198.51.100.25" };

    service.checkClientCardinality(context, "secret-proof-id");
    service.checkVerification(context, "secret-proof-id", false);
    now += 1_001;
    service.pruneExpired();
    expect(() => service.checkClientCardinality(context, "new-proof")).not.toThrow();

    const internal = service as unknown as { repeated: Map<string, unknown> };
    for (const key of internal.repeated.keys()) {
      expect(key).not.toContain("secret-proof-id");
      expect(key).not.toContain("198.51.100.25");
    }
  });
});
