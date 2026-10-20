import { OrganizationQuotaService } from "../quotas/organization-quota.service";

/**
 * Test double for suites that exercise behaviour unrelated to quotas.
 *
 * Every check passes. Quota enforcement itself is covered with the real
 * service in `src/quotas/`; this exists so unrelated suites do not need to
 * model organizations and usage counters.
 */
export function unlimitedQuotas(): jest.Mocked<
  Pick<
    OrganizationQuotaService,
    | "assertCapacity"
    | "consume"
    | "consumeForUser"
    | "resolveOrganizationForUser"
    | "getUsage"
    | "limitFor"
  >
> {
  return {
    assertCapacity: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockResolvedValue(undefined),
    consumeForUser: jest.fn().mockResolvedValue(null),
    resolveOrganizationForUser: jest.fn().mockResolvedValue(null),
    getUsage: jest.fn(),
    limitFor: jest.fn().mockReturnValue(Number.MAX_SAFE_INTEGER),
  };
}
