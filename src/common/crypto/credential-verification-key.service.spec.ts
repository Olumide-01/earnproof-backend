import { ConfigService } from "@nestjs/config";
import { CredentialVerificationKeyService } from "./credential-verification-key.service";

function config(values: Record<string, unknown>) {
  return {
    getOrThrow: (key: string) => values[key],
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

const credential = {
  id: "credential_1",
  type: "EarnProofMinimumIncomeCredential",
  schemaVersion: "earnproof.minimum-income.v1",
  issuer: "earnproof-backend",
};

describe("CredentialVerificationKeyService", () => {
  it("publishes deterministic public JWK metadata without private material", () => {
    const service = new CredentialVerificationKeyService(
      config({ credentialSigningSecret: "current-secret" }),
    );
    const first = service.getPublicKeySet();
    const second = service.getPublicKeySet();

    expect(first).toEqual(second);
    expect(first.keys).toHaveLength(1);
    expect(first.keys[0]).toMatchObject({
      alg: "EdDSA",
      crv: "Ed25519",
      kid: "credential-key-0",
      kty: "OKP",
      status: "active",
      use: "sig",
    });
    expect(JSON.stringify(first)).not.toContain("private");
    expect(JSON.stringify(first)).not.toContain("current-secret");
    expect(service.getEtag()).toMatch(/^"[a-f0-9]{64}"$/);
  });

  it("keeps the previous key during the configured overlap window", () => {
    const service = new CredentialVerificationKeyService(
      config({
        credentialSigningSecret: "current-secret",
        credentialSigningSecretPrevious: "previous-secret",
        credentialSigningKeyId: "key-current",
        credentialSigningPreviousKeyId: "key-previous",
        credentialSigningKeyOverlapDays: 30,
      }),
    );
    const keys = service.getPublicKeySet().keys;

    expect(keys.map((key) => key.kid)).toEqual(["key-current", "key-previous"]);
    expect(keys[1]).toMatchObject({ status: "retired" });
    expect(keys[1].expiresAt).toEqual(expect.any(String));
    expect(service.hasKey("key-previous")).toBe(true);
    expect(service.hasKey("unknown-key")).toBe(false);
  });

  it("signs and verifies credentials with the active key", () => {
    const service = new CredentialVerificationKeyService(
      config({ credentialSigningSecret: "current-secret" }),
    );
    const proof = service.signCredential(credential);

    expect(proof).toMatchObject({
      algorithm: "EdDSA",
      keyId: "credential-key-0",
      type: "Ed25519",
    });
    expect(service.verifyCredential(credential, proof)).toBe(true);
    expect(
      service.verifyCredential(
        { ...credential, id: "tampered" },
        proof,
      ),
    ).toBe(false);
  });
});
