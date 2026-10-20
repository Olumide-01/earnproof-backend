import { ConflictException, NotFoundException } from "@nestjs/common";
import { ResourceStatus } from "@prisma/client";
import { FixedClock } from "../../test/time/fixed-clock";
import { AuthenticatedUser } from "../auth/auth.types";
import {
  DeletionBlockerCode,
  DELETED_ORGANIZATION_NAME,
  OrganizationLifecycleState,
} from "./organization-lifecycle.policy";
import { OrganizationLifecycleService } from "./organization-lifecycle.service";

const DAY = 24 * 60 * 60 * 1000;
const ADMIN: AuthenticatedUser = {
  id: "user_admin",
  walletAddress: "GADMIN",
  walletHash: `sha256:${"a".repeat(64)}`,
  role: "ADMIN",
};

type Row = Record<string, unknown>;

/**
 * In-memory tables with the semantics the service relies on: conditional
 * `updateMany` is atomic, and `$transaction` restores every table when its
 * callback throws.
 */
class Store {
  organizations: Row[] = [];
  issuers: Row[] = [];
  apiKeys: Row[] = [];
  webhooks: Row[] = [];
  deliveries: Row[] = [];
  idempotency: Row[] = [];
  audit: Row[] = [];
  failAudit = false;

  private matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, condition]) => {
      const value = row[key];
      if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
        const c = condition as { not?: unknown; in?: unknown[]; notIn?: unknown[] };
        if ("in" in c) return c.in!.includes(value);
        if ("notIn" in c) return !c.notIn!.includes(value);
        if ("not" in c) return value !== c.not;
      }
      return value === condition;
    });
  }

  private table(rows: Row[]) {
    return {
      findUnique: async ({ where }: { where: Row }) =>
        rows.find((row) => this.matches(row, where)) ?? null,
      findMany: async ({ where }: { where?: Row } = {}) =>
        rows.filter((row) => this.matches(row, where)),
      count: async ({ where }: { where?: Row } = {}) =>
        rows.filter((row) => this.matches(row, where)).length,
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = rows.find((candidate) => this.matches(candidate, where));
        if (!row) throw new Error("record not found");
        return Object.assign(row, data);
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = rows.filter((row) => this.matches(row, where));
        hit.forEach((row) => Object.assign(row, data));
        return { count: hit.length };
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const keep = rows.filter((row) => !this.matches(row, where));
        const count = rows.length - keep.length;
        rows.splice(0, rows.length, ...keep);
        return { count };
      },
    };
  }

  client() {
    return {
      $queryRaw: jest.fn().mockResolvedValue([]),
      organization: this.table(this.organizations),
      issuer: this.table(this.issuers),
      apiKey: this.table(this.apiKeys),
      webhook: this.table(this.webhooks),
      webhookDelivery: this.table(this.deliveries),
      idempotencyRecord: this.table(this.idempotency),
      auditLog: {
        create: async ({ data }: { data: Row }) => {
          if (this.failAudit) throw new Error("audit store unavailable");
          this.audit.push(data);
          return data;
        },
      },
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
        const tables = [
          this.organizations,
          this.issuers,
          this.apiKeys,
          this.webhooks,
          this.deliveries,
          this.idempotency,
          this.audit,
        ];
        const snapshot = tables.map((rows) => rows.map((row) => ({ ...row })));
        try {
          return await run(this.client());
        } catch (error) {
          tables.forEach((rows, index) => rows.splice(0, rows.length, ...snapshot[index]));
          throw error;
        }
      },
    };
  }
}

