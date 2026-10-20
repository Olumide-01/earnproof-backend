import { Controller, Get, Post, Param, UseGuards, Res, BadRequestException } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiNotFoundResponse, ApiConflictResponse, ApiTag } from "@nestjs/swagger";
import { Response } from "express";
import { AuthGuard } from "@nestjs/passport";
import { CurrentUser } from "../../auth/decorators/current-user.decorator";
import { AuthenticatedUser } from "../../auth/auth.types";
import { ApprovalIntentReceiptService } from "../services/approval-intent-receipt.service";
import { ApprovalIntentReceiptKeysService } from "../services/approval-intent-receipt-keys.service";
import { ApprovalIntentReceiptResponseDto } from "../dto/approval-intent-receipt-response.dto";
import { ReceiptVerificationKeySetDto, ReceiptVerificationResultDto } from "../dto/receipt-verification-key.dto";

@ApiTag("Governance - Approval Intent Receipts")
@Controller("governance/approval-receipts")
export class ApprovalIntentReceiptController {
  constructor(
    private readonly receiptService: ApprovalIntentReceiptService,
    private readonly keysService: ApprovalIntentReceiptKeysService,
  ) {}

  /**
   * Issue a signed receipt for an approved approval, or retrieve existing.
   *
   * Idempotent: calling this multiple times on the same approval returns the same receipt.
   *
   * @param approvalId - Approval request ID
   * @param user - Authenticated user
   * @returns Signed receipt binding approval to proposal and payload
   */
  @Post("/approvals/:approvalId/receipts")
  @UseGuards(AuthGuard("bearer"))
  @ApiBearerAuth()
  @ApiOkResponse({
    description: "Receipt issued or retrieved",
    type: ApprovalIntentReceiptResponseDto,
  })
  @ApiNotFoundResponse({ description: "Approval not found" })
  @ApiConflictResponse({ description: "Approval not confirmed or proposal in terminal state" })
  async issueReceipt(
    @Param("approvalId") approvalId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApprovalIntentReceiptResponseDto> {
    return this.receiptService.issueReceiptAfterApproval(approvalId);
  }

  /**
   * Retrieve a receipt by ID.
   *
   * Only the approver, related users, or admins may retrieve the receipt.
   *
   * @param receiptId - Receipt ID
   * @param user - Authenticated user
   * @returns The signed receipt
   */
  @Get("/receipts/:receiptId")
  @UseGuards(AuthGuard("bearer"))
  @ApiBearerAuth()
  @ApiOkResponse({
    description: "Receipt retrieved",
    type: ApprovalIntentReceiptResponseDto,
  })
  @ApiNotFoundResponse({ description: "Receipt not found" })
  async getReceipt(
    @Param("receiptId") receiptId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApprovalIntentReceiptResponseDto> {
    return this.receiptService.getReceipt(receiptId, user);
  }

  /**
   * Verify a receipt's signature and return the verified data.
   *
   * @param receiptId - Receipt ID
   * @returns Verification result with receipt data if valid
   */
  @Post("/receipts/:receiptId/verify")
  @ApiOkResponse({
    description: "Verification result",
    type: ReceiptVerificationResultDto,
  })
  @ApiNotFoundResponse({ description: "Receipt not found" })
  async verifyReceipt(@Param("receiptId") receiptId: string): Promise<ReceiptVerificationResultDto> {
    return this.receiptService.verifyReceipt(receiptId);
  }

  /**
   * Publish verification keys for receipts.
   *
   * Returns a JWK Set containing all currently usable keys: active keys and
   * non-expired retired keys. No authentication required (public endpoint).
   *
   * Supports cache efficiency via ETag.
   *
   * @param res - Express response object
   * @returns JWK Set or 304 Not Modified if ETag matches
   */
  @Get("/keys")
  @ApiOkResponse({
    description: "Verification key set (JWK format)",
    type: ReceiptVerificationKeySetDto,
  })
  async getVerificationKeys(@Res() res: Response): Promise<void> {
    const keySet = this.keysService.getPublicKeySet();
    const etag = this.keysService.getEtag();

    // Check If-None-Match header for cache efficiency
    const clientEtag = res.req.headers["if-none-match"];
    if (clientEtag === etag) {
      res.status(304).send();
      return;
    }

    // Set cache headers
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "public, max-age=3600"); // 1 hour
    res.json(keySet);
  }

  /**
   * Retrieve a receipt by approval ID (convenience endpoint).
   *
   * @param approvalId - Approval ID
   * @param user - Authenticated user
   * @returns The receipt, or 404 if not yet issued
   */
  @Get("/approvals/:approvalId")
  @UseGuards(AuthGuard("bearer"))
  @ApiBearerAuth()
  @ApiOkResponse({
    description: "Receipt retrieved",
    type: ApprovalIntentReceiptResponseDto,
  })
  @ApiNotFoundResponse({ description: "Receipt not yet issued for this approval" })
  async getReceiptByApprovalId(
    @Param("approvalId") approvalId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApprovalIntentReceiptResponseDto> {
    const receipt = await this.receiptService.getReceiptByApprovalId(approvalId, user);
    if (!receipt) {
      throw new BadRequestException(`No receipt yet issued for approval ${approvalId}`);
    }
    return receipt;
  }
}
