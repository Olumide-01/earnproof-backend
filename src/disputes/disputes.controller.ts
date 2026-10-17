import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequiredRole } from "../common/decorators/required-role.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { DisputeEvidenceService } from "./dispute-evidence.service";
import { OpenDisputeDto } from "./dto/open-dispute.dto";
import { SubmitManifestDto } from "./dto/submit-manifest.dto";
import { ResolveDisputeDto } from "./dto/resolve-dispute.dto";

@ApiTags("disputes")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller("proofs/:proofId/disputes")
export class DisputesController {
  constructor(private readonly service: DisputeEvidenceService) {}

  @ApiOperation({ summary: "Open a dispute for a proof" })
  @ApiResponse({ status: 201, description: "Dispute opened." })
  @HttpCode(HttpStatus.CREATED)
  @Post()
  async openDispute(
    @Param("proofId") proofId: string,
    @Body() dto: OpenDisputeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.openDispute({
      proofId,
      reason: dto.reason,
      openerWalletHash: user.walletHash,
    });
  }

  @ApiOperation({ summary: "Submit an evidence manifest for a dispute" })
  @ApiResponse({ status: 201, description: "Manifest submitted." })
  @HttpCode(HttpStatus.CREATED)
  @Post(":disputeId/manifests")
  async submitManifest(
    @Param("disputeId") disputeId: string,
    @Body() dto: SubmitManifestDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.service.assertDisputeAccess(disputeId, user.id, user.role);
    return this.service.submitManifest({
      disputeId,
      submitterRole: dto.submitterRole,
      submitterWalletHash: user.walletHash,
      algorithms: dto.algorithms,
      storageRefs: dto.storageRefs,
      contractTransactionHash: dto.contractTransactionHash,
    });
  }

  @ApiOperation({ summary: "List evidence manifests for a dispute" })
  @ApiResponse({ status: 200, description: "Manifests listed." })
  @Get(":disputeId/manifests")
  async listManifests(
    @Param("disputeId") disputeId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.service.assertDisputeAccess(disputeId, user.id, user.role);
    return this.service.listManifests(disputeId);
  }

  @ApiOperation({ summary: "Resolve a dispute (ADMIN only)" })
  @ApiResponse({ status: 200, description: "Dispute resolved." })
  @UseGuards(RoleGuard)
  @RequiredRole("ADMIN")
  @Post(":disputeId/resolve")
  async resolveDispute(
    @Param("disputeId") disputeId: string,
    @Body() dto: ResolveDisputeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.resolveDispute(
      { disputeId, resolution: dto.resolution, adminWalletHash: user.walletHash },
      "RESOLVED",
    );
  }

  @ApiOperation({ summary: "Reject a dispute (ADMIN only)" })
  @ApiResponse({ status: 200, description: "Dispute rejected." })
  @UseGuards(RoleGuard)
  @RequiredRole("ADMIN")
  @Post(":disputeId/reject")
  async rejectDispute(
    @Param("disputeId") disputeId: string,
    @Body() dto: ResolveDisputeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.resolveDispute(
      { disputeId, resolution: dto.resolution, adminWalletHash: user.walletHash },
      "REJECTED",
    );
  }
}