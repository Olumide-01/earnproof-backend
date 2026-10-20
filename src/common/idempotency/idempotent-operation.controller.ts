import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AuthenticatedRoute } from "../decorators/authorization-policy.decorator";
import { CurrentUser } from "../decorators/current-user.decorator";
import { AuthenticatedUser } from "../../auth/auth.types";
import { PrismaService } from "../../database/prisma.service";
import { IdempotencyService } from "../services/idempotency.service";
import {
  CancelIdempotentOperationDto,
  IdempotentOperationStatusResponseDto,
} from "./idempotent-operation.dto";
import { ResourceStatus } from "@prisma/client";

@ApiTags("Idempotency")
@Controller("operations/idempotency")
export class IdempotentOperationController {
  constructor(
    private readonly idempotencyService: IdempotencyService,
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

  @Get(":key")
  @AuthenticatedRoute()
  @ApiOperation({
    summary: "Check idempotent operation status, resource references, and consistency metadata",
    description:
      "Enables clients to recover after timeout-after-accept without guessing outcome. " +
      "Unknown keys or cross-tenant lookups fail closed to prevent information leakage.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Current operation status and metadata",
    type: IdempotentOperationStatusResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Idempotent operation key not found in organization",
  })
  async getStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param("key") key: string,
    @Headers("x-organization-id") orgHeader?: string,
  ): Promise<IdempotentOperationStatusResponseDto> {
    const organizationId = await this.resolveOrganizationId(user.id, orgHeader);
    return this.idempotencyService.getOperationStatus(organizationId, key);
  }

  @Post(":key/cancel")
  @HttpCode(HttpStatus.OK)
  @AuthenticatedRoute()
  @ApiOperation({
    summary: "Cancel a pending idempotent operation",
    description:
      "Transitions an in-flight operation to CANCELLED so subsequent retries are safe.",
  })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("key") key: string,
    @Body() body?: CancelIdempotentOperationDto,
    @Headers("x-organization-id") orgHeader?: string,
  ): Promise<{ cancelled: boolean; idempotencyKey: string }> {
    const organizationId = await this.resolveOrganizationId(user.id, orgHeader);
    await this.idempotencyService.cancel(organizationId, key, body?.reason);
    return { cancelled: true, idempotencyKey: key };
  }
}
