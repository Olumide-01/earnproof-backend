import { Module } from "@nestjs/common";
import { CspViolationAbuseService } from "./csp-violation-abuse.service";
import { CspViolationController } from "./csp-violation.controller";
import { CspViolationService } from "./csp-violation.service";

@Module({
  controllers: [CspViolationController],
  providers: [CspViolationService, CspViolationAbuseService],
  exports: [CspViolationService],
})
export class SecurityModule {}
