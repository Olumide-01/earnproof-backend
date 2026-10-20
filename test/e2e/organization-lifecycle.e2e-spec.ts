import { ApiKeyScope, ResourceStatus, UserRole } from "@prisma/client";
import * as request from "supertest";
import { ApiKeyService } from "../../src/api-keys/api-key.service";
import { integrationDatabase } from "../integration/harness/database";
import { seedOrganization, seedPayment, seedWebhook } from "../integration/harness/fixtures";
import { e2eApp } from "./harness/app";
import { AuthenticatedClient, authenticateNewWallet } from "./harness/wallet-auth";

const db = integrationDatabase();
const e2e = e2eApp();

const DAY = 24 * 60 * 60 * 1000;
const AUTH_CONTEXT = "/api/v1/integrations/auth-context";

async function newAdmin(): Promise<AuthenticatedClient> {
  const admin = await authenticateNewWallet(e2e.httpServer);
  await db.prisma.user.update({ where: { id: admin.userId }, data: { role: UserRole.ADMIN } });
  return admin;
}

const as = (client: AuthenticatedClient) => ({ Authorization: `Bearer ${client.token}` });

function lifecycle(client: AuthenticatedClient, method: "post" | "put" | "delete" | "get", path: string) {
  return request(e2e.httpServer)[method](`/api/v1/organizations/${path}`).set(as(client));
}

async function organizationWithKey(owner: AuthenticatedClient, seed: string) {
  const organization = await seedOrganization(db.prisma, seed, owner.userId);
  await db.prisma.organization.update({
    where: { id: organization.id },
    data: { status: ResourceStatus.ACTIVE },
  });
  const key = await e2e.app.get(ApiKeyService).createKey({
    organizationId: organization.id,
    createdBy: owner.userId,
    name: `${seed}-key`,
    scopes: [ApiKeyScope.ORG_READ],
  });
  return { organization, key };
}

function authContext(secret: string, organizationId: string) {
  return request(e2e.httpServer)
    .get(AUTH_CONTEXT)
    .set("Authorization", `Bearer ${secret}`)
    .set("X-Organization-Id", organizationId);
}

/** Moves the archive marker into the past, as if the minimum period had elapsed. */
async function ageArchive(organizationId: string, days: number) {
  await db.prisma.organization.update({
    where: { id: organizationId },
    data: { archivedAt: new Date(Date.now() - days * DAY) },
  });
}

