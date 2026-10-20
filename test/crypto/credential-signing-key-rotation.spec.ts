import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CredentialSigningKeyringService } from "../../src/common/crypto/credential-signing-keyring.service";

/**
 * Key-rotation rehearsal for CREDENTIAL_SIGNING_SECRET, mirroring
 * key-rotation.spec.ts's payment-encryption rehearsal (see
 * docs/key-rotation.md, which previously deferred this and sketched this
 * exact shape as the intended future implementation).
 *
 * Credential signing has one property payment encryption does not: a
 * verify-only key's overlap window can be time-bounded via an explicit
 * VERIFY_UNTIL deadline, since there is no ciphertext to keep decrypting
 * indefinitely — once a credential's issuer no longer wants an old key
 * trusted, they can set an expiry.
 *
 * All keys below are synthetic, test-only secrets — never real ones.
 */
describe("credential signing key rotation rehearsal", () => {
  const SECRET_V0 = "old-secret-v0-never-real";
  const SECRET_V1 = "new-secret-v1-never-real";

  function fakeConfigService(values: Record<string, unknown>): ConfigService {
    return {
      get: jest.fn((key: string) => {
        if (key in values) return values[key];
        const versionsMatch = /^credentialSigningKeyVersions\.(\d+)$/.exec(key);
        if (versionsMatch && values.credentialSigningKeyVersions) {
          const versions = values.credentialSigningKeyVersions as Record<
            number,
            string
          >;
          return versions[Number(versionsMatch[1])];
        }
        const deadlineMatch = /^credentialSigningKeyVerifyUntil\.(\d+)$/.exec(key);
        if (deadlineMatch && values.credentialSigningKeyVerifyUntil) {
          const deadlines = values.credentialSigningKeyVerifyUntil as Record<
            number,
            string
          >;
          return deadlines[Number(deadlineMatch[1])];
        }
        return undefined;
      }),
    } as unknown as ConfigService;
  }

  describe("stage 0: single unversioned key (pre-rotation baseline)", () => {
    it("signs and verifies using the legacy CREDENTIAL_SIGNING_SECRET as implicit version 0", () => {
      const config = fakeConfigService({
        credentialSigningSecret: SECRET_V0,
        credentialSigningKeyVersions: {},
      });
      const keyring = new CredentialSigningKeyringService(config);

      expect(keyring.activeWriteVersion).toBe(0);
      expect(keyring.activeKeyId).toBe("earnproof-v0");
      expect(keyring.loadedVersions).toEqual([0]);
      expect(keyring.activeSecret).toBe(SECRET_V0);
      expect(keyring.isUsableForVerification(0)).toBe(true);
    });
  });

  describe("stage 1: staged rotation — v1 introduced, v0 still active for signing", () => {
    it("keeps signing with v0 while v1 is loaded but not yet active", () => {
      const config = fakeConfigService({
        credentialSigningKeyVersions: { 0: SECRET_V0, 1: SECRET_V1 },
        credentialSigningKeyVersion: 0,
      });
      const keyring = new CredentialSigningKeyringService(config);

      expect(keyring.activeWriteVersion).toBe(0);
      expect(keyring.activeKeyId).toBe("earnproof-v0");
      expect(keyring.loadedVersions).toEqual([0, 1]);
      expect(keyring.isUsableForVerification(1)).toBe(true); // loaded, verify-only, no deadline yet
    });
  });

  describe("stage 2: write cutover — v1 active, v0 retained as verify-only", () => {
    it("new credentials sign with v1 while credentials issued under v0 still verify", () => {
      // A credential issued back when v0 was active carries keyId earnproof-v0.
      const preRotationConfig = fakeConfigService({
        credentialSigningSecret: SECRET_V0,
        credentialSigningKeyVersions: {},
      });
      const preRotationKeyring = new CredentialSigningKeyringService(preRotationConfig);
      expect(preRotationKeyring.activeKeyId).toBe("earnproof-v0");

      // Operator cuts writes over: CREDENTIAL_SIGNING_KEY_VERSION=1, both
      // V0 and V1 remain configured for verify-only dual-read.
      const rotatedConfig = fakeConfigService({
        credentialSigningKeyVersions: { 0: SECRET_V0, 1: SECRET_V1 },
        credentialSigningKeyVersion: 1,
      });
      const rotatedKeyring = new CredentialSigningKeyringService(rotatedConfig);

      expect(rotatedKeyring.activeWriteVersion).toBe(1);
      expect(rotatedKeyring.activeKeyId).toBe("earnproof-v1");
      expect(rotatedKeyring.activeSecret).toBe(SECRET_V1);

      // The old (v0) credential's key is still usable for verification.
      expect(rotatedKeyring.isUsableForVerification(0)).toBe(true);
      expect(rotatedKeyring.secretFor(0)).toBe(SECRET_V0);
      // The new (v1) key verifies too — the active version always does.
      expect(rotatedKeyring.isUsableForVerification(1)).toBe(true);
    });
  });

  describe("stage 2b: bounded overlap window", () => {
    it("a verify-only key remains usable until its VERIFY_UNTIL deadline, then is refused", () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const withinWindow = new CredentialSigningKeyringService(
        fakeConfigService({
          credentialSigningKeyVersions: { 0: SECRET_V0, 1: SECRET_V1 },
          credentialSigningKeyVersion: 1,
          credentialSigningKeyVerifyUntil: { 0: future },
        }),
      );
      expect(withinWindow.isUsableForVerification(0)).toBe(true);

      const past = new Date(Date.now() - 60_000).toISOString();
      const pastWindow = new CredentialSigningKeyringService(
        fakeConfigService({
          credentialSigningKeyVersions: { 0: SECRET_V0, 1: SECRET_V1 },
          credentialSigningKeyVersion: 1,
          credentialSigningKeyVerifyUntil: { 0: past },
        }),
      );
      expect(pastWindow.isUsableForVerification(0)).toBe(false);
      // The active version is never subject to a deadline.
      expect(pastWindow.isUsableForVerification(1)).toBe(true);
    });
  });

  describe("stage 3: restart with only the surviving key versions", () => {
    it("verifies v0-signed credentials from a fresh service instance built from fresh config after a simulated restart", () => {
      const beforeRestartConfig = fakeConfigService({
        credentialSigningKeyVersions: { 0: SECRET_V0, 1: SECRET_V1 },
        credentialSigningKeyVersion: 0,
      });
      const beforeRestart = new CredentialSigningKeyringService(beforeRestartConfig);
      expect(beforeRestart.activeKeyId).toBe("earnproof-v0");

      // Simulate a process restart: a brand new ConfigService instance and
      // a brand new keyring, with the active write version now cut over to
      // v1 but v0 still retained (verify-only, not yet retired).
      const afterRestartConfig = fakeConfigService({
        credentialSigningKeyVersions: { 0: SECRET_V0, 1: SECRET_V1 },
        credentialSigningKeyVersion: 1,
      });
      const afterRestart = new CredentialSigningKeyringService(afterRestartConfig);

      expect(afterRestart.activeWriteVersion).toBe(1);
      expect(afterRestart.isUsableForVerification(0)).toBe(true);
    });
  });

  describe("stage 4: v0 retired — old key becomes explicitly unusable", () => {
    it("refuses verification against a version once its env var is removed entirely", () => {
      const withV0 = new CredentialSigningKeyringService(
        fakeConfigService({
          credentialSigningKeyVersions: { 0: SECRET_V0, 1: SECRET_V1 },
          credentialSigningKeyVersion: 1,
        }),
      );
      expect(withV0.isUsableForVerification(0)).toBe(true);

      // Operator removes CREDENTIAL_SIGNING_SECRET_V0 entirely: v0 is retired.
      const retired = new CredentialSigningKeyringService(
        fakeConfigService({
          credentialSigningKeyVersions: { 1: SECRET_V1 },
          credentialSigningKeyVersion: 1,
        }),
      );

      expect(retired.loadedVersions).toEqual([1]);
      expect(retired.isUsableForVerification(0)).toBe(false);
      expect(retired.secretFor(0)).toBeUndefined();

      // New credentials under v1 are unaffected.
      expect(retired.activeKeyId).toBe("earnproof-v1");
      expect(retired.isUsableForVerification(1)).toBe(true);
    });

    it("signing with a retired/unconfigured active version fails with a descriptive error, not a silent wrong key", () => {
      const keyring = new CredentialSigningKeyringService(
        fakeConfigService({
          credentialSigningKeyVersions: { 1: SECRET_V1 },
          credentialSigningKeyVersion: 5, // misconfigured: version 5 never existed
        }),
      );

      expect(() => keyring.activeSecret).toThrow(/version 5 is not configured/);
    });
  });

  describe("logging never exposes key material", () => {
    it("error log lines about missing/misconfigured versions do not contain raw key bytes", () => {
      const logSpy = jest.spyOn(Logger.prototype, "error");

      const config = fakeConfigService({
        credentialSigningKeyVersions: { 0: SECRET_V0 },
        credentialSigningKeyVersion: 3,
      });
      void new CredentialSigningKeyringService(config);

      const loggedMessages = logSpy.mock.calls.map((call) => String(call[0]));
      for (const message of loggedMessages) {
        expect(message).not.toContain(SECRET_V0);
        expect(message).not.toContain(SECRET_V1);
      }

      logSpy.mockRestore();
    });
  });
});
