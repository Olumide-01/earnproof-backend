import { AuthEventType, VerificationOutcome } from "@prisma/client";
import { Keypair } from "@stellar/stellar-base";
import { ApiKeyService } from "../../api-keys/api-key.service";
import { AuthAuditService } from "../../auth/auth-audit.service";
import { WalletRotationService } from "../../auth/wallet-rotation.service";
import { sep53MessageHash } from "../../auth/wallet-signature";
import { VerificationEventService } from "../../audit/verification-event.service";
import { IssuerAddressRotationService } from "../../issuers/issuer-address-rotation.service";
import { IssuersService } from "../../issuers/issuers.service";
import { OrganizationLifecycleService } from "../../organizations/organization-lifecycle.service";
import { OrganizationsService } from "../../organizations/organizations.service";
import { PaymentBackfillService } from "../../payments/payment-backfill.service";
import { PaymentsService } from "../../payments/payments.service";
import { ProofsService } from "../../proofs/proofs.service";
import { TrustedSourcesService } from "../../trusted-sources/trusted-sources.service";
import { UsersService } from "../../users/users.service";
import { WebhooksService } from "../../webhooks/webhooks.service";
import { unlimitedQuotas } from "../../testing/quotas";
import { findForbiddenAuditContent } from "./audit-redaction";
import {
  AUDIT_EVENTS,
  AuditEventDefinition,
  AuditOutcome,
  REQUIRED_AUDIT_DOMAINS,
  auditEvent,
  resolveAuditEventType,
  normalizeAuditActorType,
  resolveAuthAuditEventType,
  verificationOutcomeToAuditOutcome,
} from "./audit-taxonomy";

/**
 * The audit completeness and redaction matrix.
 *
 * Every security-relevant action is driven through the real service, and the
 * record it persists is inspected. Three failures are caught here that nothing
 * else catches:
 *
 * 1. **A missing event.** The matrix asserts that the events observed cover the
 *    whole taxonomy, so deleting a write makes this suite fail rather than
 *    silently shrinking the audit trail.
 * 2. **A wrong or absent actor.** An event that cannot say who did it, or under
 *    which tenant, is not evidence.
 * 3. **A leaked field.** The persisted record is scanned for tokens,
 *    signatures, proof bodies, exact amounts, payment history and wallet
 *    addresses, by key name and by value shape.
 *
 * The services are driven with in-memory doubles rather than a database. The
 * subject is the *record the service constructs*, which is fully determined
 * before it reaches PostgreSQL; a real database would make the suite slower and
 * would not observe anything more. Persistence itself — that the row survives a
 * transaction, that the schema accepts it — is covered by the integration
 * suite.
 */

/** A captured `AuditLog` row, before Prisma sees it. */
interface CapturedAuditLog {
  actorType: string;
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: unknown;
}

/** A captured `AuthAuditEvent` row. */
interface CapturedAuthEvent {
  eventType: AuthEventType;
  walletHash: string;
  clientMetadataHash?: string | null;
  challengeId?: string | null;
  success: boolean;
  failureReason?: string | null;
}

/** A captured `VerificationEventLog` row. */
interface CapturedVerificationEvent {
  outcome: VerificationOutcome;
  proofId: string;
  metadataHash: string;
  saltVersion: number;
}

/**
 * The audit sink handed to a scenario.
 *
 * Scenarios build their own domain mocks but always take their audit tables
 * from here, so the same scenario can be replayed with writes that fail — which
 * is how the write-failure behaviour is asserted without a second set of
 * scenarios.
 */
interface AuditSink {
  auditLog: { create: jest.Mock };
  authAuditEvent: { create: jest.Mock; count: jest.Mock };
  verificationEventLog: { create: jest.Mock };
  auditLogs: CapturedAuditLog[];
  authEvents: CapturedAuthEvent[];
  verificationEvents: CapturedVerificationEvent[];
}

function createSink(options: { failing?: boolean } = {}): AuditSink {
  const auditLogs: CapturedAuditLog[] = [];
  const authEvents: CapturedAuthEvent[] = [];
  const verificationEvents: CapturedVerificationEvent[] = [];

  const capture = <T>(into: T[]) =>
    jest.fn(async (call: { data: T }) => {
      if (options.failing) {
        throw new Error("audit store unavailable");
      }
      into.push(call.data);
      return { id: "audit_captured", ...call.data };
    });

  return {
    auditLog: { create: capture(auditLogs) },
    authAuditEvent: { create: capture(authEvents), count: jest.fn(async () => 0) },
    verificationEventLog: { create: capture(verificationEvents) },
    auditLogs,
    authEvents,
    verificationEvents,
  };
}

const ORGANIZATION_ID = "org_matrix";
const USER_ID = "user_matrix";
const ADMIN = {
  id: USER_ID,
  walletAddress: "GTEST",
  walletHash: `sha256:${"a".repeat(64)}`,
  role: "ADMIN",
} as never;

/** A syntactically valid, unmistakably synthetic Stellar account. */
const ISSUER_ADDRESS = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
const PAYER_ADDRESS = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();

/** A wallet address the auth path must never persist in the clear. */
const WALLET_ADDRESS = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();

