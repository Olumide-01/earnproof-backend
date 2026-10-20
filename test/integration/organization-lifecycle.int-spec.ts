import { ApiKeyScope, ResourceStatus } from "@prisma/client";
import { AuthenticatedUser } from "../../src/auth/auth.types";
import { Clock, SystemClock } from "../../src/common/time/clock";
import { ApiKeyService } from "../../src/api-keys/api-key.service";
import { OrganizationLifecycleService } from "../../src/organizations/organization-lifecycle.service";
import { integrationDatabase } from "./harness/database";
import {
  race,
  seedDelivery,
  seedOrganization,
  seedUser,
  seedWebhook,
} from "./harness/fixtures";
import { integrationModule } from "./harness/nest";

/**
 * The organization lifecycle against real PostgreSQL.
 *
 * Covers what a mock cannot: the columns and index the migration adds, the
 * foreign-key order of the deletion cleanup (deliveries before webhooks,
 * issuers and attestations kept behind a tombstone), and the conditional
 * writes that make concurrent transitions exclusive.
 */

const db = integrationDatabase();
const injector = integrationModule([
  OrganizationLifecycleService,
  ApiKeyService,
  { provide: Clock, useClass: SystemClock },
]);

const lifecycle = () => injector.get(OrganizationLifecycleService);
const DAY = 24 * 60 * 60 * 1000;

async function admin(seed: string): Promise<AuthenticatedUser> {
  const user = await seedUser(db.prisma, seed, { role: "ADMIN" });
  return {
    id: user.id,
    walletAddress: user.walletAddress,
    walletHash: user.walletHash,
    role: user.role,
  };
}

