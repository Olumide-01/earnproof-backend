import {
  IdentityCheck,
  classifyConnectError,
  classifyHandshake,
  probeTlsEndpoint,
  ProbeCertificate,
  TlsConnectTarget,
  TlsHandshake,
} from "./tls-probe";

const NOW = new Date("2026-10-17T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;
/** Synthetic fingerprint; not from any real certificate. */
const FINGERPRINT = Array.from({ length: 32 }, () => "AB").join(":");

function certificate(notBeforeOffsetDays: number, notAfterOffsetDays: number): ProbeCertificate {
  return {
    valid_from: new Date(NOW.getTime() + notBeforeOffsetDays * DAY_MS).toUTCString(),
    valid_to: new Date(NOW.getTime() + notAfterOffsetDays * DAY_MS).toUTCString(),
    fingerprint256: FINGERPRINT,
  };
}

function handshake(overrides: Partial<TlsHandshake> = {}): TlsHandshake {
  return { authorized: true, protocol: "TLSv1.3", certificate: certificate(-30, 60), ...overrides };
}

const identityOk: IdentityCheck = () => undefined;
const identityMismatch: IdentityCheck = () => new Error("mismatch");

/** Public, documentation-safe address outside every blocked range. */
const PUBLIC_ADDRESS = "93.184.216.34";

function deps(overrides: {
  addresses?: string[];
  resolveError?: Error;
  connect?: (target: TlsConnectTarget) => Promise<TlsHandshake>;
} = {}) {
  const resolve = jest.fn(async () => {
    if (overrides.resolveError) throw overrides.resolveError;
    return (overrides.addresses ?? [PUBLIC_ADDRESS]).map((address) => ({ address, family: 4 }));
  });
  const connect = jest.fn(overrides.connect ?? (async () => handshake()));
  return {
    resolve: resolve as never,
    connect,
    resolveMock: resolve,
    checkIdentity: identityOk,
    now: () => NOW,
  };
}

describe("TLS probe", () => {
  describe("destination guard", () => {
    it.each([
      "http://hooks.example.com/",
      "https://localhost/",
      "https://127.0.0.1/",
      "https://169.254.169.254/",
      "https://hooks.example.com:8443/",
      "https://user:pass@hooks.example.com/",
      "https://service.internal/",
    ])("blocks %s without resolving or connecting", async (url) => {
      const d = deps();

      await expect(probeTlsEndpoint(url, d)).resolves.toMatchObject({ outcome: "DESTINATION_BLOCKED" });
      expect(d.resolveMock).not.toHaveBeenCalled();
      expect(d.connect).not.toHaveBeenCalled();
    });

    it("blocks a hostname when any resolved address is internal", async () => {
      const d = deps({ addresses: [PUBLIC_ADDRESS, "10.0.0.5"] });

      await expect(probeTlsEndpoint("https://hooks.example.com/", d)).resolves.toMatchObject({
        outcome: "DESTINATION_BLOCKED",
      });
      expect(d.connect).not.toHaveBeenCalled();
    });

    it("connects to the checked address with the hostname as SNI (no re-resolution)", async () => {
      const d = deps();

      await probeTlsEndpoint("https://hooks.example.com/path?q=1", d);

      expect(d.connect).toHaveBeenCalledWith(
        expect.objectContaining({ address: PUBLIC_ADDRESS, port: 443, servername: "hooks.example.com" }),
      );
      expect(d.resolveMock).toHaveBeenCalledTimes(1);
    });

    it("probes a public IP literal without DNS and without SNI", async () => {
      const d = deps();

      await probeTlsEndpoint(`https://${PUBLIC_ADDRESS}/`, d);

      expect(d.resolveMock).not.toHaveBeenCalled();
      expect(d.connect).toHaveBeenCalledWith(
        expect.objectContaining({ address: PUBLIC_ADDRESS, servername: undefined }),
      );
    });

    it("reports resolution failure as UNREACHABLE without the resolver's message", async () => {
      const d = deps({ resolveError: Object.assign(new Error("getaddrinfo ENOTFOUND 10.1.2.3"), { code: "ENOTFOUND" }) });

      const result = await probeTlsEndpoint("https://hooks.example.com/", d);

      expect(result.outcome).toBe("UNREACHABLE");
      expect(JSON.stringify(result)).not.toMatch(/10\.1\.2\.3|getaddrinfo/);
    });

    it("reports an empty resolution as UNREACHABLE", async () => {
      await expect(
        probeTlsEndpoint("https://hooks.example.com/", deps({ addresses: [] })),
      ).resolves.toMatchObject({ outcome: "UNREACHABLE" });
    });
  });

  describe("result privacy", () => {
    it("returns only categories and public certificate facts", async () => {
      const result = await probeTlsEndpoint("https://hooks.example.com/", deps());

      expect(Object.keys(result).sort()).toEqual([
        "certificateFingerprint",
        "certificateNotAfter",
        "certificateNotBefore",
        "durationMs",
        "outcome",
        "protocol",
      ]);
      expect(JSON.stringify(result)).not.toContain(PUBLIC_ADDRESS);
      expect(result).toMatchObject({ outcome: "HEALTHY", protocol: "TLSv1.3", certificateFingerprint: FINGERPRINT });
    });

    it("drops a malformed fingerprint rather than storing arbitrary text", async () => {
      const d = deps({
        connect: async () => handshake({ certificate: { ...certificate(-1, 60), fingerprint256: "<script>" } }),
      });

      await expect(probeTlsEndpoint("https://hooks.example.com/", d)).resolves.toMatchObject({
        certificateFingerprint: null,
      });
    });

    it("maps connection failures to categories without their messages", async () => {
      const d = deps({
        connect: async () => {
          throw Object.assign(new Error("connect ECONNREFUSED 93.184.216.34:443"), { code: "ECONNREFUSED" });
        },
      });

      const result = await probeTlsEndpoint("https://hooks.example.com/", d);
      expect(result.outcome).toBe("UNREACHABLE");
      expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
    });
  });

  describe("classifyHandshake", () => {
    const classify = (value: TlsHandshake, identity = identityOk, warningDays = 14) =>
      classifyHandshake("hooks.example.com", value, NOW, warningDays, identity);

    it("reports a healthy endpoint", () => {
      expect(classify(handshake())).toBe("HEALTHY");
    });

    it("treats valid_to as inclusive: expired only strictly after it", () => {
      expect(classify(handshake({ certificate: certificate(-30, 0) }))).toBe("EXPIRING_SOON");
      expect(
        classify(
          handshake({
            certificate: { ...certificate(-30, 0), valid_to: new Date(NOW.getTime() - 1_000).toUTCString() },
          }),
        ),
      ).toBe("EXPIRED");
    });

    it("applies the expiry warning window inclusively", () => {
      expect(classify(handshake({ certificate: certificate(-30, 14) }))).toBe("EXPIRING_SOON");
      expect(classify(handshake({ certificate: certificate(-30, 15) }))).toBe("HEALTHY");
    });

    it("reports a certificate that is not yet valid", () => {
      expect(classify(handshake({ certificate: certificate(1, 60) }))).toBe("NOT_YET_VALID");
    });

    it("reports a hostname mismatch", () => {
      expect(classify(handshake(), identityMismatch)).toBe("HOSTNAME_MISMATCH");
    });

    it("reports an untrusted chain", () => {
      expect(classify(handshake({ authorized: false }))).toBe("UNTRUSTED");
    });

    it.each(["TLSv1", "TLSv1.1", "SSLv3", null])("reports %p as a weak protocol", (protocol) => {
      expect(classify(handshake({ protocol }))).toBe("WEAK_PROTOCOL");
    });

    it("reports a handshake without a usable certificate", () => {
      expect(classify(handshake({ certificate: null }))).toBe("HANDSHAKE_FAILED");
      expect(classify(handshake({ certificate: { fingerprint256: FINGERPRINT } }))).toBe("HANDSHAKE_FAILED");
    });

    it("reports the first problem in a fixed precedence order", () => {
      const everythingWrong = handshake({
        authorized: false,
        protocol: "TLSv1",
        certificate: certificate(-60, -1),
      });
      expect(classify(everythingWrong, identityMismatch)).toBe("EXPIRED");
      expect(
        classify({ ...everythingWrong, certificate: certificate(-60, 5) }, identityMismatch),
      ).toBe("HOSTNAME_MISMATCH");
      expect(classify({ ...everythingWrong, certificate: certificate(-60, 5) })).toBe("UNTRUSTED");
    });
  });

  describe("classifyConnectError", () => {
    it.each([
      ["ETIMEDOUT", "TIMEOUT"],
      ["ECONNREFUSED", "UNREACHABLE"],
      ["EHOSTUNREACH", "UNREACHABLE"],
      ["ECONNRESET", "UNREACHABLE"],
      ["ERR_SSL_UNSUPPORTED_PROTOCOL", "WEAK_PROTOCOL"],
      ["ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION", "WEAK_PROTOCOL"],
      ["ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", "HANDSHAKE_FAILED"],
      ["", "HANDSHAKE_FAILED"],
    ])("%s -> %s", (code, outcome) => {
      expect(classifyConnectError(Object.assign(new Error("x"), { code }))).toBe(outcome);
    });

    it("tolerates non-error rejections", () => {
      expect(classifyConnectError(undefined)).toBe("HANDSHAKE_FAILED");
    });
  });
});
