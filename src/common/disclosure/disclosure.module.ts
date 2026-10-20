import { Module } from "@nestjs/common";
import { ReceiptService } from "./receipt.service";
import { DisclosureController } from "./disclosure.controller";
import { DatabaseModule } from "../../database/database.module";
import { CredentialVerificationKeyService } from "../crypto/credential-verification-key.service";
import { AuthModule } from "../../auth/auth.module";
import { ApiKeysModule } from "../../api-keys/api-keys.module";

/**
 * Disclosure Module
 * 
 * Provides signed disclosure receipt functionality for proof sharing consent.
 * Integrates with existing crypto, auth, and database infrastructure.
 * 
 * Exports:
 * - ReceiptService for use in other modules
 * 
 * Dependencies:
 * - DatabaseModule: Prisma access for receipt storage
 * - CredentialVerificationKeyService: Signing and verification utilities
 * - AuthModule: JWT authentication
 * - ApiKeysModule: API key validation and scoping
 */
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    ApiKeysModule,
  ],
  controllers: [DisclosureController],
  providers: [ReceiptService, CredentialVerificationKeyService],
  exports: [ReceiptService],
})
export class DisclosureModule {}