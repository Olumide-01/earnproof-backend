import { readFileSync } from "fs";
import { join } from "path";
import {
  ContractDefinition,
  ContractSurface,
  diffContracts,
} from "../common/compatibility/contract-snapshot";
import {
  V1_FIXTURE_EVENT_ID,
  V1_FIXTURE_OCCURRED_AT,
  V1_FIXTURE_SOURCES,
} from "./fixtures/v1-sources";
import {
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_PAYLOAD_VERSIONS,
  WebhookEventType,
} from "./webhook-event.types";
import {
  FORBIDDEN_WEBHOOK_PAYLOAD_KEYS,
  WEBHOOK_PAYLOAD_REGISTRY,
  WebhookPayloadError,
  serializeWebhookEvent,
} from "./webhook-payload.serializers";

/**
 * Webhook payload contract tests (#158).
 *
 * The version-1 contract is frozen twice over: as a declared field list below
 * and as byte-exact fixture files. Either one drifting fails the build. A
 * legitimate payload change is a new schema version with new fixtures — never
 * an edit to these expectations.
 */

/** The frozen v1 data contract, per event. Do not edit; add a version. */
const FROZEN_V1_FIELDS: Record<WebhookEventType, string[]> = {
  "proof.created": [
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
  "proof.revoked": ["proofId", "status", "revokedAt"],
  "proof.verified": ["proofId", "result", "verifiedAt"],
  "attestation.expired": [
    "attestationId",
    "issuerId",
    "subjectWalletHash",
    "previousStatus",
    "effectiveStatus",
    "expiresAt",
    "reconciledAt",
  ],
};

const FROZEN_ENVELOPE_FIELDS = [
  "specVersion",
  "id",
  "event",
  "schemaVersion",
  "createdAt",
  "data",
];

function fixture(event: WebhookEventType): string {
  return readFileSync(
    join(__dirname, "fixtures", "v1", `${event}.json`),
    "utf8",
  ).replace(/\r?\n$/, "");
}

function serializeFixture(event: WebhookEventType) {
  return serializeWebhookEvent({
    event,
    source: V1_FIXTURE_SOURCES[event] as never,
    eventId: V1_FIXTURE_EVENT_ID,
    occurredAt: V1_FIXTURE_OCCURRED_AT,
    version: "1",
  });
}

describe("webhook payload contract — version 1", () => {
  it("has a v1 schema for every event type", () => {
    for (const event of WEBHOOK_EVENT_TYPES) {
      expect(WEBHOOK_PAYLOAD_REGISTRY["1"][event]).toBeDefined();
    }
  });

  it.each(WEBHOOK_EVENT_TYPES)(
    "%s serializes byte-for-byte to its frozen fixture",
    (event) => {
      expect(serializeFixture(event).body).toBe(fixture(event));
    },
  );

  it.each(WEBHOOK_EVENT_TYPES)(
    "%s declares exactly the frozen v1 fields, in order",
    (event) => {
      expect([...WEBHOOK_PAYLOAD_REGISTRY["1"][event].fields]).toEqual(
        FROZEN_V1_FIELDS[event],
      );
      const parsed = JSON.parse(fixture(event));
      expect(Object.keys(parsed)).toEqual(FROZEN_ENVELOPE_FIELDS);
      expect(Object.keys(parsed.data)).toEqual(FROZEN_V1_FIELDS[event]);
    },
  );

  it("carries an explicit schema version and the stable event identifier", () => {
    for (const event of WEBHOOK_EVENT_TYPES) {
      const { envelope, schemaVersion } = serializeFixture(event);
      expect(envelope.specVersion).toBe("1");
      expect(envelope.schemaVersion).toBe("1");
      expect(schemaVersion).toBe("1");
      expect(envelope.id).toBe(V1_FIXTURE_EVENT_ID);
      expect(envelope.event).toBe(event);
    }
  });

  it("is deterministic: the same event always yields the same bytes", () => {
    for (const event of WEBHOOK_EVENT_TYPES) {
      expect(serializeFixture(event).body).toBe(serializeFixture(event).body);
    }
  });

  it("reports no change against the declared compatibility surface", () => {
    const declared = (fields: Record<WebhookEventType, string[]>) =>
      WEBHOOK_EVENT_TYPES.map(
        (event): ContractDefinition => ({
          surface: ContractSurface.WEBHOOK,
          id: `webhook.${event}`,
          version: "1",
          fields: fields[event].map((name) => ({ name, required: true })),
        }),
      );
    const live = Object.fromEntries(
      WEBHOOK_EVENT_TYPES.map((event) => [
        event,
        [...WEBHOOK_PAYLOAD_REGISTRY["1"][event].fields],
      ]),
    ) as Record<WebhookEventType, string[]>;

    expect(diffContracts(declared(FROZEN_V1_FIELDS), declared(live))).toEqual(
      [],
    );
  });
});

describe("webhook payload safety", () => {
  it("never forwards fields a source carries beyond the declared contract", () => {
    // A Prisma-shaped row with internal and sensitive columns attached.
    const leakySource = {
      ...V1_FIXTURE_SOURCES["proof.created"],
      userId: "user_internal",
      commitment: "sha256:internal",
      walletHash: "wallet_hash_secret",
      thresholdEncrypted: "redacted:MTAwMA",
      claim: { thresholdEncrypted: "x", disclosurePolicy: {} },
      secretEncrypted: "ciphertext",
    };

    const { body } = serializeWebhookEvent({
      event: "proof.created",
      source: leakySource,
      eventId: V1_FIXTURE_EVENT_ID,
      occurredAt: V1_FIXTURE_OCCURRED_AT,
      version: "1",
    });

    expect(body).toBe(fixture("proof.created"));
    for (const leaked of [
      "user_internal",
      "sha256:internal",
      "wallet_hash_secret",
      "redacted:MTAwMA",
      "ciphertext",
      "disclosurePolicy",
    ]) {
      expect(body).not.toContain(leaked);
    }
  });

  it("no declared field in any version is on the forbidden list", () => {
    for (const version of WEBHOOK_PAYLOAD_VERSIONS) {
      for (const event of WEBHOOK_EVENT_TYPES) {
        for (const field of WEBHOOK_PAYLOAD_REGISTRY[version][event].fields) {
          expect(FORBIDDEN_WEBHOOK_PAYLOAD_KEYS.has(field.toLowerCase())).toBe(
            false,
          );
        }
      }
    }
  });

  it("fails closed when a serializer drifts from its declared fields", () => {
    const schema = WEBHOOK_PAYLOAD_REGISTRY["1"]["proof.revoked"];
    const original = schema.serialize;
    schema.serialize = (s) =>
      ({ ...original(s), walletHash: "leak" }) as ReturnType<typeof original>;
    try {
      expect(() => serializeFixture("proof.revoked")).toThrow(
        WebhookPayloadError,
      );
    } finally {
      schema.serialize = original;
    }
  });

  it("fails closed when a serializer emits a nested object", () => {
    const schema = WEBHOOK_PAYLOAD_REGISTRY["1"]["proof.verified"];
    const original = schema.serialize;
    schema.serialize = (s) =>
      ({ ...original(s), result: { internal: true } }) as unknown as ReturnType<
        typeof original
      >;
    try {
      expect(() => serializeFixture("proof.verified")).toThrow(
        WebhookPayloadError,
      );
    } finally {
      schema.serialize = original;
    }
  });

  it("refuses an unsupported or retired payload version", () => {
    expect(() =>
      serializeWebhookEvent({
        event: "proof.created",
        source: V1_FIXTURE_SOURCES["proof.created"],
        eventId: V1_FIXTURE_EVENT_ID,
        occurredAt: V1_FIXTURE_OCCURRED_AT,
        version: "0",
      }),
    ).toThrow(WebhookPayloadError);
  });
});
