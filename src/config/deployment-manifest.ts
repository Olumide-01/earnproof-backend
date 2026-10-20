import { z } from "zod";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import { safeEqual } from "../common/crypto/timing-safe";
import {
  passphraseMatchesNetwork,
  STELLAR_CONTRACT_ADDRESS_PATTERN,
  STELLAR_NETWORK_NAMES,
  STELLAR_SECRET_SEED_PATTERN,
  type StellarNetworkName,
} from "../stellar/stellar-network";

/**
 * Deployment manifest: the operator-supplied source of truth for which
 * contracts this deployment talks to, on which network, built from which
 * artifacts.
 *
 * Supplied as JSON in `DEPLOYMENT_MANIFEST`. It is validated here, against its
 * own schema and against the runtime Stellar configuration, before any of it
 * is published. A manifest that fails validation is never partially served:
 * the public metadata endpoint answers 503 and readiness reports the manifest
 * as a failed required dependency (see `HealthService`).
 *
 * Validation failures are reported as stable reason codes only. Readiness is a
 * public endpoint, so a reason must never echo operator-supplied content.
 */

/** Upper bound on the raw manifest, matched by `env.validation.ts`. */
export const DEPLOYMENT_MANIFEST_MAX_BYTES = 16_384;

/** Version of the published metadata document, bumped on breaking changes. */
export const DEPLOYMENT_METADATA_SCHEMA_VERSION = 1;

export const DEPLOYMENT_METADATA_SCHEMA = "earnproof.deployment-metadata";

/**
 * How the published document is canonicalized before hashing: object keys
 * sorted recursively, then `JSON.stringify` — the same `canonicalize()` used
 * for credential signing, so clients need no second implementation.
 */
export const DEPLOYMENT_METADATA_CANONICALIZATION = "json-sorted-keys";

export const DEPLOYMENT_METADATA_DIGEST_ALGORITHM = "sha256";

/**
 * Contracts whose address is also configured through the environment. When
 * both are present they must agree; a manifest that names a different address
 * than the one the service actually calls is configuration drift, and serving
 * it would tell clients to trust a contract the service does not use.
 */
export const CONFIGURED_CONTRACT_NAMES = [
  "proof_registry",
  "issuer_registry",
] as const;

export type ConfiguredContractName = (typeof CONFIGURED_CONTRACT_NAMES)[number];

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  deploymentVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
  network: z.enum(STELLAR_NETWORK_NAMES),
  networkPassphrase: z.string().min(1).max(128),
  contracts: z
    .record(
      identifier,
      z.strictObject({
        address: z.string().regex(STELLAR_CONTRACT_ADDRESS_PATTERN),
        network: z.enum(STELLAR_NETWORK_NAMES),
        wasmHash: sha256Hex,
      }),
    )
    .refine((contracts) => Object.keys(contracts).length > 0),
  artifacts: z.record(identifier, sha256Hex).optional(),
});

export type DeploymentManifest = z.infer<typeof manifestSchema>;

const MANIFEST_FIELDS = new Set(Object.keys(manifestSchema.shape));

/** Runtime configuration the manifest is checked against. */
export interface DeploymentRuntimeConfig {
  network: string | undefined;
  networkPassphrase: string | undefined;
  configuredContracts: Partial<Record<ConfiguredContractName, string>>;
}

export type DeploymentManifestResult =
  | { status: "absent" }
  | { status: "invalid"; reasons: string[] }
  | { status: "valid"; manifest: DeploymentManifest };

/**
 * Parse and validate a raw manifest against its schema and the runtime
 * configuration. Pure: same inputs, same result.
 */
export function loadDeploymentManifest(
  raw: string | undefined,
  runtime: DeploymentRuntimeConfig,
): DeploymentManifestResult {
  if (raw === undefined || raw.trim() === "") {
    return { status: "absent" };
  }

  if (Buffer.byteLength(raw, "utf8") > DEPLOYMENT_MANIFEST_MAX_BYTES) {
    return { status: "invalid", reasons: ["manifest_too_large"] };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { status: "invalid", reasons: ["manifest_malformed_json"] };
  }

  // Checked before the schema so the reason is specific: a seed pasted into
  // any field is an incident in its own right, not a formatting mistake.
  if (containsSecretMaterial(json)) {
    return {
      status: "invalid",
      reasons: ["manifest_contains_secret_material"],
    };
  }

  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    return { status: "invalid", reasons: schemaReasons(parsed.error.issues) };
  }

  const reasons = consistencyReasons(parsed.data, runtime);
  if (reasons.length > 0) {
    return { status: "invalid", reasons };
  }

  return { status: "valid", manifest: parsed.data };
}

/**
 * Map schema issues onto stable codes naming only fixed, known field names.
 * Record keys and unknown keys are operator-controlled text and never echoed.
 */
function schemaReasons(issues: z.ZodError["issues"]): string[] {
  const reasons = new Set<string>();

  for (const issue of issues) {
    const field = issue.path[0];
    if (issue.code === "unrecognized_keys") {
      reasons.add(
        typeof field === "string" && MANIFEST_FIELDS.has(field)
          ? `manifest_unknown_field:${field}`
          : "manifest_unknown_field",
      );
      continue;
    }

    if (typeof field === "string" && MANIFEST_FIELDS.has(field)) {
      reasons.add(`manifest_invalid_field:${field}`);
    } else {
      reasons.add("manifest_invalid");
    }
  }

  return [...reasons].sort();
}

