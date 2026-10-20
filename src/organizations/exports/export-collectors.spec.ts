import { OrganizationExportCategory } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { collectExport, serializeExport } from "./export-collectors";

/**
 * Records the arguments each delegate was called with, so the tests can assert
 * *how* the collectors query — tenant filter present, secret columns absent —
 * not only what they return.
 */
function makePrisma() {
  const calls: Record<string, unknown> = {};
  const delegate = (name: string, result: unknown) => ({
    findUnique: jest.fn(async (args: unknown) => {
      calls[`${name}.findUnique`] = args;
      return result;
    }),
    findMany: jest.fn(async (args: unknown) => {
      calls[`${name}.findMany`] = args;
      return result;
    }),
  });

  const prisma = {
    organization: delegate("organization", { id: "org_1", name: "Acme" }),
    issuer: delegate("issuer", [{ id: "iss_1" }]),
    apiKey: delegate("apiKey", [{ id: "key_1", prefix: "ep_live" }]),
    webhook: delegate("webhook", [{ id: "wh_1", url: "https://x" }]),
    auditLog: delegate("auditLog", [{ id: "log_1" }]),
  } as unknown as PrismaService;

  return { prisma, calls };
}

describe("collectExport", () => {
  it("scopes every collector to the organization", async () => {
    const { prisma, calls } = makePrisma();

    await collectExport(prisma, "org_1", [
      OrganizationExportCategory.ISSUERS,
      OrganizationExportCategory.API_KEYS,
      OrganizationExportCategory.WEBHOOKS,
      OrganizationExportCategory.AUDIT_LOGS,
    ]);

    expect((calls["issuer.findMany"] as any).where).toEqual({
      organizationId: "org_1",
    });
    expect((calls["apiKey.findMany"] as any).where).toEqual({
      organizationId: "org_1",
    });
    expect((calls["webhook.findMany"] as any).where).toEqual({
      organizationId: "org_1",
    });
    expect((calls["auditLog.findMany"] as any).where).toMatchObject({
      resourceId: "org_1",
    });
  });

  it("never selects secret columns", async () => {
    const { prisma, calls } = makePrisma();

    await collectExport(prisma, "org_1", [
      OrganizationExportCategory.API_KEYS,
      OrganizationExportCategory.WEBHOOKS,
    ]);

    const apiKeySelect = (calls["apiKey.findMany"] as any).select;
    expect(apiKeySelect.keyHash).toBeUndefined();
    expect(apiKeySelect.prefix).toBe(true);

    const webhookSelect = (calls["webhook.findMany"] as any).select;
    expect(webhookSelect.secretEncrypted).toBeUndefined();
    expect(webhookSelect.url).toBe(true);
  });

  it("de-duplicates and orders categories deterministically", async () => {
    const { prisma } = makePrisma();

    const collected = await collectExport(prisma, "org_1", [
      OrganizationExportCategory.ISSUERS,
      OrganizationExportCategory.ORGANIZATION_PROFILE,
      OrganizationExportCategory.ISSUERS,
    ]);

    // Fixed collector order, regardless of request order or duplicates.
    expect(collected.categories).toEqual([
      OrganizationExportCategory.ORGANIZATION_PROFILE,
      OrganizationExportCategory.ISSUERS,
    ]);
    expect(Object.keys(collected.data)).toEqual([
      "organizationProfile",
      "issuers",
    ]);
  });

  it("serializes to parseable JSON", async () => {
    const { prisma } = makePrisma();
    const collected = await collectExport(prisma, "org_1", [
      OrganizationExportCategory.ORGANIZATION_PROFILE,
    ]);

    const parsed = JSON.parse(serializeExport(collected).toString("utf8"));
    expect(parsed.organizationId).toBe("org_1");
    expect(parsed.data.organizationProfile).toEqual({ id: "org_1", name: "Acme" });
  });
});