const configDouble = (values: Record<string, unknown>) =>
  ({
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`missing config ${key}`);
      return value;
    },
  }) as never;

interface Scenario {
  /** Stable event type from the taxonomy. */
  readonly event: string;
  /** Which outcome this run exercises. */
  readonly outcome: AuditOutcome;
  /** Human-readable name for the test title. */
  readonly name: string;
  /** Drives the real service so that exactly one audit record is produced. */
  run(sink: AuditSink): Promise<unknown>;
}

const scenarios: Scenario[] = [
  // ------------------------------------------------------------- api key ---
  {
    event: "api_key.created",
    outcome: "success",
    name: "issuing a machine credential",
    run: (sink) => {
      const prisma = {
        apiKey: {
          create: jest.fn().mockResolvedValue({
            id: "key_1",
            prefix: "ak012345",
            name: "CI robot",
            organizationId: ORGANIZATION_ID,
            status: "ACTIVE",
            expiresAt: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            scopeAssignments: [{ scope: "PROOF_READ" }],
          }),
        },
        auditLog: sink.auditLog,
      };

      return new ApiKeyService(prisma as never).createKey({
        organizationId: ORGANIZATION_ID,
        createdBy: USER_ID,
        name: "CI robot",
      });
    },
  },
  {
    event: "api_key.rotated",
    outcome: "success",
    name: "rotating a machine credential",
    run: (sink) => {
      const prisma = {
        apiKey: {
          update: jest.fn().mockResolvedValue({
            id: "key_1",
            prefix: "ak987654",
            name: "CI robot",
            organizationId: ORGANIZATION_ID,
            status: "ACTIVE",
            rotatedAt: new Date("2026-01-02T00:00:00.000Z"),
            scopeAssignments: [{ scope: "PROOF_READ" }],
          }),
        },
        auditLog: sink.auditLog,
      };

      return new ApiKeyService(prisma as never).rotateKey(
        "key_1",
        ORGANIZATION_ID,
        USER_ID,
      );
    },
  },
  {
    event: "api_key.revoked",
    outcome: "success",
    name: "revoking a machine credential",
    run: (sink) => {
      const prisma = {
        apiKey: {
          findFirst: jest.fn().mockResolvedValue({
            organizationId: ORGANIZATION_ID,
            prefix: "ak012345",
            name: "CI robot",
          }),
          update: jest.fn().mockResolvedValue({}),
        },
        auditLog: sink.auditLog,
      };

      return new ApiKeyService(prisma as never).revokeKey(
        "key_1",
        ORGANIZATION_ID,
        USER_ID,
      );
    },
  },
  {
    event: "authorization.api_key_authenticated",
    outcome: "success",
    name: "accepting a machine credential",
    run: (sink) => {
      const prisma = {
        apiKey: {
          update: jest.fn().mockResolvedValue({
            prefix: "ak012345",
            name: "CI robot",
            organizationId: ORGANIZATION_ID,
          }),
        },
        auditLog: sink.auditLog,
      };

      return new ApiKeyService(prisma as never).recordKeyUsage(
        "key_1",
        ORGANIZATION_ID,
      );
    },
  },
  // -------------------------------------------------------------- issuer ---
  {
    event: "issuer.created",
    outcome: "success",
    name: "registering an issuer",
    run: (sink) => {
      const prisma = {
        organization: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: ORGANIZATION_ID, createdById: USER_ID }),
        },
        issuerAddressRotation: { findUnique: jest.fn().mockResolvedValue(null) },
        issuerAddressHistory: { findFirst: jest.fn().mockResolvedValue(null) },
        issuer: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({
            id: "issuer_1",
            organizationId: ORGANIZATION_ID,
            stellarAddress: ISSUER_ADDRESS,
            status: "PENDING",
            metadataHash: null,
            publicMetadata: {},
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        auditLog: sink.auditLog,
      };

      return new IssuersService(prisma as never, {} as never).createIssuer(ADMIN, {
        organizationId: ORGANIZATION_ID,
        stellarAddress: ISSUER_ADDRESS,
      } as never);
    },
  },
  {
    event: "issuer.metadata_updated",
    outcome: "success",
    name: "changing issuer metadata",
    run: (sink) => {
      const issuer = {
        id: "issuer_1",
        organizationId: ORGANIZATION_ID,
        stellarAddress: ISSUER_ADDRESS,
        status: "ACTIVE",
        metadataHash: null,
        publicMetadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const prisma = {
        issuer: {
          findUnique: jest.fn().mockResolvedValue(issuer),
          update: jest.fn().mockResolvedValue(issuer),
        },
        auditLog: sink.auditLog,
      };

      return new IssuersService(
        prisma as never,
        {} as never,
      ).updateIssuerMetadata(ADMIN, "issuer_1", {
        publicMetadata: { name: "Acme Payroll" },
      } as never);
    },
  },
  {
    event: "issuer.status_updated",
    outcome: "success",
    name: "moving an issuer between lifecycle states",
    run: (sink) => {
      const issuer = {
        id: "issuer_1",
        organizationId: ORGANIZATION_ID,
        stellarAddress: ISSUER_ADDRESS,
        status: "PENDING",
        metadataHash: null,
        publicMetadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const prisma = {
        issuer: {
          findUnique: jest.fn().mockResolvedValue(issuer),
          update: jest
            .fn()
            .mockResolvedValue({ ...issuer, status: "ACTIVE" }),
        },
        organization: {
          findUnique: jest.fn().mockResolvedValue({ archivedAt: null }),
        },
        auditLog: sink.auditLog,
      };

      return new IssuersService(prisma as never, {} as never).updateIssuerStatus(
        ADMIN,
        "issuer_1",
        { status: "ACTIVE" } as never,
      );
    },
  },
  {
    event: "issuer.status_synced",
    outcome: "success",
    name: "synchronising an issuer with the registry",
    run: (sink) => {
      const issuer = {
        id: "issuer_1",
        organizationId: ORGANIZATION_ID,
        stellarAddress: ISSUER_ADDRESS,
        status: "ACTIVE",
        contractSyncedStatus: null,
        metadataHash: null,
        publicMetadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const prisma = {
        issuer: {
          findUnique: jest.fn().mockResolvedValue(issuer),
          update: jest.fn().mockResolvedValue(issuer),
        },
        auditLog: sink.auditLog,
      };
      const registry = {
        sync: jest.fn().mockResolvedValue({
          state: "synced",
          operation: "UPSERT",
          transactionHash: "b".repeat(64),
        }),
      };

      return new IssuersService(
        prisma as never,
        registry as never,
      ).syncIssuerStatus(ADMIN, "issuer_1");
    },
  },
  ...(
    [
      ["issuer.address_rotation_requested", "requesting an issuer address rotation", "request", null],
      ["issuer.address_rotated", "confirming an issuer address rotation", "reconcile", "target"],
      ["issuer.address_rotation_failed", "failing an issuer address rotation on a contract conflict", "reconcile", "other"],
    ] as Array<[string, string, "request" | "reconcile", "target" | "other" | null]>
  ).map(([event, name, operation, observed]): Scenario => ({
    event,
    outcome: "success",
    name,
    run: (sink) => {
      const target = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 13)).publicKey();
      const elsewhere = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 14)).publicKey();
      const issuer = {
        id: "issuer_1",
        organizationId: ORGANIZATION_ID,
        stellarAddress: ISSUER_ADDRESS,
        status: "ACTIVE",
        contractSyncedStatus: "ACTIVE",
        revision: 0,
      };
      const rotation = {
        id: "rotation_1",
        issuerId: "issuer_1",
        fromAddress: ISSUER_ADDRESS,
        toAddress: target,
        status: "PENDING",
        attemptCount: 1,
        lastError: null,
        transactionHash: "d".repeat(64),
        nextAttemptAt: null,
        confirmedAt: null,
        createdAt: new Date(),
      };
      const client = {
        issuer: {
          findUnique: jest.fn(async ({ where }: { where: { id?: string } }) =>
            where.id ? issuer : null,
          ),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ organizationId: ORGANIZATION_ID }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        issuerAddressHistory: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({}),
        },
        issuerAddressRotation: {
          create: jest.fn().mockResolvedValue(rotation),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn().mockResolvedValue(rotation),
          findUnique: jest.fn().mockResolvedValue(rotation),
          findUniqueOrThrow: jest.fn().mockResolvedValue(rotation),
        },
        auditLog: sink.auditLog,
        $transaction: jest.fn(),
      };
      client.$transaction.mockImplementation((run: (tx: typeof client) => unknown) => run(client));
      const registry = {
        isConfigured: true,
        // A request's immediate reconcile finds the registry unreachable and
        // schedules a retry, which writes no audit record of its own.
        readIssuerAddress: jest.fn().mockResolvedValue(
          observed === "target"
            ? { state: "found", issuerAddress: target }
            : observed === "other"
              ? { state: "found", issuerAddress: elsewhere }
              : { state: "failed", error: "unreachable" },
        ),
        rotateIssuerAddress: jest.fn(),
      };
      const service = new IssuerAddressRotationService(client as never, registry as never);

      return operation === "request"
        ? service.requestRotation(ADMIN, "issuer_1", {
            newStellarAddress: target,
            expectedRevision: 0,
          })
        : service.reconcile("rotation_1");
    },
  })),
  // ------------------------------------------------------------- webhook ---
  {
    event: "webhook.delivery_replayed",
    outcome: "success",
    name: "replaying a webhook delivery",
    run: (sink) => {
      const prisma = {
        webhookDelivery: {
          findUnique: jest.fn().mockResolvedValue({
            id: "delivery_1",
            webhookId: "webhook_1",
            eventType: "proof.created",
            eventId: "event_1",
            attempt: 1,
            webhook: { organizationId: ORGANIZATION_ID },
          }),
        },
        auditLog: sink.auditLog,
      };
      const delivery = { replay: jest.fn().mockResolvedValue("delivery_2") };

      const circuitBreaker = {
        initializeCircuit: jest.fn(),
        deleteCircuitState: jest.fn(),
      };

      const verification = {
        issueChallenge: jest.fn(),
        verifyChallenge: jest.fn(),
      };

      return new WebhooksService(
        prisma as never,
        delivery as never,
        circuitBreaker as never,
        verification as never,
        configDouble({ paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" }),
        unlimitedQuotas() as never,
      ).replayDelivery(ORGANIZATION_ID, "delivery_1", USER_ID);
    },
  },
  {
    event: "authentication.wallet_rotated",
    outcome: "success",
    name: "rotating an account's wallet address",
    run: (sink) => {
      const currentKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
      const replacementKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11));
      const sign = (key: Keypair, message: string) =>
        key.sign(sep53MessageHash(message)).toString("base64");
      const rotation = {
        id: "rotation_1",
        userId: USER_ID,
        currentWalletAddress: WALLET_ADDRESS,
        newWalletAddress: replacementKey.publicKey(),
        currentMessage: "current",
        newMessage: "replacement",
        networkPassphrase: "Test SDF Network ; September 2015",
        origin: "http://localhost:3000",
      };
      const tx = {
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        authSession: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
        walletRotation: {
          update: jest.fn().mockResolvedValue({}),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        auditLog: sink.auditLog,
      };
      const prisma = {
        walletRotation: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue(rotation),
        },
        $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
      };
      return new WalletRotationService(
        prisma as never,
        configDouble({
          appUrl: "http://localhost:3000",
          "stellar.networkPassphrase": "Test SDF Network ; September 2015",
        }),
      ).complete(
        { id: USER_ID, walletAddress: WALLET_ADDRESS, walletHash: "unused", role: "WORKER" },
        "rotation_1",
        {
          currentSignature: sign(currentKey, rotation.currentMessage),
          newSignature: sign(replacementKey, rotation.newMessage),
        },
      );
    },
  },
  // ------------------------------------------------------------ operator ---
  {
    event: "operator.organization_created",
    outcome: "success",
    name: "creating a tenant organisation",
    run: (sink) => {
      const prisma = {
        organization: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({
            id: ORGANIZATION_ID,
            name: "Acme",
            slug: "acme",
            website: null,
            status: "PENDING",
            createdById: USER_ID,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        auditLog: sink.auditLog,
      };

      return new OrganizationsService(prisma as never).createOrganization(ADMIN, {
        name: "Acme",
        slug: "acme",
      } as never);
    },
  },
  {
    event: "operator.organization_updated",
    outcome: "success",
    name: "updating a tenant organisation",
    run: (sink) => {
      const org = {
        id: ORGANIZATION_ID,
        name: "Acme",
        slug: "acme",
        website: null,
        status: "ACTIVE",
        createdById: USER_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const prisma = {
        organization: {
          findFirst: jest.fn().mockResolvedValue(org),
          update: jest.fn().mockResolvedValue({ ...org, name: "Acme Payroll" }),
        },
        auditLog: sink.auditLog,
      };

      return new OrganizationsService(prisma as never).updateOrganization(
        ADMIN,
        ORGANIZATION_ID,
        { name: "Acme Payroll" } as never,
      );
    },
  },
  ...(
    [
      ["operator.organization_archived", "archiving a tenant organisation", "archive", { archivedAt: null }],
      ["operator.organization_restored", "restoring a tenant organisation", "restore", { archivedAt: new Date("2026-01-01T00:00:00.000Z") }],
      ["operator.organization_legal_hold_placed", "placing a legal hold", "placeLegalHold", { legalHoldAt: null }],
      ["operator.organization_legal_hold_released", "releasing a legal hold", "releaseLegalHold", { legalHoldAt: new Date("2026-01-01T00:00:00.000Z"), legalHoldReference: "LEGAL-2026-001" }],
      ["operator.organization_deleted", "deleting an archived tenant organisation", "deleteOrganization", { archivedAt: new Date("2025-01-01T00:00:00.000Z") }],
    ] as Array<[string, string, string, Record<string, unknown>]>
  ).map(([event, name, operation, state]): Scenario => ({
    event,
    outcome: "success",
    name,
    run: (sink) => {
      const org = {
        id: ORGANIZATION_ID,
        status: "ACTIVE",
        archivedAt: null,
        legalHoldAt: null,
        legalHoldReference: null,
        deletedAt: null,
        ...state,
      };
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        organization: {
          findUnique: jest.fn().mockResolvedValue(org),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn().mockResolvedValue(org),
        },
        issuer: { count: jest.fn().mockResolvedValue(0) },
        apiKey: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
        webhook: {
          findMany: jest.fn().mockResolvedValue([{ id: "webhook_1" }]),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        webhookDelivery: { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) },
        idempotencyRecord: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        auditLog: sink.auditLog,
      };
      const prisma = {
        $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
      };
      const service = new OrganizationLifecycleService(prisma as never);

      switch (operation) {
        case "archive":
          return service.archive(ADMIN, ORGANIZATION_ID);
        case "restore":
          return service.restore(ADMIN, ORGANIZATION_ID);
        case "placeLegalHold":
          return service.placeLegalHold(ADMIN, ORGANIZATION_ID, "LEGAL-2026-001");
        case "releaseLegalHold":
          return service.releaseLegalHold(ADMIN, ORGANIZATION_ID);
        default:
          return service.deleteOrganization(ADMIN, ORGANIZATION_ID);
      }
    },
  })),
  {
    event: "operator.payment_classification_updated",
    outcome: "success",
    name: "reclassifying a payment",
    run: (sink) => {
      const payment = {
        id: "payment_1",
        classification: "UNCLASSIFIED",
        assetCode: "USDC",
        assetIssuer: null,
        isEligible: false,
      };
      const prisma = {
        payment: {
          findFirst: jest.fn().mockResolvedValue(payment),
          update: jest.fn().mockResolvedValue({
            ...payment,
            classification: "INCOME",
            operationId: "op_1",
            stellarTransactionHash: "c".repeat(64),
            sourceAddress: PAYER_ADDRESS,
            destinationAddress: PAYER_ADDRESS,
            occurredAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
            memo: null,
          }),
        },
        auditLog: sink.auditLog,
      };

      return new PaymentsService(
        prisma as never,
        {} as never,
        configDouble({ paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" }),
        {} as never,
      ).updateClassification({ id: USER_ID }, "payment_1", "INCOME" as never);
    },
  },
  {
    event: "operator.trusted_source_created",
    outcome: "success",
    name: "adding a trusted payer",
    run: (sink) => {
      const prisma = {
        trustedSource: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({
            id: "trusted_1",
            userId: USER_ID,
            sourceAddress: PAYER_ADDRESS,
            displayName: "Employer",
            sourceType: "stellar",
            issuerId: null,
            status: "ACTIVE",
            createdAt: new Date(),
            updatedAt: new Date(),
            issuer: null,
          }),
        },
        issuer: { findUnique: jest.fn() },
        auditLog: sink.auditLog,
      };

      return new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never).createTrustedSource(
        ADMIN,
        { sourceAddress: PAYER_ADDRESS, displayName: "Employer" } as never,
      );
    },
  },
  {
    event: "operator.trusted_source_updated",
    outcome: "success",
    name: "changing a trusted payer",
    run: (sink) => {
      const prisma = {
        trustedSource: {
          findFirst: jest.fn().mockResolvedValue({
            id: "trusted_1",
            displayName: "Employer",
            issuerId: null,
          }),
          update: jest.fn().mockResolvedValue({
            id: "trusted_1",
            userId: USER_ID,
            sourceAddress: PAYER_ADDRESS,
            displayName: "Main employer",
            sourceType: "stellar",
            issuerId: null,
            status: "ACTIVE",
            createdAt: new Date(),
            updatedAt: new Date(),
            issuer: null,
          }),
        },
        issuer: { findUnique: jest.fn() },
        auditLog: sink.auditLog,
      };

      return new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never).updateTrustedSource(
        ADMIN,
        "trusted_1",
        { displayName: "Main employer" } as never,
      );
    },
  },
  {
    event: "operator.trusted_source_deleted",
    outcome: "success",
    name: "removing a trusted payer",
    run: (sink) => {
      const prisma = {
        trustedSource: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: "trusted_1", sourceAddress: PAYER_ADDRESS }),
          update: jest.fn().mockResolvedValue({
            id: "trusted_1",
            status: "DELETED",
            issuer: null,
          }),
        },
        auditLog: sink.auditLog,
      };

      return new TrustedSourcesService(prisma as never, { reevaluateSource: jest.fn().mockResolvedValue(0) } as never).deleteTrustedSource(
        ADMIN,
        "trusted_1",
      );
    },
  },
  {
    event: "operator.user_status_changed",
    outcome: "success",
    name: "suspending an account",
    run: (sink) => {
      const tx = {
        user: {
          findUnique: jest.fn().mockResolvedValue({ status: "ACTIVE" }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({
            id: "user_target",
            displayName: null,
            role: "WORKER",
            status: "SUSPENDED",
            createdAt: new Date(),
            updatedAt: new Date(),
            lastLoginAt: null,
          }),
        },
        authSession: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
        auditLog: sink.auditLog,
      };
      const prisma = {
        $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
      };

      return new UsersService(prisma as never).changeStatus(ADMIN, "user_target", {
        status: "SUSPENDED",
        reason: "SECURITY_INCIDENT",
      } as never);
    },
  },
  {
    event: "operator.user_role_changed",
    outcome: "success",
    name: "changing an account's role",
    run: (sink) => {
      const tx = {
        user: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ role: "WORKER", status: "ACTIVE" }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({
            id: "user_target",
            displayName: null,
            role: "DEVELOPER",
            status: "ACTIVE",
            createdAt: new Date(),
            updatedAt: new Date(),
            lastLoginAt: null,
          }),
        },
        organization: { count: jest.fn().mockResolvedValue(0) },
        auditLog: sink.auditLog,
      };
      const prisma = {
        $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
      };

      return new UsersService(prisma as never).changeRole(ADMIN, "user_target", {
        role: "DEVELOPER",
      } as never);
    },
  },
  {
    event: "operator.payment_backfill_requested",
    outcome: "success",
    name: "requesting a payment backfill",
    run: (sink) => {
      const job = {
        id: "backfill_1",
        userId: "user_target",
        startLedger: 100,
        endLedger: 200,
        status: "PENDING",
        checkpointCursor: null,
        pagesProcessed: 0,
        recordsSeen: 0,
        paymentsCreated: 0,
        duplicatesSkipped: 0,
        attempts: 0,
        cancelRequestedAt: null,
        lastErrorSafe: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      };
      const prisma: Record<string, unknown> = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: "user_target" }]),
        paymentBackfillJob: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue(job),
        },
        auditLog: sink.auditLog,
      };
      prisma.$transaction = jest.fn((callback: (tx: unknown) => unknown) =>
        callback(prisma),
      );

      return new PaymentBackfillService(
        prisma as never,
        {} as never,
        configDouble({ paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" }),
      ).createJob(ADMIN, { userId: "user_target", startLedger: 100, endLedger: 200 });
    },
  },
  {
    event: "operator.payment_backfill_cancelled",
    outcome: "success",
    name: "cancelling a payment backfill",
    run: (sink) => {
      const job = {
        id: "backfill_1",
        userId: "user_target",
        startLedger: 100,
        endLedger: 200,
        status: "CANCELLED",
        checkpointCursor: null,
        pagesProcessed: 0,
        recordsSeen: 0,
        paymentsCreated: 0,
        duplicatesSkipped: 0,
        attempts: 0,
        cancelRequestedAt: new Date(),
        lastErrorSafe: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: new Date(),
      };
      const prisma: Record<string, unknown> = {
        paymentBackfillJob: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: "backfill_1", status: "PENDING" }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue(job),
        },
        auditLog: sink.auditLog,
      };
      prisma.$transaction = jest.fn((callback: (tx: unknown) => unknown) =>
        callback(prisma),
      );

      return new PaymentBackfillService(
        prisma as never,
        {} as never,
        configDouble({ paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" }),
      ).cancelJob(ADMIN, "backfill_1");
    },
  },
  // ------------------------------------------------------ authentication ---
  ...(
    [
      ["authentication.challenge_created", AuthEventType.CHALLENGE_CREATED, "success"],
      ["authentication.challenge_verified", AuthEventType.CHALLENGE_VERIFIED, "success"],
      ["authentication.signature_invalid", AuthEventType.SIGNATURE_INVALID, "denied"],
      ["authentication.challenge_expired", AuthEventType.CHALLENGE_EXPIRED, "denied"],
      ["authentication.challenge_replayed", AuthEventType.CHALLENGE_REPLAYED, "denied"],
      ["authentication.account_inactive", AuthEventType.ACCOUNT_INACTIVE, "denied"],
      ["authorization.rate_limited", AuthEventType.RATE_LIMITED, "denied"],
    ] as Array<[string, AuthEventType, AuditOutcome]>
  ).map(([event, eventType, outcome]): Scenario => ({
    event,
    outcome,
    name: `recording ${eventType}`,
    run: (sink) =>
      new AuthAuditService({
        authAuditEvent: sink.authAuditEvent,
      } as never).recordEvent(eventType, WALLET_ADDRESS, {
        challengeId: "challenge_1",
        success: outcome === "success",
        failureReason: outcome === "denied" ? "Invalid signature" : undefined,
        // A raw client fingerprint on the way in; only its hash may come out.
        clientMetadata: "203.0.113.7|Mozilla/5.0",
      }),
  })),
  // --------------------------------------------------------------- proof ---
  ...Object.values(VerificationOutcome).map((outcome): Scenario => ({
    event: "proof.verification_recorded",
    outcome: verificationOutcomeToAuditOutcome(outcome),
    name: `recording a ${outcome} verification`,
    run: (sink) =>
      new VerificationEventService(
        { verificationEventLog: sink.verificationEventLog } as never,
        configDouble({
          verificationEventRetentionDays: 90,
          verificationHashSaltVersion: 0,
          VERIFICATION_HASH_SALT_V0: "matrix-salt-v0",
        }),
      ).recordEvent(outcome, "proof_1", {
        requestId: "req_1",
        timestamp: new Date("2026-02-01T00:00:00.000Z"),
        outcome,
      }),
  })),
  {
    event: "proof.revoked",
    outcome: "success",
    name: "revoking a proof",
    run: (sink) => {
      const prisma = {
        proof: {
          findUnique: jest.fn().mockResolvedValue({
            id: "proof_1",
            userId: USER_ID,
            status: "ACTIVE",
            contractTransactionHash: null,
            revokedAt: null,
            revokedByType: null,
            revocationReasonCode: null,
            revocationReasonPrivate: null,
            revocationEvidenceHash: null,
          }),
        },
        $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
          callback({
            proof: {
              update: jest.fn().mockResolvedValue({
                id: "proof_1",
                status: "REVOKED",
                revokedAt: new Date("2026-02-01T00:00:00.000Z"),
                revokedByType: "OWNER",
                revocationReasonCode: "OWNER_REQUESTED",
                revocationReasonPrivate: null,
                revocationEvidenceHash: null,
              }),
            },
            auditLog: sink.auditLog,
            anchoringIntent: { create: jest.fn() },
          }),
        ),
      };

      return new ProofsService(
        prisma as never,
        configDouble({
          credentialSigningSecret: "matrix-signing-secret",
          "stellar.network": "testnet",
        }),
        { recordEvent: jest.fn() } as never,
      ).revokeProof(
        {
          id: USER_ID,
          walletAddress: "GTEST",
          walletHash: `sha256:${"b".repeat(64)}`,
          role: "WORKER",
        },
        "proof_1",
      );
    },
  },
  {
    event: "anchoring_intent.retried",
    outcome: "success",
    name: "retrying a quarantined anchoring intent",
    run: (sink) => {
      const prisma = {
        proof: {
          findFirst: jest.fn().mockResolvedValue({ id: "proof_1" }),
        },
        anchoringIntent: {
          findFirst: jest.fn().mockResolvedValue({
            id: "intent_1",
            proofId: "proof_1",
            status: "QUARANTINED",
            permanentError: true,
            attemptCount: 10,
            quarantineDecision: "PENDING",
          }),
        },
        $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
          callback({
            anchoringIntent: {
              update: jest.fn().mockResolvedValue({
                id: "intent_1",
                status: "PENDING",
                attemptCount: 10,
              }),
            },
            auditLog: sink.auditLog,
          }),
        ),
      };

      return new ProofsService(
        prisma as never,
        configDouble({
          credentialSigningSecret: "matrix-signing-secret",
          "stellar.network": "testnet",
        }),
        { recordEvent: jest.fn() } as never,
      ).retryProofAnchoring(
        {
          id: USER_ID,
          walletAddress: "GTEST",
          walletHash: `sha256:${"c".repeat(64)}`,
          role: "WORKER",
        },
        "proof_1",
        "intent_1",
      );
    },
  },
  {
    event: "anchoring_intent.abandoned",
    outcome: "success",
    name: "abandoning a quarantined anchoring intent",
    run: (sink) => {
      const prisma = {
        proof: {
          findFirst: jest.fn().mockResolvedValue({ id: "proof_1" }),
        },
        anchoringIntent: {
          findFirst: jest.fn().mockResolvedValue({
            id: "intent_1",
            proofId: "proof_1",
            status: "QUARANTINED",
            quarantineDecision: "PENDING",
          }),
        },
        $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
          callback({
            anchoringIntent: {
              update: jest.fn().mockResolvedValue({
                id: "intent_1",
                status: "QUARANTINED",
                quarantineDecision: "ABANDONED",
              }),
            },
            auditLog: sink.auditLog,
          }),
        ),
      };

      return new ProofsService(
        prisma as never,
        configDouble({
          credentialSigningSecret: "matrix-signing-secret",
          "stellar.network": "testnet",
        }),
        { recordEvent: jest.fn() } as never,
      ).abandonProofAnchoring(
        {
          id: USER_ID,
          walletAddress: "GTEST",
          walletHash: `sha256:${"d".repeat(64)}`,
          role: "WORKER",
        },
        "proof_1",
        "intent_1",
      );
    },
  },
];

