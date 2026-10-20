import { Module } from "@nestjs/common";
import { OrganizationQuotaService } from "./organization-quota.service";

/**
 * Organization operational quotas. Imported by every module that owns a
 * quota-checked mutation (API keys, webhooks, proofs, payments) and by
 * organizations for usage reporting.
 */
@Module({
  providers: [OrganizationQuotaService],
  exports: [OrganizationQuotaService],
})
export class QuotasModule {}
