import {
  Controller, 
  Post, 
  Get, 
  Body, 
  Query, 
  UseGuards, 
  Request,
  BadRequestException,
  Logger,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from "@nestjs/swagger";
import { AuthGuard } from "../guards/auth.guard";
import { ApiKeyGuard } from "../guards/api-key.guard";
import { RequireApiKeyScopes } from "../guards/api-key-quota.guard";
import { ReceiptService } from "./receipt.service";
import {
  GenerateDisclosureReceiptDto,
  VerifyReceiptDto,
  DisclosureReceiptResponseDto,
  ReceiptVerificationResponseDto,
  ListReceiptsQueryDto,
  ReceiptListItemDto,
} from "./dto/receipt.dto";

/**
 * Disclosure Controller
 * 
 * Manages signed disclosure receipts for proof sharing consent.
 * Provides endpoints for generating, verifying, and listing receipts.
 * 
 * Security considerations:
 * - Receipt generation requires authentication + API key with disclosure scope
 * - Receipt verification is public (no auth) for third-party validation
 * - Receipt listing is owner-scoped to prevent data leakage
 * - All operations maintain audit trails
 */
@ApiTags("Disclosure Receipts")
@Controller("disclosure")
export class DisclosureController {
  private readonly logger = new Logger(DisclosureController.name);

  constructor(private readonly receiptService: ReceiptService) {}

  /**
   * Generate signed disclosure receipt
   * 
   * Creates a tamper-evident receipt for approved proof sharing consent.
   * Requires authentication and API key with disclosure permissions.
   */
  @Post("receipts")
  @UseGuards(AuthGuard, ApiKeyGuard)
  @RequireApiKeyScopes("disclosure:create")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Generate signed disclosure receipt",
    description: "Creates a tamper-evident receipt for approved proof sharing consent. Requires disclosure:create scope.",
  })
  @ApiResponse({
    status: 201,
    description: "Receipt generated successfully",
    type: DisclosureReceiptResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: "Invalid request or proof not found",
  })
  @ApiResponse({
    status: 401,
    description: "Authentication required",
  })
  @ApiResponse({
    status: 403,
    description: "Insufficient permissions or missing API key scope",
  })
  async generateReceipt(
    @Request() req: any,
    @Body() dto: GenerateDisclosureReceiptDto,
  ): Promise<DisclosureReceiptResponseDto> {
    try {
      const userId = req.user.sub;
      const organizationId = req.user.organizationId;

      if (!organizationId) {
        throw new BadRequestException("Organization context required");
      }

      // Parse optional expiration date
      const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : undefined;
      if (expiresAt && expiresAt <= new Date()) {
        throw new BadRequestException("Expiration date must be in the future");
      }

      const result = await this.receiptService.generateDisclosureReceipt(
        organizationId,
        dto.proofId,
        {
          userId,
          purpose: dto.purpose,
          approvalTimestamp: new Date(),
        },
        {
          expiresAt,
          policyVersion: dto.policyVersion,
        },
      );

      this.logger.log(
        `Generated disclosure receipt ${result.receiptId} for proof ${dto.proofId} by user ${userId}`,
      );

      return {
        receiptId: result.receiptId,
        receipt: result.receipt,
        signature: result.signature,
        createdAt: result.receipt.issuedAt,
      };
    } catch (error) {
      this.logger.error("Failed to generate disclosure receipt:", error);
      throw error;
    }
  }

  /**
   * Verify disclosure receipt signature
   * 
   * Public endpoint for third-party verification of receipt authenticity.
   * Does not require authentication to enable external validation.
   */
  @Post("receipts/verify")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Verify disclosure receipt signature",
    description: "Publicly verifies the authenticity and validity of a disclosure receipt. No authentication required.",
  })
  @ApiResponse({
    status: 200,
    description: "Receipt verification result",
    type: ReceiptVerificationResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: "Invalid receipt format",
  })
  async verifyReceipt(
    @Body() dto: VerifyReceiptDto,
  ): Promise<ReceiptVerificationResponseDto> {
    try {
      const result = await this.receiptService.verifyDisclosureReceipt(
        dto.receipt,
        dto.signature,
      );

      // Log verification attempts (but not the receipt content for privacy)
      this.logger.log(
        `Receipt verification: ${result.status} (valid: ${result.isValid})`,
      );

      return {
        isValid: result.isValid,
        status: result.status,
        verifiedAt: result.verifiedAt.toISOString(),
        ...(result.expiresAt ? { expiresAt: result.expiresAt.toISOString() } : {}),
      };
    } catch (error) {
      this.logger.error("Receipt verification failed:", error);
      throw new BadRequestException("Invalid receipt format");
    }
  }

  /**
   * List owner disclosure receipts
   * 
   * Returns receipts for proofs owned by the authenticated user.
   * Supports filtering by proof ID and pagination.
   */
  @Get("receipts")
  @UseGuards(AuthGuard, ApiKeyGuard)
  @RequireApiKeyScopes("disclosure:read")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "List disclosure receipts",
    description: "Lists disclosure receipts for proofs owned by the authenticated user. Requires disclosure:read scope.",
  })
  @ApiQuery({
    name: "proofId",
    required: false,
    description: "Filter by specific proof ID",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Maximum number of receipts to return (1-100)",
    type: Number,
  })
  @ApiQuery({
    name: "includeExpired",
    required: false,
    description: "Include expired receipts in results",
    type: Boolean,
  })
  @ApiResponse({
    status: 200,
    description: "List of disclosure receipts",
    type: [ReceiptListItemDto],
  })
  @ApiResponse({
    status: 401,
    description: "Authentication required",
  })
  @ApiResponse({
    status: 403,
    description: "Insufficient permissions or missing API key scope",
  })
  async listReceipts(
    @Request() req: any,
    @Query() query: ListReceiptsQueryDto,
  ): Promise<ReceiptListItemDto[]> {
    try {
      const userId = req.user.sub;
      const organizationId = req.user.organizationId;

      if (!organizationId) {
        throw new BadRequestException("Organization context required");
      }

      // Validate limit bounds
      if (query.limit && (query.limit < 1 || query.limit > 100)) {
        throw new BadRequestException("Limit must be between 1 and 100");
      }

      const receipts = await this.receiptService.getOwnerReceipts(
        userId,
        organizationId,
        {
          proofId: query.proofId,
          limit: query.limit,
          includeExpired: query.includeExpired,
        },
      );

      return receipts.map((receipt) => ({
        id: receipt.id,
        proofId: receipt.proofId,
        receiptHash: receipt.receiptHash,
        issuedAt: receipt.issuedAt.toISOString(),
        expiresAt: receipt.expiresAt.toISOString(),
        signatureKeyId: receipt.signatureKeyId,
      }));
    } catch (error) {
      this.logger.error("Failed to list disclosure receipts:", error);
      throw error;
    }
  }
}