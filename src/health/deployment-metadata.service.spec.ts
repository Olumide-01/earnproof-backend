import { ConfigService } from "@nestjs/config";
import * as manifestModule from "../config/deployment-manifest";
import { verifyDeploymentMetadata } from "../config/deployment-manifest";
import { DeploymentMetadataService } from "./deployment-metadata.service";

const TESTNET = "Test SDF Network ; September 2015";
const PROOF_REGISTRY = `C${"A".repeat(55)}`;

function deploymentManifestJson(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    deploymentVersion: "2026.09.1",
    network: "testnet",
    networkPassphrase: TESTNET,
    contracts: {
      proof_registry: {
        address: PROOF_REGISTRY,
        network: "testnet",
        wasmHash: "a".repeat(64),
      },
    },
    ...overrides,
  });
}

function mutableConfig(values: Record<string, unknown>) {
  const store = { ...values };
  const config = {
    get: jest.fn((key: string) => store[key]),
  } as unknown as ConfigService;
  return { config, store };
}

function baseValues(manifest: string | undefined = deploymentManifestJson()) {
  return {
    "deployment.manifest": manifest,
    "stellar.network": "testnet",
    "stellar.networkPassphrase": TESTNET,
    "contractAnchoring.proofRegistryContractId": PROOF_REGISTRY,
    "issuerRegistry.contractId": undefined,
    sessionSecret: "session-secret-value",
    credentialSigningSecret: "credential-signing-secret",
  };
}

describe("DeploymentMetadataService", () => {
  afterEach(() => jest.restoreAllMocks());

  it("serves a verifiable envelope from a valid manifest", () => {
    const { config } = mutableConfig(baseValues());
    const state = new DeploymentMetadataService(config).state();

    expect(state.status).toBe("valid");
    if (state.status !== "valid") return;
    expect(verifyDeploymentMetadata(state.envelope)).toBe(true);
    expect(state.envelope.document.contracts).toEqual([
      {
        name: "proof_registry",
        address: PROOF_REGISTRY,
        wasmHash: "a".repeat(64),
      },
    ]);
  });

  it("reports absent when no manifest is configured", () => {
    const { config } = mutableConfig({
      ...baseValues(),
      "deployment.manifest": undefined,
    });
    const service = new DeploymentMetadataService(config);

    expect(service.state()).toEqual({ status: "absent" });
    expect(service.isConfigured()).toBe(false);
  });

  it("never includes configured secrets in the envelope", () => {
    const { config } = mutableConfig(baseValues());
    const serialized = JSON.stringify(
      new DeploymentMetadataService(config).state(),
    );

    expect(serialized).not.toContain("session-secret-value");
    expect(serialized).not.toContain("credential-signing-secret");
  });

  describe("cache", () => {
    it("derives once and reuses the same envelope while inputs are unchanged", () => {
      const load = jest.spyOn(manifestModule, "loadDeploymentManifest");
      const { config } = mutableConfig(baseValues());
      const service = new DeploymentMetadataService(config);

      const first = service.state();
      const second = service.state();

      expect(second).toBe(first);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("re-derives when the manifest changes, producing a new digest", () => {
      const { config, store } = mutableConfig(baseValues());
      const service = new DeploymentMetadataService(config);
      const before = service.state();

      store["deployment.manifest"] = deploymentManifestJson({
        deploymentVersion: "2026.09.2",
      });
      const after = service.state();

      expect(before.status).toBe("valid");
      expect(after.status).toBe("valid");
      if (before.status !== "valid" || after.status !== "valid") return;
      expect(after.envelope.integrity.digest).not.toBe(
        before.envelope.integrity.digest,
      );
      expect(after.envelope.document.deploymentVersion).toBe("2026.09.2");
    });

    it("stops serving a cached document once runtime config drifts from it", () => {
      const { config, store } = mutableConfig(baseValues());
      const service = new DeploymentMetadataService(config);
      expect(service.state().status).toBe("valid");

      store["contractAnchoring.proofRegistryContractId"] = `C${"D".repeat(55)}`;

      expect(service.state()).toEqual({
        status: "invalid",
        reasons: ["manifest_contract_drift:proof_registry"],
      });
    });

    it("recovers when drift is corrected", () => {
      const { config, store } = mutableConfig(baseValues());
      const service = new DeploymentMetadataService(config);

      store["stellar.networkPassphrase"] = "Other ; 2026";
      expect(service.state().status).toBe("invalid");

      store["stellar.networkPassphrase"] = TESTNET;
      expect(service.state().status).toBe("valid");
    });
  });
});
