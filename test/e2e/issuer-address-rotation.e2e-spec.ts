import { INestApplication, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { ResourceStatus, UserRole } from "@prisma/client";
import { Keypair } from "@stellar/stellar-base";
import * as request from "supertest";
import { AuthModule } from "../../src/auth/auth.module";
import { configureApp } from "../../src/bootstrap";
import { configuration } from "../../src/config/configuration";
import { validateEnv } from "../../src/config/env.validation";
import { DatabaseModule } from "../../src/database/database.module";
import {
  IssuerRegistryAddressRead,
  IssuerRegistryRotationResult,
  IssuerRegistryService,
} from "../../src/issuers/issuer-registry.service";
import { IssuersModule } from "../../src/issuers/issuers.module";
import { withDeadline } from "../integration/harness/bounded";
import { integrationConfig } from "../integration/harness/config";
import { integrationDatabase } from "../integration/harness/database";
import { seedOrganization } from "../integration/harness/fixtures";
import { AuthenticatedClient, authenticateNewWallet } from "./harness/wallet-auth";

/**
 * Issuer address rotation over the real HTTP pipeline and real PostgreSQL.
 *
 * Only the issuer registry contract is simulated. It follows the contract's
 * own rules for `rotate_issuer_address` and can be told to fail, or to time
 * out after applying the change, so chain failure and reconciliation are
 * exercised end to end.
 */

const contract = {
  addresses: new Map<string, string>(),
  submissions: 0,
  mode: "normal" as "normal" | "reject" | "timeout-after-apply",
  isConfigured: true,
  async readIssuerAddress(issuerId: string): Promise<IssuerRegistryAddressRead> {
    const current = this.addresses.get(issuerId);
    return current ? { state: "found", issuerAddress: current } : { state: "failed", error: "IssuerNotFound" };
  },
  async rotateIssuerAddress(issuerId: string, newAddress: string): Promise<IssuerRegistryRotationResult> {
    this.submissions += 1;
    if (this.mode === "reject") return { state: "failed", error: "rejected" };
    this.addresses.set(issuerId, newAddress);
    if (this.mode === "timeout-after-apply") return { state: "failed", error: "timed out" };
    return { state: "submitted", transactionHash: "a".repeat(64) };
  },
};

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate: validateEnv }),
    DatabaseModule,
    AuthModule,
    IssuersModule,
  ],
})
class IssuerRotationE2eModule {}

const db = integrationDatabase();
let app: INestApplication;

beforeAll(async () => {
  const config = integrationConfig();
  const moduleRef = await withDeadline("Creating the issuer rotation e2e module", config.adminTimeoutMs, () =>
    Test.createTestingModule({ imports: [IssuerRotationE2eModule] })
      .overrideProvider(IssuerRegistryService)
      .useValue(contract)
      .compile(),
  );
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { corsOrigin: "http://localhost:3000" });
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  contract.addresses.clear();
  contract.submissions = 0;
  contract.mode = "normal";
});