/** The record a scenario produced, normalised across the three stores. */
interface ObservedEvent {
  readonly definition: AuditEventDefinition;
  readonly resolvedType: string | undefined;
  readonly actorType: string;
  readonly actorId: string | null | undefined;
  readonly tenant: unknown;
  readonly outcome: AuditOutcome;
  readonly metadata: Record<string, unknown>;
  readonly row: unknown;
}

/** Runs one scenario and normalises whatever it persisted. */
async function observe(scenario: Scenario): Promise<ObservedEvent> {
  const sink = createSink();
  await scenario.run(sink);

  const definition = auditEvent(scenario.event);
  const written =
    sink.auditLogs.length + sink.authEvents.length + sink.verificationEvents.length;

  if (written !== 1) {
    throw new Error(
      `${scenario.event}: expected exactly one audit record, saw ${written}`,
    );
  }

  if (definition.store === "audit_log") {
    const row = sink.auditLogs[0];
    return {
      definition,
      resolvedType: resolveAuditEventType(row),
      actorType: normalizeAuditActorType(row.actorType),
      actorId: row.actorId,
      tenant:
        definition.tenant === "resource_id"
          ? row.resourceId
          : definition.tenant === "actor_id"
            ? row.actorId
            : (row.metadata as Record<string, unknown> | undefined)?.organizationId,
      outcome: "success",
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      row,
    };
  }

  if (definition.store === "auth_audit_event") {
    const row = sink.authEvents[0];
    return {
      definition,
      resolvedType: resolveAuthAuditEventType(row.eventType),
      actorType: "wallet",
      actorId: row.walletHash,
      tenant: row.walletHash,
      outcome: row.success ? "success" : "denied",
      metadata: {},
      row,
    };
  }

  const row = sink.verificationEvents[0];
  return {
    definition,
    resolvedType: "proof.verification_recorded",
    actorType: "system",
    actorId: null,
    tenant: row.proofId,
    outcome: verificationOutcomeToAuditOutcome(row.outcome),
    metadata: {},
    row,
  };
}

