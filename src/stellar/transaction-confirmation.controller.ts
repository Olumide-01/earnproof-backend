import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../database/prisma.service";
import { TransactionConfirmationService } from "./transaction-confirmation.service";
import {
  SubmitTransactionConfirmationDto,
  TransactionConfirmationResponseDto,
} from "./dto/transaction-confirmation.dto";
import { ResourceStatus } from "@prisma/client";

@ApiTags("Stellar")
@Controller("stellar/transactions")
export class TransactionConfirmationController {
  constructor(
    private readonly confirmationService: TransactionConfirmationService,
    private readonly prisma: PrismaService,
  ) {}

  private async resolveOrganizationId(
    userId: string,
    orgHeader?: string,
  ): Promise<string> {
    if (orgHeader && orgHeader.trim().length > 0) {
      const membership = await this.prisma.organizationMember.findFirst({
        where: {
          organizationId: orgHeader.trim(),
          userId,
          status: ResourceStatus.ACTIVE,
        },
      });
      if (!membership) {
        throw new ForbiddenException(
          "User does not have active membership in the specified organization",
        );
      }
      return orgHeader.trim();
    }

    const primaryMembership = await this.prisma.organizationMember.findFirst({
      where: {
        userId,
        status: ResourceStatus.ACTIVE,
      },
      select: {
        organizationId: true,
      },
    });

    if (!primaryMembership) {
      throw new ForbiddenException(
        "User must belong to an active organization",
      );
    }

    return primaryMembership.organizationId;
  }

  @Post("confirmations")
  @AuthenticatedRoute()
  @ApiOperation({
    summary: "Record a submitted Stellar or Soroban transaction for confirmation tracking",
  })
  async recordSubmission(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SubmitTransactionConfirmationDto,
    @Headers("x-organization-id") orgHeader?: string,
  ): Promise<TransactionConfirmationResponseDto> {
    const organizationId = await this.resolveOrganizationId(user.id, orgHeader);
    return this.confirmationService.recordSubmission({
      organizationId,
      network: body.network,
      transactionHash: body.transactionHash,
      operationType: body.operationType,
      operationRef: body.operationRef,
      metadata: body.metadata,
    });
  }

  @Get("confirmations/:network/:transactionHash")
  @AuthenticatedRoute()
  @ApiOperation({
    summary: "Get confirmation status and privacy-safe explorer reference for a transaction",
  })
  async getStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param("network") network: string,
    @Param("transactionHash") transactionHash: string,
    @Headers("x-organization-id") orgHeader?: string,
  ): Promise<TransactionConfirmationResponseDto> {
    const organizationId = await this.resolveOrganizationId(user.id, orgHeader);
    return this.confirmationService.getStatus(
      organizationId,
      network,
      transactionHash,
    );
  }
}
