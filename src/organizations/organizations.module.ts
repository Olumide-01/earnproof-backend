import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AuditModule } from "../audit/audit.module";
import { Clock, SystemClock } from "../common/time/clock";
import { DatabaseModule } from "../database/database.module";
import { JobsModule } from "../jobs/jobs.module";
import { AccessReviewController } from "./access-review.controller";
import { AccessReviewService } from "./access-review.service";
import { MembershipImportController } from "./membership-import.controller";
import { MembershipImportService } from "./membership-import.service";
import { OrganizationLifecycleController } from "./organization-lifecycle.controller";
import { OrganizationLifecycleService } from "./organization-lifecycle.service";
import { OrganizationMembersService } from "./organization-members.service";
import { OrganizationMemberGuard } from "./guards/organization-member.guard";
import { OrganizationReadinessService } from "./organization-readiness.service";
import { OrganizationsController } from "./organizations.controller";
import { OrganizationsService } from "./organizations.service";
import { RoleApprovalPolicyController } from "./role-approval-policy/role-approval-policy.controller";
import { RoleApprovalPolicyService } from "./role-approval-policy/role-approval-policy.service";

@Module({
  imports: [DatabaseModule, AuthModule, JobsModule],
  controllers: [
    OrganizationsController,
    OrganizationLifecycleController,
    MembershipImportController,
    AccessReviewController,
    RoleApprovalPolicyController,
  ],
  providers: [
    OrganizationsService,
    OrganizationLifecycleService,
    OrganizationMembersService,
    OrganizationMemberGuard,
    OrganizationReadinessService,
    MembershipImportService,
    AccessReviewService,
    RoleApprovalPolicyService,
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [
    OrganizationsService,
    OrganizationLifecycleService,
    OrganizationMembersService,
    OrganizationReadinessService,
    MembershipImportService,
    AccessReviewService,
    RoleApprovalPolicyService,
  ],
})
export class OrganizationsModule {}
