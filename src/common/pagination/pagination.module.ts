import { Module } from "@nestjs/common";
import { SignedCursorService } from "./signed-cursor.service";
import { SignedCursorKeyringService } from "./signed-cursor-keyring.service";

/**
 * Pagination module providing signed cursor token services.
 *
 * Exports:
 * - SignedCursorService: Core service for signing and validating cursor tokens
 * - SignedCursorKeyringService: Key rotation and versioning support
 *
 * Configuration (optional, defaults provided):
 * - CURSOR_SIGNING_SECRET: Legacy signing secret (version 0)
 * - CURSOR_SIGNING_SECRET_V{n}: Versioned signing secrets
 * - CURSOR_SIGNING_KEY_VERSION: Active signing key version (default: 0)
 * - CURSOR_SIGNING_SECRET_V{n}_VERIFY_UNTIL: Expiry deadline for verify-only keys (ISO-8601)
 */
@Module({
  providers: [SignedCursorKeyringService, SignedCursorService],
  exports: [SignedCursorService, SignedCursorKeyringService],
})
export class PaginationModule {}
