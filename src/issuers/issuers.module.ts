import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { Clock, SystemClock } from "../common/time/clock";
import { DatabaseModule } from "../database/database.module";
import { IssuerAddressRotationController } from "./issuer-address-rotation.controller";
import { IssuerAddressRotationService } from "./issuer-address-rotation.service";
import { AttestationsService } from "./attestations.service";
import { IssuersService } from "./issuers.service";
import { IssuersController } from "./issuers.controller";
import { IssuerRegistryService } from "./issuer-registry.service";
import { IssuerReconciliationService } from "./issuer-reconciliation.service";
import { IssuerPolicyCommitmentsService } from "./issuer-policy-commitments.service";

import { IssuerSigningKeysController } from "./issuer-signing-keys.controller";
import { IssuerSigningKeysService } from "./issuer-signing-keys.service";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [
    IssuersController,
    IssuerAddressRotationController,
    IssuerSigningKeysController,
  ],
  providers: [
    IssuerRegistryService,
    IssuersService,
    IssuerReconciliationService,
    IssuerAddressRotationService,
    IssuerSigningKeysService,
    IssuerPolicyCommitmentsService,
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [
    IssuersService,
    IssuerReconciliationService,
    IssuerAddressRotationService,
    IssuerSigningKeysService,
    IssuerPolicyCommitmentsService,
    AttestationsService,
  ],
})
export class IssuersModule {}
