import {
  bodyDigest,
  buildCanonicalString,
  computeSignature,
  deriveSigningKey,
  SignatureFailureReason,
  verifySignature,
} from "./request-signing";
import { diagnoseSignature, SignatureDiagnosticInput } from "./request-signing-diagnostics";

/** Synthetic secret, only ever used in this spec. */
const SECRET = "test-secret-key-abcdefghij012345";
const NOW = 1_724_400_000;
const NONCE = "abc123def456ghi7";
const BODY = '{"thresholdAmount":"500.0000000"}';
const PATH = "/api/v1/proofs/minimum-income";

function signed(overrides: Partial<SignatureDiagnosticInput> = {}): SignatureDiagnosticInput {
  const timestamp = overrides.timestamp ?? String(NOW);
  const canonical = buildCanonicalString({
    method: "POST",
    path: PATH,
    timestamp: Number(timestamp),
    nonce: NONCE,
    bodySha256: bodyDigest(BODY),
  });
  return {
    method: "POST",
    path: PATH,
    body: BODY,
    timestamp,
    nonce: NONCE,
    signature: computeSignature(deriveSigningKey(SECRET), canonical),
    ...overrides,
  };
}

const diagnose = (input: SignatureDiagnosticInput, nowSeconds = NOW) =>
  diagnoseSignature({ rawSecret: SECRET, input, nowSeconds });

describe("request signing diagnostics", () => {
  it("reports a correctly signed request as matching", () => {
    expect(diagnose(signed())).toMatchObject({
      canonicalizationVersion: "v1",
      coveredComponents: ["method", "path", "timestamp", "nonce", "body-sha256"],
      headers: { signature: "PRESENT", timestamp: "PRESENT", nonce: "PRESENT" },
      timestampWindow: { status: "WITHIN", skewSeconds: 0, windowSeconds: 300 },
      signatureMatches: true,
      failureCategory: null,
      nonceClaimable: true,
    });
  });

  it("never includes the expected signature, derived key, canonical string or nonce", () => {
    const input = signed({ signature: `v1=${"0".repeat(64)}` });
    const expected = signed().signature!;
    const serialized = JSON.stringify(diagnose(input));

    expect(serialized).not.toContain(expected.slice(3));
    expect(serialized).not.toContain(deriveSigningKey(SECRET).toString("hex"));
    expect(serialized).not.toContain(NONCE);
    expect(serialized).not.toContain(PATH);
  });

  it("agrees with verifySignature on every failure category", () => {
    const cases: SignatureDiagnosticInput[] = [
      signed({ timestamp: "abc" }),
      signed({ timestamp: String(NOW - 301) }),
      signed({ nonce: "short" }),
      signed({ signature: "v2=nope" }),
      signed({ body: '{"thresholdAmount":"1"}' }),
      signed(),
    ];

    for (const input of cases) {
      const verified = verifySignature({
        rawSecret: SECRET,
        method: input.method,
        path: input.path,
        timestampHeader: input.timestamp!,
        nonceHeader: input.nonce!,
        signatureHeader: input.signature!,
        body: input.body,
        nowSeconds: NOW,
      });
      expect(diagnose(input).failureCategory).toBe(verified.ok ? null : verified.reason);
    }
  });

  it("reports missing headers first", () => {
    const report = diagnose(signed({ signature: undefined, nonce: "" }));
    expect(report.headers).toEqual({ signature: "MISSING", timestamp: "PRESENT", nonce: "MISSING" });
    expect(report.failureCategory).toBe(SignatureFailureReason.MISSING_HEADERS);
    expect(report.nonceStatus).toBe("MISSING");
    expect(report.nonceClaimable).toBe(false);
  });

  describe("timestamp window boundaries", () => {
    it.each([
      [-300, "WITHIN"],
      [300, "WITHIN"],
      [301, "TOO_OLD"],
      [-301, "TOO_NEW"],
    ])("skew %p seconds is %s", (skew, status) => {
      const report = diagnose(signed({ timestamp: String(NOW - skew) }));
      expect(report.timestampWindow).toEqual({ status, skewSeconds: skew, windowSeconds: 300 });
      expect(report.nonceClaimable).toBe(status === "WITHIN");
    });

    it("still tells the caller the HMAC was right when only the clock is off", () => {
      const report = diagnose(signed({ timestamp: String(NOW - 301) }));
      expect(report.failureCategory).toBe(SignatureFailureReason.STALE_TIMESTAMP);
      expect(report.signatureMatches).toBe(true);
    });

    it.each(["1.5", "+1724400000", "1e9", "-0x1"])("treats %p as malformed", (timestamp) => {
      expect(diagnose(signed({ timestamp })).timestampWindow.status).toBe("MALFORMED");
    });
  });

  it("does not compute the HMAC when the nonce or signature is malformed", () => {
    expect(diagnose(signed({ nonce: "bad nonce!!!!!!!!!" })).signatureMatches).toBeNull();
    expect(diagnose(signed({ signature: "v1=XYZ" })).signatureMatches).toBeNull();
  });

  it("accepts a body digest in place of the body", () => {
    expect(diagnose(signed({ body: undefined, bodySha256: bodyDigest(BODY) })).signatureMatches).toBe(true);
  });

  describe("covered component mismatches", () => {
    const canonical = (lines: string[]) => lines.join("\n");
    const good = [`POST`, PATH, String(NOW), NONCE, bodyDigest(BODY)];

    it("reports NOT_DECLARED when no canonical string is given", () => {
      expect(diagnose(signed())).toMatchObject({
        canonicalStructure: "NOT_DECLARED",
        components: expect.arrayContaining([{ component: "path", status: "NOT_DECLARED" }]),
      });
    });

    it("matches every component for a correct declaration", () => {
      const report = diagnose(signed({ declaredCanonical: canonical(good) }));
      expect(report.canonicalStructure).toBe("OK");
      expect(report.components.every((entry) => entry.status === "MATCH")).toBe(true);
    });

    it("pinpoints a lowercase method and a path with a query string", () => {
      const declared = canonical(["post", `${PATH}?x=1`, ...good.slice(2)]);
      expect(diagnose(signed({ declaredCanonical: declared })).components).toEqual([
        { component: "method", status: "MISMATCH" },
        { component: "path", status: "MISMATCH" },
        { component: "timestamp", status: "MATCH" },
        { component: "nonce", status: "MATCH" },
        { component: "body-sha256", status: "MATCH" },
      ]);
    });

    it("pinpoints a body digest computed over different bytes", () => {
      const declared = canonical([...good.slice(0, 4), bodyDigest(`${BODY}\n`)]);
      const report = diagnose(signed({ declaredCanonical: declared }));
      expect(report.components.find((entry) => entry.component === "body-sha256")?.status).toBe("MISMATCH");
    });

    it.each([
      [good.join("\r\n"), "CRLF_LINE_ENDINGS"],
      [`${good.join("\n")}\n`, "TRAILING_NEWLINE"],
      [good.slice(0, 4).join("\n"), "WRONG_LINE_COUNT"],
    ])("diagnoses structure %#", (declaredCanonical, structure) => {
      expect(diagnose(signed({ declaredCanonical })).canonicalStructure).toBe(structure);
    });

    it("does not report every line as mismatched for CRLF endings alone", () => {
      const report = diagnose(signed({ declaredCanonical: good.join("\r\n") }));
      expect(report.components.every((entry) => entry.status === "MATCH")).toBe(true);
    });
  });

  it("is deterministic for identical input", () => {
    expect(diagnose(signed())).toEqual(diagnose(signed()));
  });
});
