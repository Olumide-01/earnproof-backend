import {
  syntheticAmount,
  syntheticCredentialHash,
  syntheticDate,
  syntheticInt,
  syntheticSecret,
  syntheticSlug,
  syntheticTransactionHash,
  syntheticUrl,
  syntheticWalletAddress,
  syntheticWalletHash,
} from "./synthetic";
import {
  ASSESSMENT_VERSION,
  CompatibilityFinding,
  FindingSeverity,
  CheckKind,
  SignedArtifact,
} from "../../contracts/assessment-types";

/**
 * Intent-based factories for test and demo data.
 *
 * Builders are named for the SCENARIO they express — `revokedProof()`,
 * `suspendedIssuer()`, `failedDelivery()` — rather than exposing raw Prisma
 * shapes. That choice is deliberate: a test that spells out every column asserts
 * on details it does not care about, so a harmless schema addition breaks
 * hundreds of unrelated tests. Naming the intent keeps the schema free to move.
 *
 * Every builder is a pure function of its seed and overrides. Nothing reads the
 * clock, a random source, or the database, so the same call always produces the
 * same object.
 */

export type ResourceStatusValue =
  | "ACTIVE"
  | "PENDING"
  | "SUSPENDED"
  | "REVOKED"
  | "DELETED";

export type ProofStatusValue = "ACTIVE" | "EXPIRED" | "REVOKED" | "INVALID";

export interface UserInput {
  id: string;
  walletAddress: string;
  walletHash: string;
  role: "WORKER" | "ISSUER" | "ADMIN" | "DEVELOPER";
  status: ResourceStatusValue;
}

export interface OrganizationInput {
  id: string;
  name: string;
  slug: string;
  website: string;
  status: ResourceStatusValue;
  createdById: string;
}

export interface IssuerInput {
  id: string;
  organizationId: string;
  stellarAddress: string;
  status: ResourceStatusValue;
  verifiedAt: Date | null;
  suspendedAt: Date | null;
  revokedAt: Date | null;
}

export interface PaymentInput {
  id: string;
  userId: string;
  stellarTransactionHash: string;
  operationId: string;
  sourceAddress: string;
  destinationAddress: string;
  assetCode: string;
  assetIssuer: string | null;
  occurredAt: Date;
  classification:
    | "INCOME"
    | "REIMBURSEMENT"
    | "PERSONAL_TRANSFER"
    | "UNKNOWN"
    | "EXCLUDED";
  isEligible: boolean;
  /**
   * Plaintext amount, for assertions only.
   *
   * Never written to the database: the schema stores `amountEncrypted`, and a
   * factory that bypassed encryption would quietly train contributors to write
   * fixtures that violate the app's own privacy boundary.
   */
  amount: string;
}

export interface ProofInput {
  id: string;
  userId: string;
  proofType: string;
  schemaVersion: string;
  status: ProofStatusValue;
  network: string;
  assetCode: string;
  expiresAt: Date;
  credentialHash: string;
  contractTransactionHash: string | null;
  revokedAt: Date | null;
}

