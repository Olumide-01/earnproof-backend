import { OrganizationExportCategory } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";

/**
 * Gathers the data for each export category, tenant-scoped and secret-free.
 *
 * Two invariants hold for every collector here, and they are the whole security
 * story of the export:
 *
 * 1. **Tenant confinement.** Every query is filtered by `organizationId`. An
 *    export can only ever contain the requesting organization's own rows; there
 *    is no code path that widens past the tenant, because the id is applied at
 *    the query, not filtered out afterwards.
 * 2. **No secrets.** Collectors select explicit columns and never the secret
 *    ones — an API key's hash, a webhook's encrypted signing secret. An export
 *    is data a customer takes *out* of the system; shipping the credentials that
 *    protect it back to them (or to whoever intercepts the archive) would defeat
 *    every other control.
 */

export interface CollectedExport {
  organizationId: string;
  generatedAt: string;
  categories: OrganizationExportCategory[];
  data: Record<string, unknown>;
}

type Collector = (
  prisma: PrismaService,
  organizationId: string,
) => Promise<unknown>;

const COLLECTORS: Record<OrganizationExportCategory, Collector> = {
  [OrganizationExportCategory.ORGANIZATION_PROFILE]: (prisma, organizationId) =>
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        website: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    }),

  [OrganizationExportCategory.ISSUERS]: (prisma, organizationId) =>
    prisma.issuer.findMany({
      where: { organizationId },
      select: {
        id: true,
        stellarAddress: true,
        status: true,
        publicMetadata: true,
        verifiedAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),

  [OrganizationExportCategory.API_KEYS]: (prisma, organizationId) =>
    // Never selects keyHash: an export must not carry the credential itself.
    prisma.apiKey.findMany({
      where: { organizationId },
      select: {
        id: true,
        name: true,
        prefix: true,
        status: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),

  [OrganizationExportCategory.WEBHOOKS]: (prisma, organizationId) =>
    // Never selects secretEncrypted: the signing secret stays server-side.
    prisma.webhook.findMany({
      where: { organizationId },
      select: {
        id: true,
        url: true,
        events: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),

  [OrganizationExportCategory.AUDIT_LOGS]: (prisma, organizationId) =>
    prisma.auditLog.findMany({
      where: { resourceType: "Organization", resourceId: organizationId },
      select: {
        id: true,
        actorType: true,
        action: true,
        resourceType: true,
        resourceId: true,
        metadata: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
};

/** Stable key used for each category in the archive body. */
const CATEGORY_KEYS: Record<OrganizationExportCategory, string> = {
  [OrganizationExportCategory.ORGANIZATION_PROFILE]: "organizationProfile",
  [OrganizationExportCategory.ISSUERS]: "issuers",
  [OrganizationExportCategory.API_KEYS]: "apiKeys",
  [OrganizationExportCategory.WEBHOOKS]: "webhooks",
  [OrganizationExportCategory.AUDIT_LOGS]: "auditLogs",
};

/**
 * Collects every requested category into one archive body.
 *
 * Categories are de-duplicated and collected in a fixed order so the archive is
 * deterministic regardless of how the caller ordered its request.
 */
export async function collectExport(
  prisma: PrismaService,
  organizationId: string,
  categories: readonly OrganizationExportCategory[],
  now: Date = new Date(),
): Promise<CollectedExport> {
  const unique = [...new Set(categories)];
  const ordered = (Object.keys(COLLECTORS) as OrganizationExportCategory[]).filter(
    (category) => unique.includes(category),
  );

  const data: Record<string, unknown> = {};
  for (const category of ordered) {
    data[CATEGORY_KEYS[category]] = await COLLECTORS[category](
      prisma,
      organizationId,
    );
  }

  return {
    organizationId,
    generatedAt: now.toISOString(),
    categories: ordered,
    data,
  };
}

/** Serialises a collected export to the bytes that get encrypted. */
export function serializeExport(collected: CollectedExport): Buffer {
  return Buffer.from(JSON.stringify(collected), "utf8");
}
