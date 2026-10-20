import {
  ForbiddenLogFieldError,
  formatContext,
  redact,
  redactError,
} from "./redaction";

/** Realistic fixtures. Synthetic values, but the right shape. */
const PUBLIC_KEY = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
const SECRET_SEED = "SCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
const CONTRACT_ID = "CC3OREX5QBIKJ5JOW36JFJJW7TLAKJOVT5WJXEITGALO7MU32KHICS2A";
const SHA256 = "dd0a2d58bc634f09f94f92b09811714a25f36f4e0bd34c10dbac33238c84d594";

describe("redact", () => {
  describe("Stellar material", () => {
    it("removes a secret seed", () => {
      const out = redact(`signing failed with ${SECRET_SEED}`);
      expect(out).not.toContain(SECRET_SEED);
      expect(out).toContain("[REDACTED_SECRET]");
    });

    it("classifies a secret seed as a secret, not as an address", () => {
      // Seeds and public keys differ only in their first character. If the
      // address rule ran first, a leaked seed would be masked under a label
      // that understates the severity.
      expect(redact(SECRET_SEED)).toBe("[REDACTED_SECRET]");
    });

    it("removes a public key", () => {
      const out = redact(`no trustline for ${PUBLIC_KEY}`);
      expect(out).not.toContain(PUBLIC_KEY);
      expect(out).toContain("[REDACTED_ADDRESS]");
    });

    it("removes a contract id", () => {
      expect(redact(`invoke failed on ${CONTRACT_ID}`)).toContain(
        "[REDACTED_CONTRACT]",
      );
    });

    it("removes several distinct addresses from one message", () => {
      const other = PUBLIC_KEY.replace(/OJR$/, "AAA");
      const out = redact(`payment ${PUBLIC_KEY} -> ${other}`);
      expect(out).not.toContain(PUBLIC_KEY);
      expect(out).not.toContain(other);
    });
  });

  describe("identifiers and payloads", () => {
    it("removes a hex digest", () => {
      const out = redact(`credential ${SHA256} not found`);
      expect(out).not.toContain(SHA256);
      expect(out).toContain("[REDACTED_HASH]");
    });

    it("removes a JWT", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
      const out = redact(`rejected token ${jwt}`);
      expect(out).not.toContain(jwt);
      expect(out).toContain("[REDACTED_TOKEN]");
    });

    it("removes a long base64 payload", () => {
      const payload = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVm";
      expect(redact(`envelope ${payload}`)).not.toContain(payload);
    });

    it("removes a URL, which carries both endpoint and query parameters", () => {
      const url = "https://hooks.example.com/t/abc?token=secret123";
      const out = redact(`delivery to ${url} failed`);
      expect(out).not.toContain(url);
      expect(out).not.toContain("secret123");
      expect(out).toContain("[REDACTED_URL]");
    });

    it("removes a database connection string", () => {
      const dsn = "postgresql://app:hunter2@db.internal:5432/earnproof";
      const out = redact(`connection refused: ${dsn}`);
      expect(out).not.toContain("hunter2");
      expect(out).not.toContain(dsn);
    });

    it("removes environment variable leakage from CLI stderr", () => {
      const out = redact("failed: STELLAR_SECRET_KEY=SABCDEF not set correctly");
      expect(out).not.toContain("SABCDEF");
      expect(out).toContain("[REDACTED_ENV]");
    });
  });

  describe("financial values", () => {
    it("removes an amount with an asset code", () => {
      const out = redact("insufficient balance 1250.75 USDC");
      expect(out).not.toContain("1250.75");
      expect(out).toContain("[REDACTED_AMOUNT]");
    });

    it("removes a thousands-separated amount", () => {
      expect(redact("transfer of 1,250,000.00 XLM rejected")).not.toContain(
        "1,250,000.00",
      );
    });

    it("preserves a count so the log line stays diagnosable", () => {
      // Over-redaction has a cost too: "attempt [REDACTED] of [REDACTED]" tells
      // an operator nothing during an incident.
      const out = redact("attempt 3 of 10 failed");
      expect(out).toContain("3");
      expect(out).toContain("10");
    });

    it("preserves a duration", () => {
      expect(redact("completed in 250 ms")).toContain("250");
    });

    it("preserves a record count", () => {
      expect(redact("deleted 412 records")).toContain("412");
    });
  });

  describe("output constraints", () => {
    it("truncates a pathological message and marks the truncation", () => {
      // Spaced words rather than one long run: an unbroken alphanumeric string
      // is caught by the base64 rule first and never reaches the length check.
      const out = redact("overflow ".repeat(1_000));
      expect(out.length).toBeLessThan(600);
      expect(out).toContain("[truncated]");
    });

    it("collapses whitespace", () => {
      expect(redact("a\n\n  b\tc")).toBe("a b c");
    });

    it("returns an empty string unchanged", () => {
      expect(redact("")).toBe("");
    });

    it("leaves an already-safe message intact", () => {
      const safe = "anchoring worker claimed a batch";
      expect(redact(safe)).toBe(safe);
    });
  });

  it("redacts a realistic composite error", () => {
    const message =
      `tx submission failed for ${PUBLIC_KEY} on ${CONTRACT_ID}: ` +
      `op_underfunded, balance 4.5 XLM, envelope ${SHA256}, ` +
      `see https://horizon-testnet.stellar.org/transactions/${SHA256}`;

    const out = redact(message);

    expect(out).not.toContain(PUBLIC_KEY);
    expect(out).not.toContain(CONTRACT_ID);
    expect(out).not.toContain(SHA256);
    expect(out).not.toContain("4.5 XLM");
    expect(out).not.toContain("horizon-testnet.stellar.org");
    // The operationally useful part — the failure code — survives.
    expect(out).toContain("op_underfunded");
  });
});

