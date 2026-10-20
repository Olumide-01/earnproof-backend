import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  buildDeploymentMetadataDocument,
  DeploymentMetadataEnvelope,
  DeploymentRuntimeConfig,
  loadDeploymentManifest,
  sealDeploymentMetadata,
} from "../config/deployment-manifest";

export type DeploymentMetadataState =
  | { status: "absent" }
  | { status: "invalid"; reasons: string[] }
  | { status: "valid"; envelope: DeploymentMetadataEnvelope };

/**
 * Serves the validated deployment manifest as a sealed metadata document.
 *
 * The result is memoized against the exact configuration inputs it was derived
 * from. Configuration does not change under a running process today, but
 * keying on the inputs rather than caching once means a changed input can
 * never be answered with a document (and digest) derived from the old one.
 */
@Injectable()
export class DeploymentMetadataService {
  private cached?: { key: string; state: DeploymentMetadataState };

  constructor(private readonly config: ConfigService) {}

  /** True when an operator supplied a manifest, valid or not. */
  isConfigured(): boolean {
    return this.state().status !== "absent";
  }

  state(): DeploymentMetadataState {
    const raw = this.config.get<string>("deployment.manifest");
    const runtime = this.runtime();
    const key = JSON.stringify([raw ?? null, runtime]);

    if (this.cached?.key === key) {
      return this.cached.state;
    }

    const state = this.derive(raw, runtime);
    this.cached = { key, state };
    return state;
  }

  private derive(
    raw: string | undefined,
    runtime: DeploymentRuntimeConfig,
  ): DeploymentMetadataState {
    const result = loadDeploymentManifest(raw, runtime);

    if (result.status !== "valid") {
      return result;
    }

    return {
      status: "valid",
      envelope: sealDeploymentMetadata(
        buildDeploymentMetadataDocument(result.manifest),
      ),
    };
  }

  private runtime(): DeploymentRuntimeConfig {
    return {
      network: this.config.get<string>("stellar.network"),
      networkPassphrase: this.config.get<string>("stellar.networkPassphrase"),
      configuredContracts: {
        proof_registry: this.config.get<string>(
          "contractAnchoring.proofRegistryContractId",
        ),
        issuer_registry: this.config.get<string>("issuerRegistry.contractId"),
      },
    };
  }
}