export interface ApiKeyInput {
  id: string;
  organizationId: string;
  createdById: string;
  name: string;
  prefix: string;
  keyHash: string;
  status: ResourceStatusValue;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface WebhookInput {
  id: string;
  organizationId: string;
  url: string;
  secret: string;
}

export interface WebhookDeliveryInput {
  id: string;
  webhookId: string;
  eventType: string;
  eventId: string;
  payload: Record<string, unknown>;
  attempt: number;
  status: "PENDING" | "SUCCESS" | "FAILED";
  statusCode: number | null;
  failureReason: string | null;
  deliveredAt: Date | null;
}

export interface AnchoringIntentInput {
  id: string;
  proofId: string;
  operation: "REGISTER" | "REVOKE";
  status: "PENDING" | "PROCESSING" | "CONFIRMED" | "FAILED";
  transactionHash: string | null;
  attempts: number;
}

/** Deterministic synthetic identifier for a given model and seed. */
function syntheticId(model: string, seed: string | number): string {
  return `synthetic_${model}_${String(seed)}`;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function buildUser(
  seed: string | number,
  overrides: Partial<UserInput> = {},
): UserInput {
  return {
    id: syntheticId("user", seed),
    walletAddress: syntheticWalletAddress(seed),
    walletHash: syntheticWalletHash(seed),
    role: "WORKER",
    status: "ACTIVE",
    ...overrides,
  };
}

/** A user whose account has been suspended. */
export function suspendedUser(
  seed: string | number,
  overrides: Partial<UserInput> = {},
): UserInput {
  return buildUser(seed, { status: "SUSPENDED", ...overrides });
}

// ---------------------------------------------------------------------------
// Organizations and issuers
// ---------------------------------------------------------------------------

export function buildOrganization(
  seed: string | number,
  createdById: string,
  overrides: Partial<OrganizationInput> = {},
): OrganizationInput {
  return {
    id: syntheticId("org", seed),
    name: `Synthetic Org ${String(seed)}`,
    slug: syntheticSlug(seed),
    website: syntheticUrl("", seed),
    status: "ACTIVE",
    createdById,
    ...overrides,
  };
}

export function buildIssuer(
  seed: string | number,
  organizationId: string,
  overrides: Partial<IssuerInput> = {},
): IssuerInput {
  return {
    id: syntheticId("issuer", seed),
    organizationId,
    stellarAddress: syntheticWalletAddress(`issuer-${String(seed)}`),
    status: "ACTIVE",
    verifiedAt: syntheticDate(-30),
    suspendedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

/** An issuer that has been suspended and should fail verification. */
export function suspendedIssuer(
  seed: string | number,
  organizationId: string,
  overrides: Partial<IssuerInput> = {},
): IssuerInput {
  return buildIssuer(seed, organizationId, {
    status: "SUSPENDED",
    suspendedAt: syntheticDate(-5),
    ...overrides,
  });
}

/** An issuer that has been permanently revoked. */
export function revokedIssuer(
  seed: string | number,
  organizationId: string,
  overrides: Partial<IssuerInput> = {},
): IssuerInput {
  return buildIssuer(seed, organizationId, {
    status: "REVOKED",
    revokedAt: syntheticDate(-2),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export function buildPayment(
  seed: string | number,
  userId: string,
  overrides: Partial<PaymentInput> = {},
): PaymentInput {
  return {
    id: syntheticId("payment", seed),
    userId,
    stellarTransactionHash: syntheticTransactionHash(seed),
    operationId: `synthetic-op-${String(seed)}`,
    sourceAddress: syntheticWalletAddress(`src-${String(seed)}`),
    destinationAddress: syntheticWalletAddress(`dst-${String(seed)}`),
    assetCode: "USDC",
    assetIssuer: syntheticWalletAddress(`asset-${String(seed)}`),
    occurredAt: syntheticDate(-syntheticInt("payment-age", seed, 1, 90)),
    classification: "INCOME",
    isEligible: true,
    amount: syntheticAmount(seed),
    ...overrides,
  };
}

/** A payment explicitly excluded from income calculations. */
export function excludedPayment(
  seed: string | number,
  userId: string,
  overrides: Partial<PaymentInput> = {},
): PaymentInput {
  return buildPayment(seed, userId, {
    classification: "EXCLUDED",
    isEligible: false,
    ...overrides,
  });
}

/** A payment that has not yet been classified. */
export function unclassifiedPayment(
  seed: string | number,
  userId: string,
  overrides: Partial<PaymentInput> = {},
): PaymentInput {
  return buildPayment(seed, userId, {
    classification: "UNKNOWN",
    isEligible: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------

export function buildProof(
  seed: string | number,
  userId: string,
  overrides: Partial<ProofInput> = {},
): ProofInput {
  return {
    id: syntheticId("proof", seed),
    userId,
    proofType: "MINIMUM_INCOME",
    schemaVersion: "1.0.0",
    status: "ACTIVE",
    network: "stellar-testnet",
    assetCode: "USDC",
    expiresAt: syntheticDate(90),
    credentialHash: syntheticCredentialHash(seed),
    contractTransactionHash: syntheticTransactionHash(`anchor-${String(seed)}`),
    revokedAt: null,
    ...overrides,
  };
}

/** A proof whose validity window has closed. */
export function expiredProof(
  seed: string | number,
  userId: string,
  overrides: Partial<ProofInput> = {},
): ProofInput {
  return buildProof(seed, userId, {
    status: "EXPIRED",
    expiresAt: syntheticDate(-1),
    ...overrides,
  });
}

/** A proof revoked by its issuer before expiry. */
export function revokedProof(
  seed: string | number,
  userId: string,
  overrides: Partial<ProofInput> = {},
): ProofInput {
  return buildProof(seed, userId, {
    status: "REVOKED",
    revokedAt: syntheticDate(-3),
    ...overrides,
  });
}

/**
 * A proof that exists locally but was never anchored on-chain.
 *
 * `contractTransactionHash: null` is the distinguishing property, and it is the
 * state most likely to be modelled wrongly by hand — which is precisely why it
 * gets a named builder.
 */
export function unanchoredProof(
  seed: string | number,
  userId: string,
  overrides: Partial<ProofInput> = {},
): ProofInput {
  return buildProof(seed, userId, {
    contractTransactionHash: null,
    ...overrides,
  });
}

/** A proof that failed verification and is considered invalid. */
export function invalidProof(
  seed: string | number,
  userId: string,
  overrides: Partial<ProofInput> = {},
): ProofInput {
  return buildProof(seed, userId, { status: "INVALID", ...overrides });
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export function buildApiKey(
  seed: string | number,
  organizationId: string,
  createdById: string,
  overrides: Partial<ApiKeyInput> = {},
): ApiKeyInput {
  const secret = syntheticSecret(seed);
  return {
    id: syntheticId("apikey", seed),
    organizationId,
    createdById,
    name: `Synthetic Key ${String(seed)}`,
    // The schema caps prefix at 8 characters.
    prefix: `syn${String(seed)}`.slice(0, 8).padEnd(8, "0"),
    keyHash: `sha256:${secret}`,
    status: "ACTIVE",
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

/** An API key past its expiry date. */
export function expiredApiKey(
  seed: string | number,
  organizationId: string,
  createdById: string,
  overrides: Partial<ApiKeyInput> = {},
): ApiKeyInput {
  return buildApiKey(seed, organizationId, createdById, {
    expiresAt: syntheticDate(-1),
    ...overrides,
  });
}

/** An API key revoked by an administrator. */
export function revokedApiKey(
  seed: string | number,
  organizationId: string,
  createdById: string,
  overrides: Partial<ApiKeyInput> = {},
): ApiKeyInput {
  return buildApiKey(seed, organizationId, createdById, {
    status: "REVOKED",
    revokedAt: syntheticDate(-7),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export function buildWebhook(
  seed: string | number,
  organizationId: string,
  overrides: Partial<WebhookInput> = {},
): WebhookInput {
  return {
    id: syntheticId("webhook", seed),
    organizationId,
    // example.invalid never resolves (RFC 2606), so a seeded webhook cannot
    // deliver to a host anybody controls.
    url: syntheticUrl("hooks/synthetic", seed),
    secret: syntheticSecret(`webhook-${String(seed)}`),
    ...overrides,
  };
}

export function buildDelivery(
  seed: string | number,
  webhookId: string,
  overrides: Partial<WebhookDeliveryInput> = {},
): WebhookDeliveryInput {
  return {
    id: syntheticId("delivery", seed),
    webhookId,
    eventType: "proof.created",
    eventId: syntheticId("event", seed),
    payload: { synthetic: true, seed: String(seed) },
    attempt: 1,
    status: "SUCCESS",
    statusCode: 200,
    failureReason: null,
    deliveredAt: syntheticDate(-1),
    ...overrides,
  };
}

/** A delivery that exhausted its attempts and failed. */
export function failedDelivery(
  seed: string | number,
  webhookId: string,
  overrides: Partial<WebhookDeliveryInput> = {},
): WebhookDeliveryInput {
  return buildDelivery(seed, webhookId, {
    status: "FAILED",
    statusCode: 500,
    // A stable code, not a raw upstream error body, matching how the app
    // records failures.
    failureReason: "synthetic_upstream_error",
    attempt: 5,
    deliveredAt: null,
    ...overrides,
  });
}

/** A delivery still queued for its first attempt. */
export function pendingDelivery(
  seed: string | number,
  webhookId: string,
  overrides: Partial<WebhookDeliveryInput> = {},
): WebhookDeliveryInput {
  return buildDelivery(seed, webhookId, {
    status: "PENDING",
    statusCode: null,
    deliveredAt: null,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Anchoring
// ---------------------------------------------------------------------------

export function buildAnchoringIntent(
  seed: string | number,
  proofId: string,
  overrides: Partial<AnchoringIntentInput> = {},
): AnchoringIntentInput {
  return {
    id: syntheticId("anchor", seed),
    proofId,
    operation: "REGISTER",
    status: "CONFIRMED",
    transactionHash: syntheticTransactionHash(`intent-${String(seed)}`),
    attempts: 1,
    ...overrides,
  };
}

/** An anchoring intent that never reached the chain. */
export function failedAnchoringIntent(
  seed: string | number,
  proofId: string,
  overrides: Partial<AnchoringIntentInput> = {},
): AnchoringIntentInput {
  return buildAnchoringIntent(seed, proofId, {
    status: "FAILED",
    transactionHash: null,
    attempts: 3,
    ...overrides,
  });
}

/** An anchoring intent still waiting to be submitted. */
export function pendingAnchoringIntent(
  seed: string | number,
  proofId: string,
  overrides: Partial<AnchoringIntentInput> = {},
): AnchoringIntentInput {
  return buildAnchoringIntent(seed, proofId, {
    status: "PENDING",
    transactionHash: null,
    attempts: 0,
    ...overrides,
  });
}

export * from "./synthetic";

// ---------------------------------------------------------------------------
// Compatibility Assessments
// ---------------------------------------------------------------------------

export type AssessmentStatusValue = "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";

export interface CompatibilityAssessmentInput {
  id: string;
  proofId: string;
  version: string;
  findingsHash: string | null;
  status: AssessmentStatusValue;
  requestedBy: string;
  artifactVersion: string;
  hasBlockingFindings: boolean;
  findings: CompatibilityFinding[] | null;
  lastErrorSafe: string | null;
  completedAt: Date | null;
}

/** A completed assessment with no BLOCKING findings — governance can auto-approve. */
export function buildCompatibilityAssessment(
  seed: string | number,
  proofId: string,
  overrides: Partial<CompatibilityAssessmentInput> = {},
): CompatibilityAssessmentInput {
  const id = syntheticId("assessment", seed);
  return {
    id,
    proofId,
    version: ASSESSMENT_VERSION,
    findingsHash: `sha256:synthetic${syntheticCredentialHash(String(seed)).replace("sha256:", "").slice(0, 55)}`,
    status: "COMPLETE",
    requestedBy: syntheticWalletHash(`req-${String(seed)}`),
    artifactVersion: "1",
    hasBlockingFindings: false,
    findings: [
      {
        checkKind: CheckKind.ABI,
        severity: FindingSeverity.INFO,
        description: "No previous ABI snapshot; current ABI recorded as baseline.",
        hash: `sha256:synthetic${syntheticCredentialHash(`abi-${String(seed)}`).replace("sha256:", "").slice(0, 55)}`,
      },
    ],
    lastErrorSafe: null,
    completedAt: new Date("2025-01-01T12:00:00.000Z"),
    ...overrides,
  };
}

/** An assessment blocked by a BLOCKING finding — governance must reject. */
export function blockingCompatibilityAssessment(
  seed: string | number,
  proofId: string,
  overrides: Partial<CompatibilityAssessmentInput> = {},
): CompatibilityAssessmentInput {
  const blockingFinding: CompatibilityFinding = {
    checkKind: CheckKind.ABI,
    severity: FindingSeverity.BLOCKING,
    description: `ABI function "transfer" was removed — existing callers will break.`,
    hash: `sha256:synthetic${syntheticCredentialHash(`blocking-${String(seed)}`).replace("sha256:", "").slice(0, 55)}`,
    evidence: { removedFunction: "transfer" },
  };
  return buildCompatibilityAssessment(seed, proofId, {
    findingsHash: `sha256:synthetic${syntheticCredentialHash(`blocking-hash-${String(seed)}`).replace("sha256:", "").slice(0, 55)}`,
    hasBlockingFindings: true,
    findings: [blockingFinding],
    ...overrides,
  });
}

/** An assessment that failed before completing. */
export function failedCompatibilityAssessment(
  seed: string | number,
  proofId: string,
  overrides: Partial<CompatibilityAssessmentInput> = {},
): CompatibilityAssessmentInput {
  return buildCompatibilityAssessment(seed, proofId, {
    status: "FAILED",
    findingsHash: null,
    findings: null,
    hasBlockingFindings: false,
    completedAt: null,
    lastErrorSafe: "assessment execution failed: redacted",
    ...overrides,
  });
}

/** A pending assessment not yet processed by the worker. */
export function pendingCompatibilityAssessment(
  seed: string | number,
  proofId: string,
  overrides: Partial<CompatibilityAssessmentInput> = {},
): CompatibilityAssessmentInput {
  return buildCompatibilityAssessment(seed, proofId, {
    status: "PENDING",
    findingsHash: null,
    findings: null,
    hasBlockingFindings: false,
    completedAt: null,
    lastErrorSafe: null,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Signed Artifacts (test inputs — never contain real material)
// ---------------------------------------------------------------------------

/** A minimal well-formed synthetic signed artifact. */
export function buildSignedArtifact(
  seed: string | number,
  proofId: string,
  overrides: Partial<SignedArtifact> = {},
): SignedArtifact {
  return {
    proofId,
    schemaVersion: "1",
    credentialHash: syntheticCredentialHash(String(seed)),
    abi: [
      { name: "register_proof", inputs: ["proofId", "commitment"], outputs: ["bool"] },
      { name: "is_valid_proof", inputs: ["proofId"], outputs: ["bool"] },
    ],
    storage: [
      { slot: "0x00", type: "bytes32", mutable: false },
      { slot: "0x01", type: "address", mutable: false },
    ],
    dependencies: [
      { name: "@stellar/sdk", version: "11.0.0", breaking: false },
    ],
    clientContracts: [
      { contractId: "earnproof.proof-registry.v1", version: "1", deprecated: false },
    ],
    migrationNotes: [],
    ...overrides,
  };
}