function setup(orgOverrides: Row = {}) {
  const store = new Store();
  const clock = new FixedClock("2026-06-01T00:00:00.000Z");
  store.organizations.push(
    {
      id: "org_1",
      name: "Acme Payroll",
      slug: "acme-payroll",
      website: "https://acme.example.com",
      status: ResourceStatus.ACTIVE,
      archivedAt: null,
      legalHoldAt: null,
      legalHoldReference: null,
      deletedAt: null,
      ...orgOverrides,
    },
    {
      id: "org_other",
      name: "Other",
      status: ResourceStatus.ACTIVE,
      archivedAt: null,
      legalHoldAt: null,
      legalHoldReference: null,
      deletedAt: null,
    },
  );
  store.apiKeys.push(
    { id: "key_1", organizationId: "org_1", status: ResourceStatus.ACTIVE, revokedAt: null },
    { id: "key_2", organizationId: "org_1", status: ResourceStatus.REVOKED, revokedAt: new Date(0) },
    { id: "key_other", organizationId: "org_other", status: ResourceStatus.ACTIVE, revokedAt: null },
  );
  store.webhooks.push(
    { id: "webhook_1", organizationId: "org_1" },
    { id: "webhook_other", organizationId: "org_other" },
  );
  store.deliveries.push(
    { id: "delivery_1", webhookId: "webhook_1" },
    { id: "delivery_2", webhookId: "webhook_1" },
    { id: "delivery_other", webhookId: "webhook_other" },
  );
  store.idempotency.push(
    { id: "idem_1", organizationId: "org_1" },
    { id: "idem_other", organizationId: "org_other" },
  );
  const service = new OrganizationLifecycleService(store.client() as never, clock);
  const org = () => store.organizations[0];
  return { store, clock, service, org };
}

/** An organization archived long enough ago to be deletable, with no blockers. */
function deletable() {
  const ctx = setup({ archivedAt: new Date("2026-01-01T00:00:00.000Z") });
  ctx.store.issuers.push({
    id: "issuer_retired",
    organizationId: "org_1",
    status: ResourceStatus.REVOKED,
    contractSyncedStatus: ResourceStatus.REVOKED,
  });
  return ctx;
}