describe("audit event matrix", () => {
  describe.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    "%s",
    (_name, scenario) => {
      let observed: ObservedEvent;

      beforeAll(async () => {
        observed = await observe(scenario);
      });

      it("persists the declared stable event type", () => {
        expect(observed.resolvedType).toBe(scenario.event);
      });

      it("records an actor the taxonomy allows", () => {
        // Compared through `normalizeAuditActorType`: the store holds both
        // "User" and "user" for the same principal, which the taxonomy folds
        // together rather than pretending is two actor types.
        expect(observed.definition.actorTypes).toContain(observed.actorType);
        // An empty-string actor is worse than a null one: it reads as "recorded"
        // while identifying nobody.
        expect(observed.actorId).not.toBe("");
      });

      it("records the outcome the scenario exercised", () => {
        expect(observed.outcome).toBe(scenario.outcome);
        expect(observed.definition.outcomes).toContain(scenario.outcome);
      });

      it("records tenant context", () => {
        expect(observed.tenant).toEqual(expect.any(String));
        expect(observed.tenant).not.toBe("");
      });

      it("carries the metadata the taxonomy requires", () => {
        for (const key of observed.definition.requiredMetadata) {
          expect(Object.keys(observed.metadata)).toContain(key);
        }
      });

      it("contains no forbidden field", () => {
        expect(
          findForbiddenAuditContent(observed.row, {
            publicIdentifierFields: observed.definition.publicIdentifierFields,
          }),
        ).toEqual([]);
      });
    },
  );

  it("covers every declared event", () => {
    const exercised = new Set(scenarios.map((scenario) => scenario.event));
    const declared = AUDIT_EVENTS.map((event) => event.type);

    expect(declared.filter((type) => !exercised.has(type))).toEqual([]);
  });

  it("covers every required domain", () => {
    const exercised = new Set(
      scenarios.map((scenario) => auditEvent(scenario.event).domain),
    );

    expect(
      REQUIRED_AUDIT_DOMAINS.filter((domain) => !exercised.has(domain)),
    ).toEqual([]);
  });

  it("exercises both a success and a denied outcome", () => {
    const outcomes = new Set(scenarios.map((scenario) => scenario.outcome));

    expect([...outcomes].sort()).toEqual(["denied", "success"]);
  });
});