describe("organization archival and deletion (e2e)", () => {
  it("archive disables privileged operations atomically and restore brings them back", async () => {
    const admin = await newAdmin();
    const { organization, key } = await organizationWithKey(admin, "archive-cycle");

    await authContext(key.secret, organization.id).expect(200);

    const archived = await lifecycle(admin, "post", `${organization.id}/archive`).expect(200);
    expect(archived.body).toMatchObject({
      lifecycleState: "ARCHIVED",
      status: "ACTIVE",
      legalHold: false,
    });

    // The key stops authenticating on the very next request.
    await authContext(key.secret, organization.id).expect(401);
    // New credentials cannot be minted and the profile is frozen.
    await request(e2e.httpServer)
      .post("/api/v1/api-keys")
      .set(as(admin))
      .send({ organizationId: organization.id, name: "blocked", scopes: ["ORG_READ"] })
      .expect(409);
    await request(e2e.httpServer)
      .patch(`/api/v1/organizations/${organization.id}`)
      .set(as(admin))
      .send({ name: "Renamed" })
      .expect(409);
    // Keys can still be listed so the tenant can be wound down.
    await request(e2e.httpServer)
      .get("/api/v1/api-keys")
      .query({ organizationId: organization.id })
      .set(as(admin))
      .expect(200);

    await lifecycle(admin, "post", `${organization.id}/archive`).expect(409);

    await lifecycle(admin, "post", `${organization.id}/restore`)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ lifecycleState: "LIVE", status: "ACTIVE" }));

    // Nothing was revoked, so restore is lossless.
    await authContext(key.secret, organization.id).expect(200);
    await lifecycle(admin, "post", `${organization.id}/restore`).expect(409);

    const audit = await db.prisma.auditLog.findMany({
      where: { resourceId: organization.id, resourceType: "Organization" },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((row) => row.action)).toEqual([
      "organization.archived",
      "organization.restored",
    ]);
  });

  it("reports blockers as codes and counts, and deletion cannot bypass them", async () => {
    const admin = await newAdmin();
    const { organization } = await organizationWithKey(admin, "blocked-delete");
    const issuer = await db.prisma.issuer.create({
      data: {
        organizationId: organization.id,
        stellarAddress: "GBLOCKEDISSUERSYNTHETICADDRESSXXXXXXXXXXXXXXXXXXXXXXXXX",
        status: ResourceStatus.ACTIVE,
        contractSyncedStatus: ResourceStatus.ACTIVE,
      },
    });

    // Live: not archived.
    await lifecycle(admin, "get", `${organization.id}/deletion-eligibility`)
      .expect(200)
      .expect(({ body }) =>
        expect(body.blockers).toEqual([
          { code: "NOT_ARCHIVED" },
          { code: "ACTIVE_ISSUERS", count: 1 },
        ]),
      );
    await lifecycle(admin, "delete", organization.id).expect(409);

    // Archived, but inside the minimum archive period, with a legal hold.
    await lifecycle(admin, "post", `${organization.id}/archive`).expect(200);
    await lifecycle(admin, "put", `${organization.id}/legal-hold`)
      .send({ reference: "LEGAL-2026-014" })
      .expect(200)
      .expect(({ body }) => expect(body.legalHold).toBe(true));
    await lifecycle(admin, "put", `${organization.id}/legal-hold`)
      .send({ reference: "LEGAL-2026-015" })
      .expect(409);

    const report = await lifecycle(admin, "get", `${organization.id}/deletion-eligibility`).expect(200);
    expect(report.body).toMatchObject({
      lifecycleState: "ARCHIVED",
      eligible: false,
      blockers: [
        { code: "ARCHIVE_RETENTION_PERIOD" },
        { code: "LEGAL_HOLD" },
        { code: "ACTIVE_ISSUERS", count: 1 },
      ],
    });
    const serialised = JSON.stringify(report.body);
    expect(serialised).not.toContain(issuer.id);
    expect(serialised).not.toContain(issuer.stellarAddress);
    expect(serialised).not.toContain("LEGAL-2026-014");

    await ageArchive(organization.id, 31);
    await lifecycle(admin, "delete", organization.id)
      .expect(409)
      .expect(({ body }) => expect(body.message).toBe(
        "Organization cannot be deleted: LEGAL_HOLD, ACTIVE_ISSUERS",
      ));

    await lifecycle(admin, "delete", `${organization.id}/legal-hold`).expect(200);
    await lifecycle(admin, "delete", `${organization.id}/legal-hold`).expect(409);

    // Revoked locally, but the registry still says ACTIVE.
    await db.prisma.issuer.update({
      where: { id: issuer.id },
      data: { status: ResourceStatus.REVOKED },
    });
    await lifecycle(admin, "delete", organization.id)
      .expect(409)
      .expect(({ body }) =>
        expect(body.message).toBe("Organization cannot be deleted: ISSUER_REGISTRY_OUT_OF_SYNC"),
      );

    expect(
      (await db.prisma.organization.findUniqueOrThrow({ where: { id: organization.id } })).deletedAt,
    ).toBeNull();
  });

  it("deletes an eligible organization into a tombstone while historical verification keeps working", async () => {
    const admin = await newAdmin();
    const { organization, key } = await organizationWithKey(admin, "deletable");
    const issuer = await db.prisma.issuer.create({
      data: {
        organizationId: organization.id,
        stellarAddress: "GRETIREDISSUERSYNTHETICADDRESSXXXXXXXXXXXXXXXXXXXXXXXXX",
        status: ResourceStatus.REVOKED,
        contractSyncedStatus: ResourceStatus.REVOKED,
      },
    });
    const attestation = await db.prisma.attestation.create({
      data: {
        issuerId: issuer.id,
        subjectWalletHash: `sha256:${"c".repeat(64)}`,
        type: "PAYMENT",
        signedPayload: {},
      },
    });
    await seedWebhook(db.prisma, "deletable-hook", organization.id);

    // A proof issued before retirement, verified publicly afterwards.
    const worker = await authenticateNewWallet(e2e.httpServer);
    const { row: payment } = await seedPayment(db.prisma, "deletable-proof", worker.userId, {
      amount: "1000.0000000",
      occurredAt: new Date("2025-01-15T00:00:00.000Z"),
    });
    const proof = await request(e2e.httpServer)
      .post("/api/v1/proofs/minimum-income")
      .set(as(worker))
      .send({
        selectedPaymentIds: [payment.id],
        thresholdAmount: "500.0000000",
        assetCode: payment.assetCode,
        assetIssuer: payment.assetIssuer,
        periodStart: "2025-01-01T00:00:00.000Z",
        periodEnd: "2025-01-31T23:59:59.000Z",
      })
      .expect(201);

    await lifecycle(admin, "post", `${organization.id}/archive`).expect(200);
    await ageArchive(organization.id, 31);
    await lifecycle(admin, "get", `${organization.id}/deletion-eligibility`)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ eligible: true, blockers: [] }));

    const deleted = await lifecycle(admin, "delete", organization.id).expect(200);
    expect(deleted.body).toMatchObject({
      lifecycleState: "DELETED",
      status: "DELETED",
      apiKeysRevoked: 1,
      webhooksDeleted: 1,
    });

    const tombstone = await db.prisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(tombstone).toMatchObject({ name: "Deleted organization", website: null, slug: organization.slug });
    expect(await db.prisma.webhook.count({ where: { organizationId: organization.id } })).toBe(0);
    expect(
      (await db.prisma.apiKey.findFirstOrThrow({ where: { organizationId: organization.id } })).status,
    ).toBe(ResourceStatus.REVOKED);
    await authContext(key.secret, organization.id).expect(401);

    // Evidence survives: the issuer, its attestation, and the proof's verification.
    expect(await db.prisma.issuer.findUnique({ where: { id: issuer.id } })).not.toBeNull();
    expect(
      (await db.prisma.attestation.findUniqueOrThrow({ where: { id: attestation.id } })).status,
    ).toBe(ResourceStatus.ACTIVE);
    await request(e2e.httpServer)
      .get(`/api/v1/proofs/${proof.body.proofId}/verify`)
      .expect(200)
      .expect(({ body }) => expect(body.result).toBe("VALID"));

    // Deleted is terminal.
    await lifecycle(admin, "delete", organization.id).expect(409);
    await lifecycle(admin, "post", `${organization.id}/restore`).expect(409);
    await lifecycle(admin, "put", `${organization.id}/legal-hold`).send({ reference: "LATE-1" }).expect(409);
    await request(e2e.httpServer)
      .get(`/api/v1/organizations/${organization.id}`)
      .set(as(admin))
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ lifecycleState: "DELETED", status: "DELETED" }));

    const audit = await db.prisma.auditLog.findFirstOrThrow({
      where: { resourceId: organization.id, action: "organization.deleted" },
    });
    expect(audit.metadata).toMatchObject({ previousStatus: "ACTIVE", apiKeysRevoked: 1, webhooksDeleted: 1 });
  });

  it("refuses every lifecycle route to non-admins, including the organization's creator", async () => {
    const admin = await newAdmin();
    const creator = await authenticateNewWallet(e2e.httpServer);
    await db.prisma.user.update({ where: { id: creator.userId }, data: { role: UserRole.DEVELOPER } });
    const organization = await seedOrganization(db.prisma, "creator-owned", creator.userId);

    for (const [method, path] of [
      ["post", `${organization.id}/archive`],
      ["post", `${organization.id}/restore`],
      ["put", `${organization.id}/legal-hold`],
      ["delete", `${organization.id}/legal-hold`],
      ["get", `${organization.id}/deletion-eligibility`],
      ["delete", organization.id],
    ] as const) {
      await lifecycle(creator, method, path).send({ reference: "LEGAL-1" }).expect(403);
      await request(e2e.httpServer)[method](`/api/v1/organizations/${path}`).expect(401);
    }

    await lifecycle(admin, "post", "org_does_not_exist/archive").expect(404);
    await lifecycle(admin, "get", "org_does_not_exist/deletion-eligibility").expect(404);
    await lifecycle(admin, "delete", "org_does_not_exist").expect(404);
    expect(
      (await db.prisma.organization.findUniqueOrThrow({ where: { id: organization.id } })).archivedAt,
    ).toBeNull();
  });

  it("lets exactly one of two concurrent archives succeed", async () => {
    const admin = await newAdmin();
    const { organization } = await organizationWithKey(admin, "archive-race");

    const statuses = (
      await Promise.all([
        lifecycle(admin, "post", `${organization.id}/archive`),
        lifecycle(admin, "post", `${organization.id}/archive`),
      ])
    )
      .map((response) => response.status)
      .sort();

    expect(statuses).toEqual([200, 409]);
    expect(
      await db.prisma.auditLog.count({
        where: { resourceId: organization.id, action: "organization.archived" },
      }),
    ).toBe(1);
  });

  it("never lets a deletion and a concurrent legal hold both succeed", async () => {
    const admin = await newAdmin();
    const { organization } = await organizationWithKey(admin, "hold-race");
    await lifecycle(admin, "post", `${organization.id}/archive`).expect(200);
    await ageArchive(organization.id, 31);

    const [deletion, hold] = await Promise.all([
      lifecycle(admin, "delete", organization.id),
      lifecycle(admin, "put", `${organization.id}/legal-hold`).send({ reference: "RACE-1" }),
    ]);

    expect([deletion.status, hold.status].sort()).toEqual([200, 409]);
    const row = await db.prisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
    if (deletion.status === 200) {
      expect(row.legalHoldAt).toBeNull();
    } else {
      expect(row.deletedAt).toBeNull();
      expect(row.legalHoldAt).not.toBeNull();
    }
  });

  it("validates the legal hold reference", async () => {
    const admin = await newAdmin();
    const organization = await seedOrganization(db.prisma, "hold-validation", admin.userId);

    await lifecycle(admin, "put", `${organization.id}/legal-hold`)
      .send({ reference: "counsel@example.com" })
      .expect(422);
    await lifecycle(admin, "put", `${organization.id}/legal-hold`).send({}).expect(422);
  });
});
