import { Module } from "@nestjs/common";
import { ProofsModule } from "../proofs/proofs.module";
import { CredentialSigningKeyringService } from "../common/crypto/credential-signing-keyring.service";
import { CredentialVerificationKeyService } from "../common/crypto/credential-verification-key.service";
import { CredentialsController } from "./credentials.controller";
import { CredentialsService } from "./credentials.service";
import { EvidenceBundleService } from "./evidence-bundle.service";

@Module({
  imports: [ProofsModule],
  controllers: [CredentialsController],
  providers: [
    CredentialsService,
    CredentialSigningKeyringService,
    CredentialVerificationKeyService,
    EvidenceBundleService,
  ],
  exports: [
    CredentialsService,
    CredentialSigningKeyringService,
    CredentialVerificationKeyService,
    EvidenceBundleService,
  ],
})
export class CredentialsModule {}
