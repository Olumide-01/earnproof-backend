import {
  WEBHOOK_PAYLOAD_VERSIONS,
  WebhookEnvelope,
  WebhookEventSources,
  WebhookEventType,
  WebhookPayloadVersion,
  WebhookPayloadsV1,
} from "./webhook-event.types";

/**
 * Versioned webhook payload serializers.
 *
 * This file is the only place a webhook body is produced. Three properties are
 * enforced here rather than by convention at the call sites:
 *
 * 1. **Explicit fields.** Each serializer copies named fields from a domain
 *    source. A source carrying extra data — an encrypted threshold, a wallet
 *    hash, a user id — cannot leak, because nothing is spread or forwarded.
 * 2. **Declared shape.** Every serialized payload is checked against the
 *    version's declared field list. A serializer that drifts from its
 *    declaration throws, so the event is not delivered rather than delivered
 *    with an undeclared field.
 * 3. **Deterministic bytes.** Envelope and payload keys are emitted in a fixed
 *    order, so the same event always serializes to the same bytes. The bytes
 *    are persisted and reused for every retry; they are never re-derived.
 */

/** Raised when a payload cannot be produced safely. Never delivered. */
export class WebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookPayloadError";
  }
}

interface PayloadSchema<E extends WebhookEventType> {
  /** Declared fields, in serialization order. The drift contract. */
  fields: readonly (keyof WebhookPayloadsV1[E] & string)[];
  /** Set when the version is deprecated; surfaced as delivery headers only. */
  deprecation?: { sunsetAt: string };
  serialize(source: WebhookEventSources[E]): WebhookPayloadsV1[E];
}

type PayloadRegistry = {
  [V in WebhookPayloadVersion]: { [E in WebhookEventType]: PayloadSchema<E> };
};

/**
 * Field names that must never appear in any payload, at any depth, in any
 * version. Defence in depth behind the explicit serializers: adding one of
 * these to a declared field list fails the contract test and fails at runtime.
 */
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  "userid",
  "walletaddress",
  "wallethash",
  "subject",
  "thresholdamount",
  "thresholdencrypted",
  "amount",
  "amountencrypted",
  "commitment",
  "disclosurepolicy",
  "secret",
  "secretencrypted",
  "signingsecret",
  "token",
  "tokenhash",
  "memo",
  "sourceaddress",
  "operationid",
  "organizationid",
  "webhookid",
  "url",
]);

const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);

export const WEBHOOK_PAYLOAD_REGISTRY: PayloadRegistry = {
  "1": {
    "proof.created": {
      fields: [
        "proofId",
        "proofType",
        "schemaVersion",
        "status",
        "network",
        "assetCode",
        "assetIssuer",
        "periodStart",
        "periodEnd",
        "expiresAt",
        "credentialHash",
        "contractTransactionHash",
        "issuedAt",
      ],
      serialize: (s) => ({
        proofId: s.proofId,
        proofType: s.proofType,
        schemaVersion: s.credentialSchemaVersion,
        status: s.status,
        network: s.network,
        assetCode: s.assetCode,
        assetIssuer: s.assetIssuer ?? null,
        periodStart: isoOrNull(s.periodStart),
        periodEnd: isoOrNull(s.periodEnd),
        expiresAt: iso(s.expiresAt),
        credentialHash: s.credentialHash,
        contractTransactionHash: s.contractTransactionHash ?? null,
        issuedAt: iso(s.issuedAt),
      }),
    },
    "proof.revoked": {
      fields: ["proofId", "status", "revokedAt"],
      serialize: (s) => ({
        proofId: s.proofId,
        status: s.status,
        revokedAt: iso(s.revokedAt),
      }),
    },
    "proof.verified": {
      fields: ["proofId", "result", "verifiedAt"],
      serialize: (s) => ({
        proofId: s.proofId,
        result: s.result,
        verifiedAt: iso(s.verifiedAt),
      }),
    },
    "attestation.expired": {
      fields: [
        "attestationId",
        "issuerId",
        "subjectWalletHash",
        "previousStatus",
        "effectiveStatus",
        "expiresAt",
        "reconciledAt",
      ],
      serialize: (s) => ({
        attestationId: s.attestationId,
        issuerId: s.issuerId,
        subjectWalletHash: s.subjectWalletHash,
        previousStatus: s.previousStatus,
        effectiveStatus: s.effectiveStatus,
        expiresAt: typeof s.expiresAt === "string" ? s.expiresAt : iso(s.expiresAt),
        reconciledAt: typeof s.reconciledAt === "string" ? s.reconciledAt : iso(s.reconciledAt),
      }),
    },
  },
};

