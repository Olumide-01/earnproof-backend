import { Module } from "@nestjs/common";
import { StellarService } from "./stellar.service";
import { TransactionConfirmationService } from "./transaction-confirmation.service";
import { TransactionConfirmationController } from "./transaction-confirmation.controller";

@Module({
  controllers: [TransactionConfirmationController],
  providers: [StellarService, TransactionConfirmationService],
  exports: [StellarService, TransactionConfirmationService],
})
export class StellarModule {}
