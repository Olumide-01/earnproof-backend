import { IssuerAddressRotationStatus, ResourceStatus } from "@prisma/client";
import { Keypair } from "@stellar/stellar-base";
import { AuthenticatedUser } from "../../src/auth/auth.types";
import { Clock, SystemClock } from "../../src/common/time/clock";
import { IssuerAddressRotationService } from "../../src/issuers/issuer-address-rotation.service";
import {
  IssuerRegistryAddressRead,
  IssuerRegistryRotationResult,
  IssuerRegistryService,
} from "../../src/issuers/issuer-registry.service";
import { integrationDatabase } from "./harness/database";
import { race, seedOrganization, seedUser } from "./harness/fixtures";
import { integrationModule } from "./harness/nest";

/**
 * Issuer address rotation against real PostgreSQL.
 *
 * The exclusivity guarantees live in the database: the unique indexes on the
 * open-rotation keys, the conditional revision claim, and the lease. Against
 * mocks, concurrent requests all "succeed"; here they must not.
 */

/** A contract double shared by the whole file; each test resets it. */
const contract = {
  addresses: new Map<string, string>(),
  submissions: 0,
  delayMs: 0,
  isConfigured: true,
  async readIssuerAddress(issuerId: string): Promise<IssuerRegistryAddressRead> {
    const current = this.addresses.get(issuerId);
    return current ? { state: "found", issuerAddress: current } : { state: "failed", error: "IssuerNotFound" };
  },
  async rotateIssuerAddress(issuerId: string, newAddress: string): Promise<IssuerRegistryRotationResult> {
    this.submissions += 1;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.addresses.set(issuerId, newAddress);
    return { state: "submitted", transactionHash: "c".repeat(64) };
  },
};

const db = integrationDatabase();
const injector = integrationModule([
  IssuerAddressRotationService,
  { provide: IssuerRegistryService, useValue: contract },
  { provide: Clock, useClass: SystemClock },
]);
const rotations = () => injector.get(IssuerAddressRotationService);
const address = (seed: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey();

async function seedIssuer(seed: string, stellarAddress: string) {
  const owner = await seedUser(db.prisma, `${seed}-owner`, { role: "ADMIN" });
  const organization = await seedOrganization(db.prisma, `${seed}-org`, owner.id);
  const issuer = await db.prisma.issuer.create({
    data: {
      organizationId: organization.id,
      stellarAddress,
      status: ResourceStatus.ACTIVE,
      contractSyncedStatus: ResourceStatus.ACTIVE,
    },
  });
  contract.addresses.set(issuer.id, stellarAddress);
  const actor: AuthenticatedUser = {
    id: owner.id,
    walletAddress: owner.walletAddress,
    walletHash: owner.walletHash,
    role: owner.role,
  };
  return { issuer, actor };
}

beforeEach(() => {
  contract.addresses.clear();
  contract.submissions = 0;
  contract.delayMs = 0;
});

describe("issuer address rotation schema", () => {
  it("starts every issuer at revision 0 with no history", async () => {
    const { issuer } = await seedIssuer("schema", address(51));

    expect(issuer.revision).toBe(0);
    expect(await db.prisma.issuerAddressHistory.count()).toBe(0);
  });

  it("enforces one open rotation per issuer and per target in the database", async () => {
    const { issuer, actor } = await seedIssuer("unique", address(52));
    const open = {
      issuerId: issuer.id,
      fromAddress: issuer.stellarAddress,
      expectedRevision: 0,
      requestedById: actor.id,
    };
    await db.prisma.issuerAddressRotation.create({
      data: { ...open, toAddress: address(53), openIssuerKey: issuer.id, openTargetKey: address(53) },
    });

    await expect(
      db.prisma.issuerAddressRotation.create({
        data: { ...open, toAddress: address(54), openIssuerKey: issuer.id, openTargetKey: address(54) },
      }),
    ).rejects.toThrow();
    // Closed rotations (null keys) never collide.
    await expect(
      db.prisma.issuerAddressRotation.create({ data: { ...open, toAddress: address(54) } }),
    ).resolves.toBeDefined();
  });
});

describe("issuer address rotation", () => {
  it("adopts the address, records history and bumps the revision after confirmation", async () => {
    const { issuer, actor } = await seedIssuer("happy", address(55));

    const view = await rotations().requestRotation(actor, issuer.id, {
      newStellarAddress: address(56),
      expectedRevision: 0,
    });

    expect(view.status).toBe(IssuerAddressRotationStatus.CONFIRMED);
    const updated = await db.prisma.issuer.findUniqueOrThrow({ where: { id: issuer.id } });
    expect(updated).toMatchObject({ stellarAddress: address(56), revision: 2 });
    expect(await db.prisma.issuerAddressHistory.findMany({ where: { issuerId: issuer.id } })).toEqual([
      expect.objectContaining({ stellarAddress: address(55), rotationId: view.id }),
    ]);
  });

  it("lets exactly one of two concurrent requests for the same issuer through", async () => {
    const { issuer, actor } = await seedIssuer("race-issuer", address(57));
    contract.delayMs = 50;

    const { fulfilled, rejected } = await race([
      rotations().requestRotation(actor, issuer.id, { newStellarAddress: address(58), expectedRevision: 0 }),
      rotations().requestRotation(actor, issuer.id, { newStellarAddress: address(59), expectedRevision: 0 }),
    ]);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(contract.submissions).toBe(1);
    expect(await db.prisma.issuerAddressHistory.count({ where: { issuerId: issuer.id } })).toBe(1);
  });

  it("never lets two issuers rotate onto the same address", async () => {
    const first = await seedIssuer("race-target-a", address(60));
    const second = await seedIssuer("race-target-b", address(61));
    contract.delayMs = 50;

    const { fulfilled, rejected } = await race([
      rotations().requestRotation(first.actor, first.issuer.id, { newStellarAddress: address(62), expectedRevision: 0 }),
      rotations().requestRotation(second.actor, second.issuer.id, { newStellarAddress: address(62), expectedRevision: 0 }),
    ]);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(await db.prisma.issuer.count({ where: { stellarAddress: address(62) } })).toBe(1);
  });

  it("serialises concurrent reconcilers through the lease", async () => {
    const { issuer, actor } = await seedIssuer("lease", address(63));
    contract.addresses.delete(issuer.id);
    const pending = await rotations().requestRotation(actor, issuer.id, {
      newStellarAddress: address(64),
      expectedRevision: 0,
    });
    expect(pending.status).toBe(IssuerAddressRotationStatus.PENDING);
    contract.addresses.set(issuer.id, address(63));
    contract.delayMs = 50;

    await Promise.all([
      rotations().reconcile(pending.id),
      rotations().reconcile(pending.id),
      rotations().reconcile(pending.id),
    ]);

    expect(contract.submissions).toBe(1);
    expect(
      (await db.prisma.issuer.findUniqueOrThrow({ where: { id: issuer.id } })).stellarAddress,
    ).toBe(address(64));
  });

  it("rejects a stale revision without creating a rotation", async () => {
    const { issuer, actor } = await seedIssuer("stale", address(65));
    await db.prisma.issuer.update({ where: { id: issuer.id }, data: { revision: 4 } });

    await expect(
      rotations().requestRotation(actor, issuer.id, { newStellarAddress: address(66), expectedRevision: 3 }),
    ).rejects.toThrow("stale");
    expect(await db.prisma.issuerAddressRotation.count()).toBe(0);
  });
});