describe("OrganizationLifecycleService", () => {
  describe("archive", () => {
    it("archives a live organization, keeps its status, and audits it", async () => {
      const { service, store, org, clock } = setup();

      const view = await service.archive(ADMIN, "org_1");

      expect(view).toMatchObject({
        lifecycleState: OrganizationLifecycleState.ARCHIVED,
        status: ResourceStatus.ACTIVE,
        archivedAt: clock.now(),
      });
      expect(org().archivedAt).toEqual(clock.now());
      expect(store.audit).toEqual([
        {
          actorType: "user",
          actorId: ADMIN.id,
          action: "organization.archived",
          resourceType: "Organization",
          resourceId: "org_1",
          metadata: { archivedAt: clock.now().toISOString() },
        },
      ]);
    });

    it("revokes nothing, so restore is lossless", async () => {
      const { service, store } = setup();

      await service.archive(ADMIN, "org_1");

      expect(store.apiKeys.find((k) => k.id === "key_1")!.status).toBe(ResourceStatus.ACTIVE);
      expect(store.webhooks).toHaveLength(2);
    });

    it("rejects archiving twice", async () => {
      const { service, store } = setup({ archivedAt: new Date() });

      await expect(service.archive(ADMIN, "org_1")).rejects.toThrow(
        "Organization is already archived",
      );
      expect(store.audit).toHaveLength(0);
    });

    it("rejects a deleted organization and an unknown one", async () => {
      const deleted = setup({ archivedAt: new Date(), deletedAt: new Date() });
      await expect(deleted.service.archive(ADMIN, "org_1")).rejects.toThrow(
        "Organization has been deleted",
      );

      const { service } = setup();
      await expect(service.archive(ADMIN, "missing")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rolls the archive back when the audit write fails", async () => {
      const { service, store, org } = setup();
      store.failAudit = true;

      await expect(service.archive(ADMIN, "org_1")).rejects.toThrow("audit store unavailable");
      expect(org().archivedAt).toBeNull();
    });
  });

  describe("restore", () => {
    it("returns an archived organization to live with its original status", async () => {
      const { service, store, org } = setup({
        archivedAt: new Date(),
        status: ResourceStatus.SUSPENDED,
      });

      const view = await service.restore(ADMIN, "org_1");

      expect(view).toMatchObject({
        lifecycleState: OrganizationLifecycleState.LIVE,
        status: ResourceStatus.SUSPENDED,
      });
      expect(org().archivedAt).toBeNull();
      expect(store.audit[0]).toMatchObject({ action: "organization.restored", metadata: {} });
    });

    it("rejects restoring a live organization", async () => {
      const { service } = setup();

      await expect(service.restore(ADMIN, "org_1")).rejects.toThrow("Organization is not archived");
    });

    it("never restores a deleted organization", async () => {
      const { service, org } = setup({ archivedAt: new Date(), deletedAt: new Date() });

      await expect(service.restore(ADMIN, "org_1")).rejects.toThrow("Organization has been deleted");
      expect(org().archivedAt).not.toBeNull();
    });
  });

  describe("legal hold", () => {
    it.each([
      ["a live", {}],
      ["an archived", { archivedAt: new Date() }],
    ])("can be placed on %s organization and released", async (_label, state) => {
      const { service, store, org } = setup(state);

      await expect(service.placeLegalHold(ADMIN, "org_1", "LEGAL-2026-014")).resolves.toMatchObject({
        legalHold: true,
      });
      expect(org()).toMatchObject({ legalHoldReference: "LEGAL-2026-014" });

      await expect(service.releaseLegalHold(ADMIN, "org_1")).resolves.toMatchObject({
        legalHold: false,
      });
      expect(org()).toMatchObject({ legalHoldAt: null, legalHoldReference: null });
      expect(store.audit.map((row) => [row.action, row.metadata])).toEqual([
        ["organization.legal_hold_placed", { reference: "LEGAL-2026-014" }],
        ["organization.legal_hold_released", { reference: "LEGAL-2026-014" }],
      ]);
    });

    it("rejects a second hold and releasing a hold that does not exist", async () => {
      const held = setup({ legalHoldAt: new Date(), legalHoldReference: "A" });
      await expect(held.service.placeLegalHold(ADMIN, "org_1", "B")).rejects.toThrow(
        "already under legal hold",
      );
      expect(held.org().legalHoldReference).toBe("A");

      const { service } = setup();
      await expect(service.releaseLegalHold(ADMIN, "org_1")).rejects.toThrow(
        "not under legal hold",
      );
    });

    it("does not block archiving or restoring", async () => {
      const { service } = setup({ legalHoldAt: new Date(), legalHoldReference: "A" });

      await expect(service.archive(ADMIN, "org_1")).resolves.toBeDefined();
      await expect(service.restore(ADMIN, "org_1")).resolves.toBeDefined();
    });
  });

  describe("getDeletionEligibility", () => {
    it("reports NOT_ARCHIVED for a live organization", async () => {
      const { service } = setup();

      await expect(service.getDeletionEligibility("org_1")).resolves.toEqual({
        organizationId: "org_1",
        lifecycleState: OrganizationLifecycleState.LIVE,
        eligible: false,
        blockers: [{ code: DeletionBlockerCode.NOT_ARCHIVED }],
        deletableAfter: null,
      });
    });

    it("enforces the minimum archive period with an exclusive boundary", async () => {
      const archivedAt = new Date("2026-05-01T00:00:00.000Z");
      const { service, clock } = setup({ archivedAt });
      const boundary = archivedAt.getTime() + 30 * DAY;

      clock.set(boundary);
      await expect(service.getDeletionEligibility("org_1")).resolves.toMatchObject({
        eligible: false,
        blockers: [{ code: DeletionBlockerCode.ARCHIVE_RETENTION_PERIOD }],
        deletableAfter: new Date(boundary),
      });

      clock.set(boundary + 1);
      await expect(service.getDeletionEligibility("org_1")).resolves.toMatchObject({
        eligible: true,
        blockers: [],
      });
    });

    it("reports every blocker at once, as codes and counts only", async () => {
      const { service, store } = setup({ legalHoldAt: new Date(), legalHoldReference: "CASE-SECRET-7" });
      store.issuers.push(
        { id: "i1", organizationId: "org_1", status: ResourceStatus.ACTIVE, contractSyncedStatus: ResourceStatus.ACTIVE },
        { id: "i2", organizationId: "org_1", status: ResourceStatus.PENDING, contractSyncedStatus: null },
        { id: "i3", organizationId: "org_1", status: ResourceStatus.REVOKED, contractSyncedStatus: ResourceStatus.ACTIVE },
        { id: "i4", organizationId: "org_other", status: ResourceStatus.ACTIVE, contractSyncedStatus: null },
      );

      const report = await service.getDeletionEligibility("org_1");

      expect(report.blockers).toEqual([
        { code: DeletionBlockerCode.NOT_ARCHIVED },
        { code: DeletionBlockerCode.LEGAL_HOLD },
        { code: DeletionBlockerCode.ACTIVE_ISSUERS, count: 2 },
        { code: DeletionBlockerCode.ISSUER_REGISTRY_OUT_OF_SYNC, count: 1 },
      ]);
      const serialised = JSON.stringify(report);
      for (const hidden of ["i1", "i2", "i3", "i4", "Acme", "CASE-SECRET-7"]) {
        expect(serialised).not.toContain(hidden);
      }
    });

    it("does not count issuers that were suspended and synced", async () => {
      const { service, store } = deletable();
      store.issuers.push({
        id: "i_suspended",
        organizationId: "org_1",
        status: ResourceStatus.SUSPENDED,
        contractSyncedStatus: ResourceStatus.SUSPENDED,
      });

      await expect(service.getDeletionEligibility("org_1")).resolves.toMatchObject({
        eligible: true,
      });
    });

    it("reports a deleted organization as not eligible with no blockers", async () => {
      const { service } = setup({ archivedAt: new Date(), deletedAt: new Date() });

      await expect(service.getDeletionEligibility("org_1")).resolves.toMatchObject({
        lifecycleState: OrganizationLifecycleState.DELETED,
        eligible: false,
        blockers: [],
      });
    });

    it("returns 404 for an unknown organization", async () => {
      const { service } = setup();

      await expect(service.getDeletionEligibility("missing")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("deleteOrganization", () => {
    it("revokes keys, removes webhooks and cached responses, and leaves a tombstone", async () => {
      const { service, store, org, clock } = deletable();

      const result = await service.deleteOrganization(ADMIN, "org_1");

      expect(result).toMatchObject({
        lifecycleState: OrganizationLifecycleState.DELETED,
        status: ResourceStatus.DELETED,
        deletedAt: clock.now(),
        apiKeysRevoked: 1,
        webhooksDeleted: 1,
        webhookDeliveriesDeleted: 2,
        idempotencyRecordsDeleted: 1,
      });
      expect(org()).toMatchObject({
        name: DELETED_ORGANIZATION_NAME,
        website: null,
        slug: "acme-payroll",
        status: ResourceStatus.DELETED,
      });
      expect(store.apiKeys.find((k) => k.id === "key_1")).toMatchObject({
        status: ResourceStatus.REVOKED,
        revokedAt: clock.now(),
      });
      // Already-revoked keys keep their original revocation time.
      expect(store.apiKeys.find((k) => k.id === "key_2")!.revokedAt).toEqual(new Date(0));
    });

    it("keeps issuers, so historical attestations stay verifiable", async () => {
      const { service, store } = deletable();

      await service.deleteOrganization(ADMIN, "org_1");

      expect(store.issuers).toEqual([
        expect.objectContaining({ id: "issuer_retired", status: ResourceStatus.REVOKED }),
      ]);
    });

    it("never touches another organization's records", async () => {
      const { service, store } = deletable();

      await service.deleteOrganization(ADMIN, "org_1");

      expect(store.apiKeys.find((k) => k.id === "key_other")!.status).toBe(ResourceStatus.ACTIVE);
      expect(store.webhooks.map((w) => w.id)).toEqual(["webhook_other"]);
      expect(store.deliveries.map((d) => d.id)).toEqual(["delivery_other"]);
      expect(store.idempotency.map((i) => i.id)).toEqual(["idem_other"]);
      expect(store.organizations[1]).toMatchObject({ name: "Other", deletedAt: null });
    });

    it("audits the deletion with cleanup counts and no profile data", async () => {
      const { service, store } = deletable();

      await service.deleteOrganization(ADMIN, "org_1");

      expect(store.audit).toEqual([
        {
          actorType: "user",
          actorId: ADMIN.id,
          action: "organization.deleted",
          resourceType: "Organization",
          resourceId: "org_1",
          metadata: {
            previousStatus: ResourceStatus.ACTIVE,
            apiKeysRevoked: 1,
            webhooksDeleted: 1,
            webhookDeliveriesDeleted: 2,
            idempotencyRecordsDeleted: 1,
          },
        },
      ]);
      expect(JSON.stringify(store.audit)).not.toContain("Acme");
    });

    it("locks the organization and its issuers before deciding", async () => {
      const { store } = deletable();
      const client = store.client();
      const service = new OrganizationLifecycleService(
        { ...client, $transaction: (run: (tx: unknown) => unknown) => run(client) } as never,
        new FixedClock("2026-06-01T00:00:00.000Z"),
      );

      await service.deleteOrganization(ADMIN, "org_1");

      const statements = client.$queryRaw.mock.calls.map(([strings]) =>
        (strings as TemplateStringsArray).join("?"),
      );
      expect(statements).toEqual([
        'SELECT "id" FROM "Organization" WHERE "id" = ? FOR UPDATE',
        'SELECT "id" FROM "Issuer" WHERE "organizationId" = ? FOR UPDATE',
      ]);
    });

    it.each([
      ["a live organization", {}, "NOT_ARCHIVED"],
      [
        "an organization inside its archive period",
        { archivedAt: new Date("2026-05-20T00:00:00.000Z") },
        "ARCHIVE_RETENTION_PERIOD",
      ],
      [
        "an organization under legal hold",
        { archivedAt: new Date("2026-01-01T00:00:00.000Z"), legalHoldAt: new Date(), legalHoldReference: "A" },
        "LEGAL_HOLD",
      ],
    ])("refuses %s and changes nothing", async (_label, state, code) => {
      const { service, store, org } = setup(state);
      const before = JSON.stringify(store);

      await expect(service.deleteOrganization(ADMIN, "org_1")).rejects.toThrow(
        new ConflictException(`Organization cannot be deleted: ${code}`),
      );
      expect(JSON.stringify(store)).toBe(before);
      expect(org().deletedAt).toBeNull();
    });

    it.each([
      [ResourceStatus.ACTIVE, null, "ACTIVE_ISSUERS"],
      [ResourceStatus.PENDING, null, "ACTIVE_ISSUERS"],
      [ResourceStatus.REVOKED, ResourceStatus.ACTIVE, "ISSUER_REGISTRY_OUT_OF_SYNC"],
    ])(
      "refuses while an issuer is %s (on-chain %s)",
      async (status, contractSyncedStatus, code) => {
        const { service, store } = deletable();
        store.issuers.push({ id: "i_live", organizationId: "org_1", status, contractSyncedStatus });

        await expect(service.deleteOrganization(ADMIN, "org_1")).rejects.toThrow(code);
        expect(store.apiKeys.find((k) => k.id === "key_1")!.status).toBe(ResourceStatus.ACTIVE);
      },
    );

    it("cannot delete twice, and a deleted organization cannot be restored", async () => {
      const { service } = deletable();
      await service.deleteOrganization(ADMIN, "org_1");

      await expect(service.deleteOrganization(ADMIN, "org_1")).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(service.restore(ADMIN, "org_1")).rejects.toThrow(
        "Organization has been deleted",
      );
      await expect(service.placeLegalHold(ADMIN, "org_1", "A")).rejects.toThrow(
        "Organization has been deleted",
      );
    });

    it("rolls every cleanup step back when the audit write fails", async () => {
      const { service, store, org } = deletable();
      store.failAudit = true;

      await expect(service.deleteOrganization(ADMIN, "org_1")).rejects.toThrow(
        "audit store unavailable",
      );
      expect(org()).toMatchObject({ deletedAt: null, name: "Acme Payroll" });
      expect(store.apiKeys.find((k) => k.id === "key_1")!.status).toBe(ResourceStatus.ACTIVE);
      expect(store.webhooks).toHaveLength(2);
      expect(store.deliveries).toHaveLength(3);
    });
  });
});
