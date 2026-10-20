import { CspViolationAbuseService } from "./csp-violation-abuse.service";

function makeConfig(overrides: Record<string, number> = {}) {
  return {
    get: jest.fn((key: string, fallback?: number) => {
      if (key === "rateLimit.cspReportWindowMs") return overrides.windowMs ?? fallback;
      if (key === "rateLimit.cspReportPerClientBucketLimit") return overrides.limit ?? fallback;
      return undefined;
    }),
  };
}

describe("CspViolationAbuseService", () => {
  it("accepts the first report for a client/bucket combination", () => {
    const service = new CspViolationAbuseService(makeConfig() as never);

    expect(service.shouldAccept({ ip: "1.2.3.4" }, "bucket-a")).toBe(true);
  });

  it("samples out a second report from the same client for the same bucket within the window (strict sampling)", () => {
    const service = new CspViolationAbuseService(makeConfig() as never);

    expect(service.shouldAccept({ ip: "1.2.3.4" }, "bucket-a")).toBe(true);
    expect(service.shouldAccept({ ip: "1.2.3.4" }, "bucket-a")).toBe(false);
  });

  it("treats different buckets from the same client independently", () => {
    const service = new CspViolationAbuseService(makeConfig() as never);

    expect(service.shouldAccept({ ip: "1.2.3.4" }, "bucket-a")).toBe(true);
    expect(service.shouldAccept({ ip: "1.2.3.4" }, "bucket-b")).toBe(true);
  });

  it("treats different clients for the same bucket independently", () => {
    const service = new CspViolationAbuseService(makeConfig() as never);

    expect(service.shouldAccept({ ip: "1.2.3.4" }, "bucket-a")).toBe(true);
    expect(service.shouldAccept({ ip: "5.6.7.8" }, "bucket-a")).toBe(true);
  });

  it("allows a client to contribute again for the same bucket after the window elapses", () => {
    jest.useFakeTimers();
    const service = new CspViolationAbuseService(
      makeConfig({ windowMs: 1_000 }) as never,
    );

    expect(service.shouldAccept({ ip: "1.2.3.4" }, "bucket-a")).toBe(true);
    expect(service.shouldAccept({ ip: "1.2.3.4" }, "bucket-a")).toBe(false);

    jest.advanceTimersByTime(1_001);

    expect(service.shouldAccept({ ip: "1.2.3.4" }, "bucket-a")).toBe(true);
    jest.useRealTimers();
  });

  it("respects a configured per-client-bucket limit greater than one", () => {
    const service = new CspViolationAbuseService(
      makeConfig({ limit: 3 }) as never,
    );

    expect(service.shouldAccept({ ip: "1.2.3.4" }, "bucket-a")).toBe(true);
    expect(service.shouldAccept({ ip: "1.2.3.4" }, "bucket-a")).toBe(true);
    expect(service.shouldAccept({ ip: "1.2.3.4" }, "bucket-a")).toBe(true);
    expect(service.shouldAccept({ ip: "1.2.3.4" }, "bucket-a")).toBe(false);
  });

  it("treats a missing client IP as its own stable bucket rather than throwing", () => {
    const service = new CspViolationAbuseService(makeConfig() as never);

    expect(service.shouldAccept(undefined, "bucket-a")).toBe(true);
    expect(service.shouldAccept(undefined, "bucket-a")).toBe(false);
  });

  it("never stores a raw IP address in its internal state", () => {
    const service = new CspViolationAbuseService(makeConfig() as never);
    service.shouldAccept({ ip: "203.0.113.42" }, "bucket-a");

    const internal = JSON.stringify(
      Object.fromEntries((service as unknown as { seen: Map<string, number[]> }).seen),
    );
    expect(internal).not.toContain("203.0.113.42");
  });

  it("pruneExpired removes entries whose window has fully elapsed", () => {
    const service = new CspViolationAbuseService(
      makeConfig({ windowMs: 1_000 }) as never,
    );
    service.shouldAccept({ ip: "1.2.3.4" }, "bucket-a");

    service.pruneExpired(Date.now() + 2_000);

    const internal = (service as unknown as { seen: Map<string, number[]> }).seen;
    expect(internal.size).toBe(0);
  });
});
