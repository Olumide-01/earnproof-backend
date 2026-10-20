import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import {
  buildDeploymentMetadataDocument,
  DEPLOYMENT_MANIFEST_MAX_BYTES,
  DeploymentManifest,
  DeploymentRuntimeConfig,
  digestDeploymentMetadata,
  loadDeploymentManifest,
  sealDeploymentMetadata,
  verifyDeploymentMetadata,
} from "./deployment-manifest";
import { validateEnv } from "./env.validation";

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";
const PROOF_REGISTRY = `C${"A".repeat(55)}`;
const ISSUER_REGISTRY = `C${"B".repeat(55)}`;
const WASM_A = "a".repeat(64);
const WASM_B = "b".repeat(64);
const SECRET_SEED = `S${"C".repeat(55)}`;

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    deploymentVersion: "2026.09.1",
    network: "testnet",
    networkPassphrase: TESTNET,
    contracts: {
      proof_registry: {
        address: PROOF_REGISTRY,
        network: "testnet",
        wasmHash: WASM_A,
      },
      issuer_registry: {
        address: ISSUER_REGISTRY,
        network: "testnet",
        wasmHash: WASM_B,
      },
    },
    artifacts: { api_image: WASM_B },
    ...overrides,
  };
}

function runtime(
  overrides: Partial<DeploymentRuntimeConfig> = {},
): DeploymentRuntimeConfig {
  return {
    network: "testnet",
    networkPassphrase: TESTNET,
    configuredContracts: {
      proof_registry: PROOF_REGISTRY,
      issuer_registry: ISSUER_REGISTRY,
    },
    ...overrides,
  };
}

function load(value: unknown, rt: DeploymentRuntimeConfig = runtime()) {
  return loadDeploymentManifest(JSON.stringify(value), rt);
}

function valid(value: unknown = manifest()): DeploymentManifest {
  const result = load(value);
  if (result.status !== "valid") {
    throw new Error(`expected valid manifest, got ${JSON.stringify(result)}`);
  }
  return result.manifest;
}

function reasonsOf(value: unknown, rt?: DeploymentRuntimeConfig): string[] {
  const result = load(value, rt);
  if (result.status !== "invalid") {
    throw new Error(`expected invalid manifest, got ${result.status}`);
  }
  return result.reasons;
}

