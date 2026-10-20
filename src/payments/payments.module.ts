import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { QuotasModule } from "../quotas/quotas.module";
import { StellarModule } from "../stellar/stellar.module";
import { PaymentClassificationHistoryService } from "./payment-classification-history.service";
import { PaymentCheckpointHealthService } from "./payment-checkpoint-health.service";
import { PaymentEligibilityService } from "./payment-eligibility.service";
import { PaymentFinalityService } from "./payment-finality.service";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { PaymentAccountResolver } from "./payment-account.resolver";
import { PaymentAccountRotationController } from "./payment-account-rotation.controller";
import { PaymentAccountRotationService } from "./payment-account-rotation.service";
import { Clock, SystemClock } from "../common/time/clock";

@Module({
  imports: [AuthModule, StellarModule, QuotasModule],
  controllers: [PaymentsController, PaymentAccountRotationController],
  providers: [
    PaymentAccountResolver,
    PaymentAccountRotationService,
    { provide: Clock, useClass: SystemClock },
    PaymentsService,
    PaymentFinalityService,
    PaymentEligibilityService,
    PaymentClassificationHistoryService,
    PaymentCheckpointHealthService,
  ],
  exports: [
    PaymentsService,
    PaymentFinalityService,
    PaymentEligibilityService,
    PaymentClassificationHistoryService,
    PaymentCheckpointHealthService,
    PaymentAccountResolver,
    PaymentAccountRotationService,
  ],
})
export class PaymentsModule {}
