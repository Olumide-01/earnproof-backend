import {
  CredentialSigningKeyringService,
  keyId,
  versionFromKeyId,
} from "./credential-signing-keyring.service";

function makeConfig(values: Record<string, unknown>) {
  return {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      if (!(key in values)) throw new Error(`missing config ${key}`);
      return values[key];
    }),
  } as never;
}

describe("keyId / versionFromKeyId", () => {
  it("round-trips a version through a key id", () => {
    expect(keyId(0)).toBe("earnproof-v0");
    expect(keyId(7)).toBe("earnproof-v7");
    expect(versionFromKeyId("earnproof-v0")).toBe(0);
    expect(versionFromKeyId("earnproof-v7")).toBe(7);
  });

  it("returns null for a malformed or unknown key id", () => {
    expect(versionFromKeyId("not-a-key-id")).toBeNull();
    expect(versionFromKeyId("earnproof-vX")).toBeNull();
    expect(versionFromKeyId("")).toBeNull();
  });
});

describe("CredentialSigningKeyringService", () => {
  it("treats the legacy unversioned secret as an implicit version 0", () => {
    const keyring = new CredentialSigningKeyringService(
      makeConfig({ credentialSigningSecret: "legacy-secret" }),
    );

    expect(keyring.loadedVersions).toEqual([0]);
    expect(keyring.activeWriteVersion).toBe(0);
    expect(keyring.activeKeyId).toBe("earnproof-v0");
    expect(keyring.activeSecret).toBe("legacy-secret");
  });

  it("prefers an explicit version 0 over the legacy secret when both are set", () => {
    const keyring = new CredentialSigningKeyringService(
      makeConfig({
        credentialSigningSecret: "legacy-secret",
        "credentialSigningKeyVersions.0": "explicit-v0-secret",
      }),
    );

    expect(keyring.activeSecret).toBe("explicit-v0-secret");
  });

  it("loads sequential versions until the first gap", () => {
    const keyring = new CredentialSigningKeyringService(
      makeConfig({
        "credentialSigningKeyVersions.0": "secret-0",
        "credentialSigningKeyVersions.1": "secret-1",
        "credentialSigningKeyVersions.2": "secret-2",
        // gap at 3 — version 4 must not be loaded even if a test set it
        "credentialSigningKeyVersions.4": "secret-4",
      }),
    );

    expect(keyring.loadedVersions).toEqual([0, 1, 2]);
  });

  it("signs with the configured active version, not always version 0", () => {
    const keyring = new CredentialSigningKeyringService(
      makeConfig({
        "credentialSigningKeyVersions.0": "old-secret",
        "credentialSigningKeyVersions.1": "new-secret",
        credentialSigningKeyVersion: 1,
      }),
    );

    expect(keyring.activeWriteVersion).toBe(1);
    expect(keyring.activeKeyId).toBe("earnproof-v1");
    expect(keyring.activeSecret).toBe("new-secret");
  });

  it("throws when asked to sign but the configured active version is not loaded", () => {
    const keyring = new CredentialSigningKeyringService(
      makeConfig({
        "credentialSigningKeyVersions.0": "old-secret",
        credentialSigningKeyVersion: 5,
      }),
    );

    expect(() => keyring.activeSecret).toThrow(/version 5 is not configured/);
  });

  describe("isUsableForVerification — old, new, unknown, and expired keys", () => {
    it("the active (new) key is always usable, with or without a deadline", () => {
      const keyring = new CredentialSigningKeyringService(
        makeConfig({
          "credentialSigningKeyVersions.0": "old-secret",
          "credentialSigningKeyVersions.1": "new-secret",
          credentialSigningKeyVersion: 1,
        }),
      );

      expect(keyring.isUsableForVerification(1)).toBe(true);
    });

    it("a verify-only (old) key with no deadline is usable indefinitely", () => {
      const keyring = new CredentialSigningKeyringService(
        makeConfig({
          "credentialSigningKeyVersions.0": "old-secret",
          "credentialSigningKeyVersions.1": "new-secret",
          credentialSigningKeyVersion: 1,
        }),
      );

      expect(keyring.isUsableForVerification(0)).toBe(true);
    });

    it("a verify-only key within its overlap window is usable", () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const keyring = new CredentialSigningKeyringService(
        makeConfig({
          "credentialSigningKeyVersions.0": "old-secret",
          "credentialSigningKeyVersions.1": "new-secret",
          credentialSigningKeyVersion: 1,
          "credentialSigningKeyVerifyUntil.0": future,
        }),
      );

      expect(keyring.isUsableForVerification(0)).toBe(true);
    });

    it("a verify-only key past its overlap window is refused (expired key)", () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const keyring = new CredentialSigningKeyringService(
        makeConfig({
          "credentialSigningKeyVersions.0": "old-secret",
          "credentialSigningKeyVersions.1": "new-secret",
          credentialSigningKeyVersion: 1,
          "credentialSigningKeyVerifyUntil.0": past,
        }),
      );

      expect(keyring.isUsableForVerification(0)).toBe(false);
    });

    it("an unknown (never-loaded) version is never usable", () => {
      const keyring = new CredentialSigningKeyringService(
        makeConfig({ "credentialSigningKeyVersions.0": "only-secret" }),
      );

      expect(keyring.isUsableForVerification(99)).toBe(false);
    });

    it("a retired version (removed from config) is refused even though it once existed", () => {
      // Simulates retirement: version 0 is simply absent from the loaded config.
      const keyring = new CredentialSigningKeyringService(
        makeConfig({
          "credentialSigningKeyVersions.1": "new-secret",
          credentialSigningKeyVersion: 1,
        }),
      );

      expect(keyring.isUsableForVerification(0)).toBe(false);
      expect(keyring.loadedVersions).toEqual([1]);
    });

    it("ignores a malformed VERIFY_UNTIL value and treats the key as non-expiring", () => {
      const keyring = new CredentialSigningKeyringService(
        makeConfig({
          "credentialSigningKeyVersions.0": "old-secret",
          "credentialSigningKeyVersions.1": "new-secret",
          credentialSigningKeyVersion: 1,
          "credentialSigningKeyVerifyUntil.0": "not-a-date",
        }),
      );

      expect(keyring.isUsableForVerification(0)).toBe(true);
    });
  });

  it("secretFor returns the secret for a loaded version and undefined otherwise", () => {
    const keyring = new CredentialSigningKeyringService(
      makeConfig({
        "credentialSigningKeyVersions.0": "old-secret",
        "credentialSigningKeyVersions.1": "new-secret",
        credentialSigningKeyVersion: 1,
      }),
    );

    expect(keyring.secretFor(0)).toBe("old-secret");
    expect(keyring.secretFor(1)).toBe("new-secret");
    expect(keyring.secretFor(2)).toBeUndefined();
  });
});