describe("redactError", () => {
  it("keeps the exception class name and redacts the message", () => {
    const out = redactError(new TypeError(`bad address ${PUBLIC_KEY}`));
    expect(out).toContain("TypeError");
    expect(out).not.toContain(PUBLIC_KEY);
  });

  it("never returns a stack trace", () => {
    const error = new Error("boom");
    const out = redactError(error);
    expect(out).not.toContain("at ");
    expect(out).not.toContain(".ts:");
    expect(out).not.toContain(__filename);
  });

  it("redacts a bare string", () => {
    expect(redactError(`failed for ${PUBLIC_KEY}`)).not.toContain(PUBLIC_KEY);
  });

  it("does not serialise an arbitrary object", () => {
    // JSON.stringify on a thrown object is how a whole request body ends up in
    // a log line.
    const out = redactError({ walletAddress: PUBLIC_KEY, amount: 1250 });
    expect(out).not.toContain(PUBLIC_KEY);
    expect(out).not.toContain("1250");
    expect(out).toContain("[unserialised error]");
  });

  it("handles null and undefined", () => {
    expect(redactError(null)).toContain("UnknownError");
    expect(redactError(undefined)).toContain("UnknownError");
  });
});

describe("formatContext", () => {
  it("renders correlation identifiers as log fields", () => {
    // A request ID is right as a log field and wrong as a metric label. This is
    // the boundary that keeps logs queryable without inflating series count.
    const out = formatContext({
      requestId: "8f14e45fceea167a5a36dedd4bea2543",
      workflow: "anchoring",
      outcome: "success",
      durationMs: 42,
    });

    expect(out).toContain("requestId=8f14e45fceea167a5a36dedd4bea2543");
    expect(out).toContain("workflow=anchoring");
    expect(out).toContain("durationMs=42");
  });

  it("returns an empty string when there is no context", () => {
    expect(formatContext(undefined)).toBe("");
    expect(formatContext({})).toBe("");
  });

  it("omits undefined fields", () => {
    expect(formatContext({ requestId: "abc", durationMs: undefined })).toBe(
      " [requestId=abc]",
    );
  });

  it("rejects a forbidden field rather than dropping it", () => {
    // Dropping would make the line look complete while omitting what the author
    // believed they were logging.
    expect(() =>
      formatContext({ walletAddress: PUBLIC_KEY } as never),
    ).toThrow(ForbiddenLogFieldError);
  });

  it.each([
    "walletAddress",
    "sourceAddress",
    "destinationAddress",
    "sourceAddressEncrypted",
    "destinationAddressEncrypted",
    "sourceAddressLookup",
    "proofId",
    "credentialHash",
    "amount",
    "memo",
    "signature",
    "token",
    "stack",
  ])("rejects the %s field", (field) => {
    expect(() => formatContext({ [field]: "value" } as never)).toThrow(
      ForbiddenLogFieldError,
    );
  });

  it("redacts a client-supplied correlation value", () => {
    // requestId arrives from a client-controlled header, so it is constrained
    // even though the field itself is permitted.
    const out = formatContext({ requestId: PUBLIC_KEY });
    expect(out).not.toContain(PUBLIC_KEY);
  });

  it("bounds the length of a correlation value", () => {
    const out = formatContext({ requestId: "a".repeat(1_000) });
    expect(out.length).toBeLessThan(200);
  });
});