function consistencyReasons(
  manifest: DeploymentManifest,
  runtime: DeploymentRuntimeConfig,
): string[] {
  const reasons: string[] = [];

  if (!passphraseMatchesNetwork(manifest.network, manifest.networkPassphrase)) {
    reasons.push("manifest_passphrase_network_mismatch");
  }

  if (runtime.network !== manifest.network) {
    reasons.push("manifest_network_drift");
  }

  if (runtime.networkPassphrase !== manifest.networkPassphrase) {
    reasons.push("manifest_passphrase_drift");
  }

  const contracts = Object.entries(manifest.contracts).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  // Every contract must belong to the manifest's network. Addresses from two
  // networks in one document would let a client build a transaction for one
  // network against a contract that only exists on another.
  for (const [name, contract] of contracts) {
    if (contract.network !== manifest.network) {
      reasons.push(`manifest_contract_network_mismatch:${name}`);
    }
  }

  const addresses = new Set<string>();
  for (const [name, contract] of contracts) {
    if (addresses.has(contract.address)) {
      reasons.push(`manifest_duplicate_contract_address:${name}`);
    }
    addresses.add(contract.address);
  }

  for (const name of CONFIGURED_CONTRACT_NAMES) {
    const configured = runtime.configuredContracts[name];
    if (!configured) continue;

    const declared = manifest.contracts[name];
    if (!declared) {
      reasons.push(`manifest_contract_missing:${name}`);
    } else if (declared.address !== configured) {
      reasons.push(`manifest_contract_drift:${name}`);
    }
  }

  return reasons;
}

function containsSecretMaterial(value: unknown): boolean {
  if (typeof value === "string") {
    return STELLAR_SECRET_SEED_PATTERN.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsSecretMaterial);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, item]) =>
        STELLAR_SECRET_SEED_PATTERN.test(key) || containsSecretMaterial(item),
    );
  }
  return false;
}

/** The public, versioned metadata document. */
export interface DeploymentMetadataDocument {
  schema: typeof DEPLOYMENT_METADATA_SCHEMA;
  schemaVersion: typeof DEPLOYMENT_METADATA_SCHEMA_VERSION;
  deploymentVersion: string;
  /**
   * One network per document. Contracts carry no network of their own in the
   * published form, so the response structurally cannot mix networks.
   */
  network: { name: StellarNetworkName; passphrase: string };
  contracts: { name: string; address: string; wasmHash: string }[];
  artifacts: { name: string; sha256: string }[];
}

export interface DeploymentMetadataIntegrity {
  algorithm: typeof DEPLOYMENT_METADATA_DIGEST_ALGORITHM;
  canonicalization: typeof DEPLOYMENT_METADATA_CANONICALIZATION;
  /** Lowercase hex SHA-256 of `canonicalize(document)`. */
  digest: string;
}

export interface DeploymentMetadataEnvelope {
  document: DeploymentMetadataDocument;
  integrity: DeploymentMetadataIntegrity;
}

/**
 * Build the public document from a validated manifest.
 *
 * Fields are copied by allow-list, never spread: anything added to the
 * manifest later is unpublished until someone deliberately adds it here.
 */
export function buildDeploymentMetadataDocument(
  manifest: DeploymentManifest,
): DeploymentMetadataDocument {
  return {
    schema: DEPLOYMENT_METADATA_SCHEMA,
    schemaVersion: DEPLOYMENT_METADATA_SCHEMA_VERSION,
    deploymentVersion: manifest.deploymentVersion,
    network: {
      name: manifest.network,
      passphrase: manifest.networkPassphrase,
    },
    contracts: Object.entries(manifest.contracts)
      .map(([name, contract]) => ({
        name,
        address: contract.address,
        wasmHash: contract.wasmHash,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    artifacts: Object.entries(manifest.artifacts ?? {})
      .map(([name, hash]) => ({ name, sha256: hash }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Digest of the canonical form of a document.
 *
 * Verification method (documented on the endpoint): recompute
 * `sha256(canonicalize(document))` — keys sorted recursively, compact
 * `JSON.stringify`, UTF-8, lowercase hex — and compare with
 * `integrity.digest`. The same digest is served as the `ETag`.
 */
export function digestDeploymentMetadata(
  document: DeploymentMetadataDocument,
): string {
  return sha256(canonicalize(document));
}

export function sealDeploymentMetadata(
  document: DeploymentMetadataDocument,
): DeploymentMetadataEnvelope {
  return {
    document,
    integrity: {
      algorithm: DEPLOYMENT_METADATA_DIGEST_ALGORITHM,
      canonicalization: DEPLOYMENT_METADATA_CANONICALIZATION,
      digest: digestDeploymentMetadata(document),
    },
  };
}

/** Client-side check: does the envelope's digest match its document? */
export function verifyDeploymentMetadata(
  envelope: DeploymentMetadataEnvelope,
): boolean {
  if (
    envelope.integrity.algorithm !== DEPLOYMENT_METADATA_DIGEST_ALGORITHM ||
    envelope.integrity.canonicalization !== DEPLOYMENT_METADATA_CANONICALIZATION
  ) {
    return false;
  }
  return safeEqual(
    digestDeploymentMetadata(envelope.document),
    envelope.integrity.digest,
  );
}
