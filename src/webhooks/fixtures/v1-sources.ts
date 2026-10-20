import { WebhookEventSources } from "../webhook-event.types";

/**
 * Deterministic inputs for the version-1 webhook payload fixtures.
 *
 * The JSON files beside this module are the frozen, byte-exact serialization
 * of these sources. The contract test re-serializes the sources and compares
 * bytes, so any change to a v1 serializer — a renamed field, a reordered key,
 * a changed date format — fails the build instead of reaching integrators.
 *
 * Never edit a v1 fixture to make the test pass. A payload change ships as a
 * new schema version with its own fixtures (docs/webhook-payloads.md).
 */
export const V1_FIXTURE_EVENT_ID = "0b5c7d6e-3f2a-4c1b-9e8d-7a6b5c4d3e2f";
export const V1_FIXTURE_OCCURRED_AT = new Date("2026-09-01T12:00:00.000Z");

export const V1_FIXTURE_SOURCES: WebhookEventSources = {
  "proof.created": {
    proofId: "018e1234-abcd-7000-8000-abcdef012345",
    proofType: "MINIMUM_INCOME",
    credentialSchemaVersion: "earnproof.minimum-income.v1",
    status: "ACTIVE",
    network: "testnet",
    assetCode: "USDC",
    assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    periodStart: new Date("2026-08-01T00:00:00.000Z"),
    periodEnd: new Date("2026-08-31T23:59:59.000Z"),
    expiresAt: new Date("2026-10-01T12:00:00.000Z"),
    credentialHash:
      "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    contractTransactionHash: null,
    issuedAt: new Date("2026-09-01T12:00:00.000Z"),
  },
  "proof.revoked": {
    proofId: "018e1234-abcd-7000-8000-abcdef012345",
    status: "REVOKED",
    revokedAt: new Date("2026-09-02T08:30:00.000Z"),
  },
  "proof.verified": {
    proofId: "018e1234-abcd-7000-8000-abcdef012345",
    result: "VALID",
    verifiedAt: new Date("2026-09-03T15:45:00.000Z"),
  },
  "attestation.expired": {
    attestationId: "018e1234-abcd-7000-8000-abcdef012345",
    issuerId: "018e1234-abcd-7000-8000-abcdef012345",
    subjectWalletHash:
      "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    previousStatus: "ACTIVE",
    effectiveStatus: "EXPIRED",
    expiresAt: new Date("2026-09-01T12:00:00.000Z"),
    reconciledAt: new Date("2026-09-01T12:00:00.000Z"),
  },
};