describe("deployment manifest", () => {
  describe("loading", () => {
    it("accepts a complete manifest consistent with runtime config", () => {
      expect(valid().deploymentVersion).toBe("2026.09.1");
    });

    it.each([undefined, "", "   "])("treats %p as absent", (raw) => {
      expect(loadDeploymentManifest(raw, runtime())).toEqual({
        status: "absent",
      });
    });

    it("rejects malformed JSON without echoing it", () => {
      const result = loadDeploymentManifest("{not json", runtime());
      expect(result).toEqual({
        status: "invalid",
        reasons: ["manifest_malformed_json"],
      });
    });

    it("rejects a manifest over the size bound", () => {
      const raw = JSON.stringify({
        ...manifest(),
        pad: "x".repeat(DEPLOYMENT_MANIFEST_MAX_BYTES),
      });
      expect(loadDeploymentManifest(raw, runtime())).toEqual({
        status: "invalid",
        reasons: ["manifest_too_large"],
      });
    });

    it.each([
      ["deploymentVersion"],
      ["network"],
      ["networkPassphrase"],
      ["contracts"],
      ["schemaVersion"],
    ])("rejects an incomplete manifest missing %s", (field) => {
      const incomplete: Record<string, unknown> = manifest();
      delete incomplete[field];
      expect(reasonsOf(incomplete)).toContain(
        `manifest_invalid_field:${field}`,
      );
    });

    it("rejects a manifest that declares no contracts", () => {
      expect(reasonsOf(manifest({ contracts: {} }))).toEqual([
        "manifest_invalid_field:contracts",
      ]);
    });

    it("rejects a contract missing its WASM hash", () => {
      const contracts = manifest().contracts as Record<string, object>;
      const broken = {
        ...contracts,
        proof_registry: { address: PROOF_REGISTRY, network: "testnet" },
      };
      expect(reasonsOf(manifest({ contracts: broken }))).toEqual([
        "manifest_invalid_field:contracts",
      ]);
    });

    it.each([
      ["a malformed contract address", { address: "GABC" }],
      ["an uppercase WASM hash", { wasmHash: "A".repeat(64) }],
      ["a short WASM hash", { wasmHash: "a".repeat(63) }],
      ["an unknown network", { network: "devnet" }],
    ])("rejects %s", (_label, patch) => {
      const contracts = manifest().contracts;
      const broken = {
        ...contracts,
        proof_registry: { ...contracts.proof_registry, ...patch },
      };
      expect(reasonsOf(manifest({ contracts: broken }))).toEqual([
        "manifest_invalid_field:contracts",
      ]);
    });

    it("rejects an unsupported schema version", () => {
      expect(reasonsOf(manifest({ schemaVersion: 2 }))).toEqual([
        "manifest_invalid_field:schemaVersion",
      ]);
    });

    it("rejects unknown fields without echoing their names", () => {
      const reasons = reasonsOf(manifest({ adminPassword: "hunter2" }));
      expect(reasons).toEqual(["manifest_unknown_field"]);
      expect(JSON.stringify(reasons)).not.toContain("adminPassword");
    });

    it("rejects unknown fields nested in a contract", () => {
      const contracts = manifest().contracts;
      const broken = {
        ...contracts,
        proof_registry: { ...contracts.proof_registry, deployerKey: "x" },
      };
      expect(reasonsOf(manifest({ contracts: broken }))).toEqual([
        "manifest_unknown_field:contracts",
      ]);
    });
  });

  describe("secrets", () => {
    it.each([
      ["a top-level field", { deploymentVersion: SECRET_SEED }],
      ["an artifact hash", { artifacts: { signer: SECRET_SEED } }],
      ["an unknown field", { deployer: { secret: SECRET_SEED } }],
    ])("refuses a Stellar secret seed in %s", (_label, patch) => {
      const reasons = reasonsOf(manifest(patch));
      expect(reasons).toEqual(["manifest_contains_secret_material"]);
      expect(JSON.stringify(reasons)).not.toContain(SECRET_SEED);
    });

    it("refuses a secret seed used as a key", () => {
      expect(
        reasonsOf(manifest({ artifacts: { [SECRET_SEED]: WASM_A } })),
      ).toEqual(["manifest_contains_secret_material"]);
    });
  });

  describe("network and address consistency", () => {
    it("rejects contracts from a different network than the manifest", () => {
      const contracts = manifest().contracts;
      const mixed = {
        ...contracts,
        issuer_registry: { ...contracts.issuer_registry, network: "mainnet" },
      };
      expect(reasonsOf(manifest({ contracts: mixed }))).toEqual([
        "manifest_contract_network_mismatch:issuer_registry",
      ]);
    });

    it("rejects a passphrase that does not belong to the declared network", () => {
      expect(
        reasonsOf(
          manifest({ networkPassphrase: MAINNET }),
          runtime({
            networkPassphrase: MAINNET,
          }),
        ),
      ).toEqual(["manifest_passphrase_network_mismatch"]);
    });

    it("rejects the same address declared for two contracts", () => {
      const contracts = manifest().contracts;
      const duplicated = {
        ...contracts,
        issuer_registry: {
          ...contracts.issuer_registry,
          address: PROOF_REGISTRY,
        },
      };
      expect(
        reasonsOf(
          manifest({ contracts: duplicated }),
          runtime({
            configuredContracts: { proof_registry: PROOF_REGISTRY },
          }),
        ),
      ).toEqual(["manifest_duplicate_contract_address:proof_registry"]);
    });
  });

  describe("configuration drift", () => {
    it("rejects a manifest for a different network than the service runs on", () => {
      const mainnetContracts = Object.fromEntries(
        Object.entries(manifest().contracts).map(([name, contract]) => [
          name,
          { ...contract, network: "mainnet" },
        ]),
      );
      expect(
        reasonsOf(
          manifest({
            network: "mainnet",
            networkPassphrase: MAINNET,
            contracts: mainnetContracts,
          }),
        ),
      ).toEqual(["manifest_network_drift", "manifest_passphrase_drift"]);
    });

    it("rejects a passphrase that differs from the configured passphrase", () => {
      expect(
        reasonsOf(manifest(), runtime({ networkPassphrase: "Custom ; 2026" })),
      ).toEqual(["manifest_passphrase_drift"]);
    });

    it("rejects a contract address that differs from the configured one", () => {
      expect(
        reasonsOf(
          manifest(),
          runtime({
            configuredContracts: {
              proof_registry: `C${"D".repeat(55)}`,
              issuer_registry: ISSUER_REGISTRY,
            },
          }),
        ),
      ).toEqual(["manifest_contract_drift:proof_registry"]);
    });

    it("rejects a manifest missing a contract the service is configured to call", () => {
      const { proof_registry } = manifest().contracts;
      expect(reasonsOf(manifest({ contracts: { proof_registry } }))).toEqual([
        "manifest_contract_missing:issuer_registry",
      ]);
    });

    it("accepts contracts the service has no environment override for", () => {
      expect(
        load(manifest(), runtime({ configuredContracts: {} })).status,
      ).toBe("valid");
    });
  });

  describe("canonical document", () => {
    it("is independent of manifest key and entry order", () => {
      const original = manifest();
      const reordered = {
        artifacts: original.artifacts,
        contracts: {
          issuer_registry: original.contracts.issuer_registry,
          proof_registry: original.contracts.proof_registry,
        },
        networkPassphrase: original.networkPassphrase,
        network: original.network,
        deploymentVersion: original.deploymentVersion,
        schemaVersion: original.schemaVersion,
      };

      const a = buildDeploymentMetadataDocument(valid(original));
      const b = buildDeploymentMetadataDocument(valid(reordered));

      expect(canonicalize(a)).toBe(canonicalize(b));
      expect(digestDeploymentMetadata(a)).toBe(digestDeploymentMetadata(b));
    });

    it("lists contracts and artifacts sorted by name", () => {
      const document = buildDeploymentMetadataDocument(valid());
      expect(document.contracts.map((c) => c.name)).toEqual([
        "issuer_registry",
        "proof_registry",
      ]);
      expect(document.artifacts).toEqual([
        { name: "api_image", sha256: WASM_B },
      ]);
    });

    it("publishes only allow-listed fields and a single network", () => {
      const document = buildDeploymentMetadataDocument(valid());
      expect(Object.keys(document).sort()).toEqual([
        "artifacts",
        "contracts",
        "deploymentVersion",
        "network",
        "schema",
        "schemaVersion",
      ]);
      expect(document.network).toEqual({
        name: "testnet",
        passphrase: TESTNET,
      });
      for (const contract of document.contracts) {
        expect(Object.keys(contract).sort()).toEqual([
          "address",
          "name",
          "wasmHash",
        ]);
      }
    });

    it("defaults to no artifacts when the manifest declares none", () => {
      const withoutArtifacts: Record<string, unknown> = manifest();
      delete withoutArtifacts.artifacts;
      expect(
        buildDeploymentMetadataDocument(valid(withoutArtifacts)).artifacts,
      ).toEqual([]);
    });
  });

  describe("integrity digest", () => {
    const envelope = () =>
      sealDeploymentMetadata(buildDeploymentMetadataDocument(valid()));

    it("is the SHA-256 of the canonical document", () => {
      const sealed = envelope();
      expect(sealed.integrity).toEqual({
        algorithm: "sha256",
        canonicalization: "json-sorted-keys",
        digest: sha256(canonicalize(sealed.document)),
      });
      expect(sealed.integrity.digest).toMatch(/^[a-f0-9]{64}$/);
    });

    it("verifies an untampered envelope, including after a JSON round trip", () => {
      const sealed = envelope();
      expect(verifyDeploymentMetadata(sealed)).toBe(true);
      expect(verifyDeploymentMetadata(JSON.parse(JSON.stringify(sealed)))).toBe(
        true,
      );
    });

    it("detects a tampered contract address", () => {
      const sealed = envelope();
      sealed.document.contracts[0].address = `C${"Z".repeat(55)}`;
      expect(verifyDeploymentMetadata(sealed)).toBe(false);
    });

    it("detects a tampered network passphrase", () => {
      const sealed = envelope();
      sealed.document.network.passphrase = MAINNET;
      expect(verifyDeploymentMetadata(sealed)).toBe(false);
    });

    it("rejects an unknown algorithm or canonicalization", () => {
      const sealed = envelope();
      expect(
        verifyDeploymentMetadata({
          ...sealed,
          integrity: { ...sealed.integrity, algorithm: "md5" as "sha256" },
        }),
      ).toBe(false);
      expect(
        verifyDeploymentMetadata({
          ...sealed,
          integrity: {
            ...sealed.integrity,
            canonicalization: "raw" as "json-sorted-keys",
          },
        }),
      ).toBe(false);
    });

    it("changes when the deployment version changes", () => {
      const a = envelope().integrity.digest;
      const b = sealDeploymentMetadata(
        buildDeploymentMetadataDocument(
          valid(manifest({ deploymentVersion: "2026.09.2" })),
        ),
      ).integrity.digest;
      expect(a).not.toBe(b);
    });
  });

  describe("environment validation", () => {
    const baseEnv = {
      DATABASE_URL: "postgresql://user:password@localhost:5432/earnproof",
      REDIS_URL: "redis://localhost:6379",
      SESSION_SECRET: "session_secret_123",
      CREDENTIAL_SIGNING_SECRET: "credential_secret_123",
      PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    };

    it("keeps DEPLOYMENT_MANIFEST optional", () => {
      expect(validateEnv(baseEnv).DEPLOYMENT_MANIFEST).toBeUndefined();
      expect(
        validateEnv({ ...baseEnv, DEPLOYMENT_MANIFEST: "" })
          .DEPLOYMENT_MANIFEST,
      ).toBeUndefined();
    });

    it("bounds DEPLOYMENT_MANIFEST without echoing its value", () => {
      const oversized = "s".repeat(DEPLOYMENT_MANIFEST_MAX_BYTES + 1);
      expect(() =>
        validateEnv({ ...baseEnv, DEPLOYMENT_MANIFEST: oversized }),
      ).toThrow(/DEPLOYMENT_MANIFEST must not exceed/);
      try {
        validateEnv({ ...baseEnv, DEPLOYMENT_MANIFEST: oversized });
      } catch (error) {
        expect((error as Error).message).not.toContain("sss");
      }
    });
  });
});