export function isSupportedPayloadVersion(
  version: string,
): version is WebhookPayloadVersion {
  return (WEBHOOK_PAYLOAD_VERSIONS as readonly string[]).includes(version);
}

/** Deprecation metadata for a version, if it is deprecated. */
export function payloadDeprecation(
  event: string,
  version: string,
): { sunsetAt: string } | undefined {
  if (!isSupportedPayloadVersion(version)) return undefined;
  const schema = WEBHOOK_PAYLOAD_REGISTRY[version][event as WebhookEventType];
  return schema?.deprecation;
}

export interface SerializedWebhookEvent<E extends WebhookEventType> {
  envelope: WebhookEnvelope<E>;
  /** Exact request body. Persist and send these bytes; never re-serialize. */
  body: string;
  schemaVersion: WebhookPayloadVersion;
}

/**
 * Serialize one domain event for one payload version.
 *
 * `eventId` and `occurredAt` are supplied by the caller so the same domain
 * event carries the same identity to every endpoint, and so fixtures are
 * deterministic.
 */
export function serializeWebhookEvent<E extends WebhookEventType>(input: {
  event: E;
  source: WebhookEventSources[E];
  eventId: string;
  occurredAt: Date;
  version: string;
}): SerializedWebhookEvent<E> {
  if (!isSupportedPayloadVersion(input.version)) {
    throw new WebhookPayloadError(
      `Unsupported webhook payload version "${input.version}"`,
    );
  }
  const schema = WEBHOOK_PAYLOAD_REGISTRY[input.version][input.event] as
    | PayloadSchema<E>
    | undefined;
  if (!schema) {
    throw new WebhookPayloadError(
      `No version ${input.version} schema for event "${input.event}"`,
    );
  }

  const data = schema.serialize(input.source);
  assertConforms(input.event, input.version, schema.fields, data);

  const envelope: WebhookEnvelope<E> = {
    specVersion: "1",
    id: input.eventId,
    event: input.event,
    schemaVersion: input.version,
    createdAt: input.occurredAt.toISOString(),
    data,
  };

  return {
    envelope,
    body: JSON.stringify(envelope),
    schemaVersion: input.version,
  };
}

function assertConforms(
  event: string,
  version: string,
  fields: readonly string[],
  data: object,
): void {
  const actual = Object.keys(data);
  if (
    actual.length !== fields.length ||
    actual.some((key, index) => key !== fields[index])
  ) {
    throw new WebhookPayloadError(
      `Payload for ${event} v${version} does not match its declared fields`,
    );
  }
  for (const [key, value] of Object.entries(data)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
      throw new WebhookPayloadError(
        `Payload for ${event} v${version} declares forbidden field "${key}"`,
      );
    }
    // Version 1 payloads are flat: every value is a string or null. A nested
    // object is how an internal record would slip through, so it is refused.
    if (value !== null && typeof value !== "string") {
      throw new WebhookPayloadError(
        `Payload for ${event} v${version} field "${key}" must be a string or null`,
      );
    }
  }
}

/** Exposed for the contract test; not used at runtime. */
export const FORBIDDEN_WEBHOOK_PAYLOAD_KEYS: ReadonlySet<string> =
  FORBIDDEN_PAYLOAD_KEYS;