const server = () => app.getHttpServer();
const address = (seed: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey();

async function newAdmin(): Promise<AuthenticatedClient> {
  const admin = await authenticateNewWallet(server());
  await db.prisma.user.update({ where: { id: admin.userId }, data: { role: UserRole.ADMIN } });
  return admin;
}

async function registeredIssuer(admin: AuthenticatedClient, seed: number) {
  const organization = await seedOrganization(db.prisma, `rotation-${seed}`, admin.userId);
  const issuer = await db.prisma.issuer.create({
    data: {
      organizationId: organization.id,
      stellarAddress: address(seed),
      status: ResourceStatus.ACTIVE,
      contractSyncedStatus: ResourceStatus.ACTIVE,
    },
  });
  contract.addresses.set(issuer.id, issuer.stellarAddress);
  return issuer;
}

const rotate = (admin: AuthenticatedClient, issuerId: string, body: Record<string, unknown>) =>
  request(server())
    .post(`/api/v1/issuers/${issuerId}/address-rotations`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send(body);

async function adminView(admin: AuthenticatedClient, issuerId: string) {
  const response = await request(server())
    .get(`/api/v1/issuers/admin/${issuerId}`)
    .set("Authorization", `Bearer ${admin.token}`)
    .expect(200);
  return response.body as { stellarAddress: string; revision: number };
}

describe("issuer address rotation (e2e)", () => {
  it("rotates after the contract confirms and preserves the previous address", async () => {
    const admin = await newAdmin();
    const issuer = await registeredIssuer(admin, 71);
    const { revision } = await adminView(admin, issuer.id);

    const response = await rotate(admin, issuer.id, {
      newStellarAddress: address(72),
      expectedRevision: revision,
    }).expect(202);

    expect(response.body).toMatchObject({ status: "CONFIRMED", fromAddress: address(71), toAddress: address(72) });
    expect(await adminView(admin, issuer.id)).toMatchObject({
      stellarAddress: address(72),
      revision: revision + 2,
    });

    const listing = await request(server())
      .get(`/api/v1/issuers/${issuer.id}/address-rotations`)
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    expect(listing.body.addressHistory).toEqual([
      expect.objectContaining({ stellarAddress: address(71), rotationId: response.body.id }),
    ]);
    expect(
      await db.prisma.auditLog.findMany({
        where: { resourceId: response.body.id },
        select: { action: true },
        orderBy: { createdAt: "asc" },
      }),
    ).toEqual([
      { action: "issuer.address_rotation.requested" },
      { action: "issuer.address_rotation.confirmed" },
    ]);
  });

  it("keeps the database on the old address through a chain failure, then reconciles", async () => {
    const admin = await newAdmin();
    const issuer = await registeredIssuer(admin, 73);
    contract.mode = "reject";

    const pending = await rotate(admin, issuer.id, {
      newStellarAddress: address(74),
      expectedRevision: 0,
    }).expect(202);

    expect(pending.body).toMatchObject({ status: "PENDING", lastError: "submission_failed" });
    expect((await adminView(admin, issuer.id)).stellarAddress).toBe(address(73));

    contract.mode = "normal";
    await request(server())
      .post(`/api/v1/issuers/${issuer.id}/address-rotations/${pending.body.id}/reconcile`)
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200)
      .expect(({ body }) => expect(body.status).toBe("CONFIRMED"));
    expect((await adminView(admin, issuer.id)).stellarAddress).toBe(address(74));
  });

  it("finalizes a timed-out submission that landed, without resubmitting", async () => {
    const admin = await newAdmin();
    const issuer = await registeredIssuer(admin, 75);
    contract.mode = "timeout-after-apply";

    const pending = await rotate(admin, issuer.id, {
      newStellarAddress: address(76),
      expectedRevision: 0,
    }).expect(202);
    expect(pending.body.status).toBe("PENDING");
    expect((await adminView(admin, issuer.id)).stellarAddress).toBe(address(75));

    contract.mode = "normal";
    await request(server())
      .post(`/api/v1/issuers/${issuer.id}/address-rotations/${pending.body.id}/reconcile`)
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200)
      .expect(({ body }) => expect(body.status).toBe("CONFIRMED"));
    expect(contract.submissions).toBe(1);
  });

  it("rejects stale revisions and conflicting registrations", async () => {
    const admin = await newAdmin();
    const issuer = await registeredIssuer(admin, 77);
    const other = await registeredIssuer(admin, 78);

    await rotate(admin, issuer.id, { newStellarAddress: address(79), expectedRevision: 5 }).expect(409);
    await rotate(admin, issuer.id, { newStellarAddress: other.stellarAddress, expectedRevision: 0 }).expect(409);
    await rotate(admin, issuer.id, { newStellarAddress: address(77), expectedRevision: 0 }).expect(400);
    await rotate(admin, issuer.id, { newStellarAddress: address(79) }).expect(422);

    expect(contract.submissions).toBe(0);
    expect(await db.prisma.issuerAddressRotation.count()).toBe(0);
  });

  it("refuses non-admins, anonymous callers and unknown issuers", async () => {
    const admin = await newAdmin();
    const issuer = await registeredIssuer(admin, 80);
    const developer = await authenticateNewWallet(server());
    await db.prisma.user.update({ where: { id: developer.userId }, data: { role: UserRole.DEVELOPER } });

    await rotate(developer, issuer.id, { newStellarAddress: address(81), expectedRevision: 0 }).expect(403);
    await request(server())
      .post(`/api/v1/issuers/${issuer.id}/address-rotations`)
      .send({ newStellarAddress: address(81), expectedRevision: 0 })
      .expect(401);
    await rotate(admin, "issuer_does_not_exist", { newStellarAddress: address(81), expectedRevision: 0 }).expect(404);
    expect(contract.submissions).toBe(0);
  });
});
