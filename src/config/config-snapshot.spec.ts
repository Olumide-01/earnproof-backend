import { createHmac } from "crypto";
import {
  buildSnapshot,
  CONFIG_SNAPSHOT_SCHEMA,
  contentHashOf,
  diffSnapshots,
  flattenConfig,
  isSecretPath,
  isSecretValue,
  resolveSigningKey,
  SnapshotSigningKey,
  verifySnapshot,
} from "./config-snapshot";
import { configuration } from "./configuration";

const KEY: SnapshotSigningKey = { keyId: "dedicated", secret: "k".repeat(32) };
const AT = new Date("2030-01-01T00:00:00.000Z");

// Synthetic, obviously fake material shaped like the real thing.
const FAKE_SEED = `S${"A".repeat(55)}`;
const FAKE_PUBLIC_KEY = `G${"XW5".repeat(18)}X`;
const FAKE_CONTRACT = `C${"QZ7".repeat(18)}Q`;

describe("secret detection", () => {
  it.each([
    "sessionSecret",
    "credentialSigningSecret",
    "credentialSigningKeyVersions.0",
    "paymentEncryptionKey",
    "databaseUrl",
    "redisUrl",
    "webhooks.signingToken",
    "issuer.private_key",
    "SESSION_SECRET",
  ])("treats %s as secret-bearing by name", (path) => {
    expect(isSecretPath(path)).toBe(true);
  });

  it.each(["stellar.networkPassphrase", "stellar.horizonUrl", "health.probeTimeoutMs", "apiUrl", "auth.maxAttempts"])(
    "keeps %s",
    (path) => {
      expect(isSecretPath(path)).toBe(false);
    },
  );

  it.each([
    ["a Stellar secret seed", FAKE_SEED],
    ["a seed embedded in text", `seed=${FAKE_SEED}`],
    ["a URL with credentials", "postgresql://app:hunter2@db.internal:5432/earnproof"],
    ["a PEM block", "-----BEGIN PRIVATE KEY-----\nMIIB"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl"],
    ["hex key material", "a".repeat(64)],
    ["mixed-case base64 key material", "q8Zr4LmP0wX2nV7bK9sT1yH6dF3gJ5aQ8Zr4LmP0w=="],
  ])("treats %s as secret by value", (_label, value) => {
    expect(isSecretValue(value)).toBe(true);
  });

  it.each([
    ["a public key", FAKE_PUBLIC_KEY],
    ["a contract id", FAKE_CONTRACT],
    ["a plain URL", "https://horizon-testnet.stellar.org"],
    ["the testnet passphrase", "Test SDF Network ; September 2015"],
    ["a number", 42],
    ["null", null],
  ])("keeps %s", (_label, value) => {
    expect(isSecretValue(value as never)).toBe(false);
  });
});

describe("flattenConfig", () => {
  it("flattens nested objects to sorted dot paths and keeps scalar arrays whole", () => {
    const { entries } = flattenConfig({
      b: { d: 2, c: [1, 2] },
      a: true,
      list: [{ name: "x" }, { name: "y" }],
      skipped: undefined,
      fn: () => 1,
    });
    expect(Object.keys(entries)).toEqual(["a", "b.c", "b.d", "list.0.name", "list.1.name"]);
    expect(entries["b.c"]).toEqual([1, 2]);
  });

  it("records excluded paths by name and reason, never by value", () => {
    const { entries, excluded } = flattenConfig({
      sessionSecret: "super-secret-value",
      harmless: FAKE_SEED,
      stellar: { horizonUrl: "https://horizon.example" },
    });
    expect(excluded).toEqual([
      { path: "harmless", reason: "secret_value" },
      { path: "sessionSecret", reason: "secret_name" },
    ]);
    expect(entries).toEqual({ "stellar.horizonUrl": "https://horizon.example" });
  });

  it("excludes a whole array when any element is secret-looking", () => {
    const { entries, excluded } = flattenConfig({ peers: ["https://a.example", "https://u:p@b.example"] });
    expect(entries).toEqual({});
    expect(excluded).toEqual([{ path: "peers", reason: "secret_value" }]);
  });

  it("normalises values without a canonical JSON form", () => {
    const { entries } = flattenConfig({ n: Number.NaN, at: AT });
    expect(entries).toEqual({ at: AT.toISOString(), n: "NaN" });
  });

  it("never leaks a secret from the real configuration (regression)", () => {
    const secrets: Record<string, string> = {
      DATABASE_URL: "postgresql://app:pw-db-0000@db.internal:5432/earnproof",
      REDIS_URL: "redis://:pw-redis-0000@cache.internal:6379",
      SESSION_SECRET: "session-secret-synthetic-0000",
      CREDENTIAL_SIGNING_SECRET: "credential-secret-synthetic-0000",
      CREDENTIAL_SIGNING_SECRET_V0: "credential-v0-synthetic-0000",
      CREDENTIAL_SIGNING_SECRET_PREVIOUS: "credential-prev-synthetic-0000",
      PAYMENT_ENCRYPTION_KEY: "b".repeat(64),
      PAYMENT_ENCRYPTION_KEY_V0: "c".repeat(64),
      CONFIG_SNAPSHOT_SIGNING_SECRET: "snapshot-secret-synthetic-0000-0000",
    };
    const saved = { ...process.env };
    Object.assign(process.env, secrets);
    try {
      const document = buildSnapshot(configuration(), "test", AT, KEY);
      const serialised = JSON.stringify(document);
      for (const value of Object.values(secrets)) {
        expect(serialised).not.toContain(value);
      }
      expect(serialised).not.toContain("pw-db-0000");
      expect(serialised).not.toContain("pw-redis-0000");
      // Non-secret settings are still captured.
      expect(document.entries["stellar.networkPassphrase"]).toBe("Test SDF Network ; September 2015");
      expect(document.excluded.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(["databaseUrl", "sessionSecret", "credentialSigningSecret", "paymentEncryptionKey"]),
      );
    } finally {
      process.env = saved;
    }
  });
});

describe("snapshot identity and signatures", () => {
  const config = { stellar: { network: "testnet" }, health: { probeTimeoutMs: 2000 } };

  it("hashes content independently of key order and capture time", () => {
    const a = buildSnapshot(config, "staging", AT, KEY);
    const b = buildSnapshot(
      { health: { probeTimeoutMs: 2000 }, stellar: { network: "testnet" } },
      "staging",
      new Date(AT.getTime() + 60_000),
      KEY,
    );
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("binds the hash to the environment", () => {
    expect(buildSnapshot(config, "staging", AT, KEY).contentHash).not.toBe(
      buildSnapshot(config, "production", AT, KEY).contentHash,
    );
  });

  it("verifies an untouched document", () => {
    expect(verifySnapshot(buildSnapshot(config, "staging", AT, KEY), KEY)).toEqual({ valid: true });
  });

  it("detects altered entries", () => {
    const document = buildSnapshot(config, "staging", AT, KEY);
    document.entries["health.probeTimeoutMs"] = 30_000;
    expect(verifySnapshot(document, KEY)).toEqual({ valid: false, reason: "content_hash_mismatch" });
  });

  it("detects a recomputed hash without a matching signature", () => {
    const document = buildSnapshot(config, "staging", AT, KEY);
    document.entries["health.probeTimeoutMs"] = 30_000;
    document.contentHash = contentHashOf(document);
    expect(verifySnapshot(document, KEY)).toEqual({ valid: false, reason: "signature_invalid" });
  });

  it("detects a changed capture time", () => {
    const document = buildSnapshot(config, "staging", AT, KEY);
    document.capturedAt = new Date(AT.getTime() + 1).toISOString();
    expect(verifySnapshot(document, KEY)).toEqual({ valid: false, reason: "signature_invalid" });
  });

  it("refuses a document signed with another key", () => {
    const document = buildSnapshot(config, "staging", AT, { keyId: "dedicated", secret: "x".repeat(32) });
    expect(verifySnapshot(document, KEY)).toEqual({ valid: false, reason: "signature_invalid" });
  });

  it("refuses a correctly signed document that carries a secret", () => {
    // A peer with the shared key could sign anything; exclusion is re-checked.
    const document = buildSnapshot(config, "staging", AT, KEY);
    document.entries["db.password"] = "x";
    document.contentHash = contentHashOf(document);
    const resigned = buildSnapshot({}, "staging", AT, KEY);
    Object.assign(resigned, { entries: document.entries, contentHash: document.contentHash });
    resigned.signature = buildSnapshotSignatureFor(resigned);
    expect(verifySnapshot(resigned, KEY)).toEqual({ valid: false, reason: "secret_present" });
  });

  it("refuses an unknown schema", () => {
    const document = { ...buildSnapshot(config, "staging", AT, KEY), schema: "other.v9" as typeof CONFIG_SNAPSHOT_SCHEMA };
    expect(verifySnapshot(document, KEY)).toEqual({ valid: false, reason: "schema_unsupported" });
  });
});

/** Signs an arbitrary document the way buildSnapshot does, for tamper tests. */
function buildSnapshotSignatureFor(document: ReturnType<typeof buildSnapshot>) {
  const payload = JSON.stringify({
    capturedAt: document.capturedAt,
    contentHash: document.contentHash,
    environment: document.environment,
    schema: document.schema,
  });
  return { alg: "HMAC-SHA256" as const, keyId: KEY.keyId, value: createHmac("sha256", KEY.secret).update(payload).digest("hex") };
}

describe("resolveSigningKey", () => {
  it("prefers a dedicated secret", () => {
    expect(resolveSigningKey({ dedicatedSecret: "d".repeat(32), credentialSigningSecret: "c" })).toEqual({
      keyId: "dedicated",
      secret: "d".repeat(32),
    });
  });

  it("derives a purpose-bound key rather than reusing the credential secret", () => {
    const key = resolveSigningKey({ credentialSigningSecret: "credential-secret" });
    expect(key?.keyId).toBe("derived-credential");
    expect(key?.secret).not.toBe("credential-secret");
    expect(key?.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns null without any secret", () => {
    expect(resolveSigningKey({})).toBeNull();
  });
});

describe("diffSnapshots", () => {
  const snapshot = (entries: Record<string, unknown>, excluded: string[] = []) => ({
    entries: entries as never,
    excluded: excluded.map((path) => ({ path, reason: "secret_name" as const })),
  });

  it("reports identical snapshots as identical", () => {
    const a = snapshot({ x: 1, list: [1, 2] });
    expect(diffSnapshots(a, snapshot({ list: [1, 2], x: 1 }))).toMatchObject({ identical: true });
  });

  it("reports added, removed and changed settings sorted by path", () => {
    const diff = diffSnapshots(
      snapshot({ keep: 1, gone: "a", change: 1, type: 1 }),
      snapshot({ keep: 1, change: 2, type: "1", fresh: true }),
    );
    expect(diff).toEqual({
      identical: false,
      added: [{ path: "fresh", value: true }],
      removed: [{ path: "gone", value: "a" }],
      changed: [
        { path: "change", before: 1, after: 2 },
        { path: "type", before: 1, after: "1" },
      ],
      excludedAdded: [],
      excludedRemoved: [],
    });
  });

  it("detects array changes as one setting change", () => {
    expect(diffSnapshots(snapshot({ s: [5, 25, 100] }), snapshot({ s: [10, 100] })).changed).toEqual([
      { path: "s", before: [5, 25, 100], after: [10, 100] },
    ]);
  });

  it("reports excluded paths that appear or disappear, without values", () => {
    const diff = diffSnapshots(snapshot({}, ["a", "b"]), snapshot({}, ["b", "c"]));
    expect(diff).toMatchObject({ identical: false, excludedAdded: ["c"], excludedRemoved: ["a"] });
  });
});