describe("organization lifecycle schema", () => {
  it("adds nullable lifecycle columns, so every existing organization starts LIVE", async () => {
    const columns = await db.prisma.$queryRaw<
      Array<{ column_name: string; is_nullable: string; data_type: string }>
    >`
      SELECT column_name, is_nullable, data_type
        FROM information_schema.columns
       WHERE table_name = 'Organization'
         AND column_name IN ('archivedAt', 'legalHoldAt', 'legalHoldReference', 'deletedAt')
       ORDER BY column_name`;

    expect(columns).toEqual([
      { column_name: "archivedAt", is_nullable: "YES", data_type: "timestamp without time zone" },
      { column_name: "deletedAt", is_nullable: "YES", data_type: "timestamp without time zone" },
      { column_name: "legalHoldAt", is_nullable: "YES", data_type: "timestamp without time zone" },
      { column_name: "legalHoldReference", is_nullable: "YES", data_type: "character varying" },
    ]);

    const owner = await seedUser(db.prisma, "schema-owner");
    const organization = await seedOrganization(db.prisma, "schema-org", owner.id);
    expect(organization).toMatchObject({
      archivedAt: null,
      legalHoldAt: null,
      legalHoldReference: null,
      deletedAt: null,
    });
  });

  it("indexes archivedAt for the archive retention window", async () => {
    const indexes = await db.prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'Organization'`;

    expect(indexes.map((row) => row.indexname)).toContain("Organization_archivedAt_idx");
  });

  it("bounds the legal hold reference at 64 characters", async () => {
    const owner = await seedUser(db.prisma, "bounded-owner");
    const organization = await seedOrganization(db.prisma, "bounded-org", owner.id);

    await expect(
      db.prisma.organization.update({
        where: { id: organization.id },
        data: { legalHoldReference: "x".repeat(65) },
      }),
    ).rejects.toThrow();
  });
});

describe("organization lifecycle states", () => {
  it("moves LIVE -> ARCHIVED -> LIVE -> ARCHIVED -> DELETED and keeps evidence", async () => {
    const actor = await admin("lifecycle-admin");
    const organization = await seedOrganization(db.prisma, "lifecycle-org", actor.id);
    const issuer = await db.prisma.issuer.create({
      data: {
        organizationId: organization.id,
        stellarAddress: "GLIFECYCLEISSUERSYNTHETICADDRESSXXXXXXXXXXXXXXXXXXXXXXX",
        status: ResourceStatus.REVOKED,
        contractSyncedStatus: ResourceStatus.REVOKED,
      },
    });
    await db.prisma.attestation.create({
      data: {
        issuerId: issuer.id,
        subjectWalletHash: `sha256:${"d".repeat(64)}`,
        type: "PAYMENT",
        signedPayload: {},
      },
    });
    await injector.get(ApiKeyService).createKey({
      organizationId: organization.id,
      createdBy: actor.id,
      name: "lifecycle-key",
      scopes: [ApiKeyScope.ORG_READ],
    });
    const webhook = await seedWebhook(db.prisma, "lifecycle-hook", organization.id);
    await seedDelivery(db.prisma, "lifecycle-delivery", webhook.id);
    await db.prisma.idempotencyRecord.create({
      data: {
        organizationId: organization.id,
        idempotencyKey: "lifecycle-key-1",
        requestFingerprint: "fingerprint",
        expiresAt: new Date(Date.now() + DAY),
      },
    });

    await expect(lifecycle().archive(actor, organization.id)).resolves.toMatchObject({
      lifecycleState: "ARCHIVED",
    });
    await expect(lifecycle().restore(actor, organization.id)).resolves.toMatchObject({
      lifecycleState: "LIVE",
    });
    await lifecycle().archive(actor, organization.id);
    await db.prisma.organization.update({
      where: { id: organization.id },
      data: { archivedAt: new Date(Date.now() - 31 * DAY) },
    });

    await expect(lifecycle().deleteOrganization(actor, organization.id)).resolves.toMatchObject({
      lifecycleState: "DELETED",
      apiKeysRevoked: 1,
      webhooksDeleted: 1,
      webhookDeliveriesDeleted: 1,
      idempotencyRecordsDeleted: 1,
    });

    expect(await db.prisma.webhookDelivery.count()).toBe(0);
    expect(await db.prisma.idempotencyRecord.count()).toBe(0);
    expect(await db.prisma.issuer.count({ where: { organizationId: organization.id } })).toBe(1);
    expect(await db.prisma.attestation.count({ where: { issuerId: issuer.id } })).toBe(1);
    expect(
      await db.prisma.auditLog.findMany({
        where: { resourceId: organization.id, resourceType: "Organization" },
        orderBy: { createdAt: "asc" },
        select: { action: true },
      }),
    ).toEqual([
      { action: "organization.archived" },
      { action: "organization.restored" },
      { action: "organization.archived" },
      { action: "organization.deleted" },
    ]);
  });

  it("leaves nothing behind when deletion is refused", async () => {
    const actor = await admin("refused-admin");
    const organization = await seedOrganization(db.prisma, "refused-org", actor.id);
    await injector.get(ApiKeyService).createKey({
      organizationId: organization.id,
      createdBy: actor.id,
      name: "refused-key",
    });
    await lifecycle().archive(actor, organization.id);

    await expect(lifecycle().deleteOrganization(actor, organization.id)).rejects.toThrow(
      "ARCHIVE_RETENTION_PERIOD",
    );

    const key = await db.prisma.apiKey.findFirstOrThrow({ where: { organizationId: organization.id } });
    expect(key.status).toBe(ResourceStatus.ACTIVE);
    expect(
      await db.prisma.auditLog.count({ where: { action: "organization.deleted" } }),
    ).toBe(0);
  });

  it("serialises concurrent deletions: one succeeds, one is refused", async () => {
    const actor = await admin("race-admin");
    const organization = await seedOrganization(db.prisma, "race-org", actor.id);
    await lifecycle().archive(actor, organization.id);
    await db.prisma.organization.update({
      where: { id: organization.id },
      data: { archivedAt: new Date(Date.now() - 31 * DAY) },
    });

    const { fulfilled, rejected } = await race([
      lifecycle().deleteOrganization(actor, organization.id),
      lifecycle().deleteOrganization(actor, organization.id),
    ]);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      await db.prisma.auditLog.count({ where: { action: "organization.deleted" } }),
    ).toBe(1);
  });
});
