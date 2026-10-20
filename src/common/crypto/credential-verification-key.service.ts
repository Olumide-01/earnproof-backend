import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from "crypto";
import { canonicalize } from "./canonicalize";
import { sha256 } from "./hash";

const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);
const DEFAULT_KEY_ID = "credential-key-0";
const DEFAULT_OVERLAP_DAYS = 30;

export interface CredentialVerificationKey {
  alg: "EdDSA";
  crv: "Ed25519";
  expiresAt?: string;
  kid: string;
  kty: "OKP";
  status: "active" | "retired";
  use: "sig";
  x: string;
}

export interface CredentialKeyProof {
  algorithm: "EdDSA";
  credentialHash: string;
  keyId: string;
  signature: string;
  type: "Ed25519";
}

interface SigningKey {
  id: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  metadata: CredentialVerificationKey;
}

@Injectable()
export class CredentialVerificationKeyService {
  private readonly signingKeys: readonly SigningKey[];

  constructor(config: ConfigService) {
    const currentId =
      config.get<string>("credentialSigningKeyId") ?? DEFAULT_KEY_ID;
    const currentSecret = config.getOrThrow<string>("credentialSigningSecret");
    const overlapDays =
      config.get<number>("credentialSigningKeyOverlapDays") ??
      DEFAULT_OVERLAP_DAYS;
    const previousSecret = config.get<string>(
      "credentialSigningSecretPrevious",
    );
    const previousId =
      config.get<string>("credentialSigningPreviousKeyId") ??
      `${currentId}-previous`;

    const current = this.createSigningKey(currentId, currentSecret, "active");
    const previous = previousSecret
      ? this.createSigningKey(previousId, previousSecret, "retired", {
          expiresAt: new Date(
            Date.now() + overlapDays * 24 * 60 * 60 * 1000,
          ).toISOString(),
        })
      : undefined;

    this.signingKeys = [current, ...(previous ? [previous] : [])];
  }

  getPublicKeySet(): { keys: CredentialVerificationKey[] } {
    return {
      keys: this.signingKeys
        .filter(({ metadata }) => !metadata.expiresAt || new Date(metadata.expiresAt).getTime() > Date.now())
        .map(({ metadata }) => metadata)
        .sort((left, right) => left.kid.localeCompare(right.kid)),
    };
  }

  getEtag(): string {
    return `"${createHash("sha256")
      .update(JSON.stringify(this.getPublicKeySet()))
      .digest("hex")}"`;
  }

  hasKey(keyId: string): boolean {
    return this.findAvailableKey(keyId) !== undefined;
  }

  signCredential(credential: Record<string, unknown>): CredentialKeyProof {
    const key = this.signingKeys[0];
    const canonicalPayload = canonicalize(credential);

    return {
      type: "Ed25519",
      algorithm: "EdDSA",
      keyId: key.id,
      credentialHash: `sha256:${sha256(canonicalPayload)}`,
      signature: `ed25519:${sign(null, Buffer.from(canonicalPayload), key.privateKey).toString("base64url")}`,
    };
  }

  verifyCredential(
    credential: Record<string, unknown>,
    proof: CredentialKeyProof,
  ): boolean {
    const key = this.findAvailableKey(proof.keyId);
    if (!key) return false;

    const canonicalPayload = canonicalize(credential);
    return verify(
      null,
      Buffer.from(canonicalPayload),
      key.publicKey,
      Buffer.from(proof.signature.slice("ed25519:".length), "base64url"),
    );
  }

  private createSigningKey(
    id: string,
    secret: string,
    status: CredentialVerificationKey["status"],
    lifecycle: Pick<CredentialVerificationKey, "expiresAt"> = {},
  ): SigningKey {
    const seed = createHash("sha256").update(secret, "utf8").digest();
    const privateKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = createPublicKey(privateKey);
    const jwk = publicKey.export({ format: "jwk" });

    return {
      id,
      privateKey,
      publicKey,
      metadata: {
        alg: "EdDSA",
        crv: "Ed25519",
        ...(lifecycle.expiresAt ? { expiresAt: lifecycle.expiresAt } : {}),
        kid: id,
        kty: "OKP",
        status,
        use: "sig",
        x: jwk.x as string,
      },
    };
  }

  private findAvailableKey(keyId: string): SigningKey | undefined {
    return this.signingKeys.find(
      ({ id, metadata }) =>
        id === keyId &&
        (!metadata.expiresAt || new Date(metadata.expiresAt).getTime() > Date.now()),
    );
  }
}