describe("audit write failure behaviour", () => {
  const failing = (scenario: Scenario) => scenario.run(createSink({ failing: true }));

  const byBehaviour = (behaviour: "fail_closed" | "fail_open") =>
    scenarios.filter(
      (scenario) => auditEvent(scenario.event).writeFailure === behaviour,
    );

  describe.each(
    byBehaviour("fail_closed").map((scenario) => [scenario.name, scenario] as const),
  )("%s (fail-closed)", (_name, scenario) => {
    it("fails the mutation when the audit write fails", async () => {
      // The mutation has already touched the domain tables at this point. The
      // error is what makes the caller — and the surrounding transaction, in
      // production — treat the action as not having happened.
      await expect(failing(scenario)).rejects.toThrow("audit store unavailable");
    });
  });

  describe.each(
    byBehaviour("fail_open").map((scenario) => [scenario.name, scenario] as const),
  )("%s (fail-open)", (_name, scenario) => {
    it("completes the request when the audit write fails", async () => {
      // Availability wins here by design: an audit outage on an unauthenticated
      // path must not become an authentication outage.
      await expect(failing(scenario)).resolves.not.toThrow();
    });
  });
});

describe("authentication audit redaction", () => {
  it("stores a wallet hash and never the wallet address", async () => {
    const sink = createSink();

    await new AuthAuditService({
      authAuditEvent: sink.authAuditEvent,
    } as never).recordEvent(AuthEventType.CHALLENGE_VERIFIED, WALLET_ADDRESS, {
      success: true,
      clientMetadata: "203.0.113.7|Mozilla/5.0",
    });

    const [event] = sink.authEvents;
    const serialised = JSON.stringify(event);

    expect(event.walletHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(serialised).not.toContain(WALLET_ADDRESS);
    expect(serialised).not.toContain("203.0.113.7");
    expect(serialised).not.toContain("Mozilla");
  });

  it("stores a client fingerprint only as a hash", async () => {
    const sink = createSink();

    await new AuthAuditService({
      authAuditEvent: sink.authAuditEvent,
    } as never).recordEvent(AuthEventType.RATE_LIMITED, WALLET_ADDRESS, {
      success: false,
      failureReason: "Verification rate limit exceeded",
      clientMetadata: "203.0.113.7|Mozilla/5.0",
    });

    expect(sink.authEvents[0].clientMetadataHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe("verification audit redaction", () => {
  it("keeps only an outcome, a proof reference and a salted metadata hash", async () => {
    const sink = createSink();

    await new VerificationEventService(
      { verificationEventLog: sink.verificationEventLog } as never,
      configDouble({
        verificationEventRetentionDays: 90,
        verificationHashSaltVersion: 0,
        VERIFICATION_HASH_SALT_V0: "matrix-salt-v0",
      }),
    ).recordEvent(VerificationOutcome.VALID, "proof_1", {
      requestId: "req_1",
      timestamp: new Date("2026-02-01T00:00:00.000Z"),
      outcome: "VALID",
    });

    const [event] = sink.verificationEvents;

    expect(event.metadataHash).toMatch(/^[a-f0-9]{64}$/);
    // The salt version travels with the row so a rotated salt does not make old
    // rows unattributable to a hashing scheme.
    expect(event.saltVersion).toBe(0);
    expect(Object.keys(event).sort()).toEqual([
      "createdAt",
      "metadataHash",
      "outcome",
      "proofId",
      "retainUntil",
      "saltVersion",
    ]);
  });
});
