import { ResourceStatus } from "@prisma/client";
import { AttestationReconcilerService } from "./attestation-reconciler.service";

const NOW = new Date("2026-09-24T12:00:00.000Z");

function dueRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "att-1",
    issuerId: "iss-1",
    subjectWalletHash: "sha256:abc",
    status: ResourceStatus.ACTIVE,
    expiresAt: new Date(NOW.getTime() - 3_600_000),
    revokedAt: null,
    issuer: { organizationId: "org-1" },
    ...overrides,
  };
}

function build(rows: object[], updateCount = 1) {
  const prisma = {
    attestation: {
      findMany: jest.fn().mockResolvedValue(rows),
      updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const webhook = { enqueueForOrganization: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn((_k: string, def: number) => def) };
  const service = new AttestationReconcilerService(
    prisma as never,
    config as never,
    webhook as never,
  );
  return { prisma, webhook, service };
}

describe("AttestationReconcilerService.reconcile", () => {
  it("transitions an expired ACTIVE attestation to EXPIRED and emits events", async () => {
    const { prisma, webhook, service } = build([dueRow()]);

    const count = await service.reconcile(NOW);

    expect(count).toBe(1);
    expect(prisma.attestation.updateMany).toHaveBeenCalledWith({
      where: { id: "att-1", status: ResourceStatus.ACTIVE },
      data: { status: ResourceStatus.EXPIRED, reconciledAt: NOW },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(webhook.enqueueForOrganization).toHaveBeenCalledWith(
      "org-1",
      "attestation.expired",
      expect.objectContaining({
        event: "attestation.expired",
        data: expect.objectContaining({
          attestationId: "att-1",
          effectiveStatus: "EXPIRED",
        }),
      }),
    );
  });

  it("queries only ACTIVE rows past the skew-adjusted cutoff (indexed)", async () => {
    const { prisma, service } = build([]);
    await service.reconcile(NOW);
    const where = prisma.attestation.findMany.mock.calls[0][0].where;
    expect(where.status).toBe(ResourceStatus.ACTIVE);
    expect(where.expiresAt.lt).toEqual(new Date(NOW.getTime() - 60_000));
  });

  it("is idempotent: emits nothing when the row was already transitioned", async () => {
    // updateMany affects 0 rows — another worker or a prior run moved it.
    const { prisma, webhook, service } = build([dueRow()], 0);

    const count = await service.reconcile(NOW);

    expect(count).toBe(0);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(webhook.enqueueForOrganization).not.toHaveBeenCalled();
  });

  it("processes a delayed batch against the supplied instant", async () => {
    // A job that fires late still reconciles rows expired relative to `now`.
    const later = new Date(NOW.getTime() + 24 * 3_600_000);
    const { prisma, service } = build([dueRow()]);
    await service.reconcile(later);
    const where = prisma.attestation.findMany.mock.calls[0][0].where;
    expect(where.expiresAt.lt).toEqual(new Date(later.getTime() - 60_000));
  });

  it("does not emit when webhook delivery is absent", async () => {
    const prisma = {
      attestation: {
        findMany: jest.fn().mockResolvedValue([dueRow()]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const config = { get: jest.fn((_k: string, def: number) => def) };
    const service = new AttestationReconcilerService(
      prisma as never,
      config as never,
      undefined,
    );
    await expect(service.reconcile(NOW)).resolves.toBe(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
