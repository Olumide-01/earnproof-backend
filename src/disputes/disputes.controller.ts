import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "../common/guards/auth.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser as User } from "../common/decorators/current-user.decorator";
import { OrganizationMemberGuard as OrganizationGuard } from "../organizations/guards/organization-member.guard";
const Organization = () => Param("organizationId");
import { DisputesService } from "./disputes.service";
import {
  CreateDisputeDto,
  ListDisputesQueryDto,
  AssignDisputeDto,
  ResolveDisputeDto,
  DisputeResponseDto,
  DisputeListResponseDto,
  DisputeStatsResponseDto,
} from "./dto/dispute.dto";

@ApiTags("Proof Disputes")
@ApiBearerAuth()
@UseGuards(AuthGuard, OrganizationGuard)
@Controller("organizations/:organizationId/disputes")
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  @Post()
  @ApiOperation({
    summary: "Submit a new proof dispute",
    description: `
Submit a dispute for review of a proof. This is a business/audit workflow 
that does not affect the cryptographic validity of the proof.

Only one active dispute per proof/category is allowed at a time.
Evidence should be committed as a SHA-256 hash, not raw content.
    `.trim(),
  })
  @ApiResponse({
    status: 201,
    description: "Dispute submitted successfully",
    type: DisputeResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: "Invalid input or active dispute already exists",
  })
  @ApiResponse({
    status: 404,
    description: "Proof not found or not accessible",
  })
  async submitDispute(
    @User() user: AuthenticatedUser,
    @Organization() organizationId: string,
    @Body() input: CreateDisputeDto,
  ): Promise<DisputeResponseDto> {
    return (await this.disputesService.submitDispute(user, organizationId, input)) as unknown as DisputeResponseDto;
  }

  @Get()
  @ApiOperation({
    summary: "List disputes with filtering and pagination",
    description: `
List disputes for the organization with optional filtering by status, 
category, or assigned reviewer. Results are paginated and ordered by 
submission date (newest first).
    `.trim(),
  })
  @ApiResponse({
    status: 200,
    description: "Disputes retrieved successfully",
    type: DisputeListResponseDto,
  })
  async listDisputes(
    @User() user: AuthenticatedUser,
    @Organization() organizationId: string,
    @Query() query: ListDisputesQueryDto,
  ): Promise<DisputeListResponseDto> {
    return this.disputesService.listDisputes(user, organizationId, query);
  }

  @Get("stats")
  @ApiOperation({
    summary: "Get dispute statistics for organization",
    description: `
Get aggregated statistics showing dispute counts by status and category.
Useful for dashboard displays and monitoring dispute volume.
    `.trim(),
  })
  @ApiResponse({
    status: 200,
    description: "Statistics retrieved successfully",
    type: DisputeStatsResponseDto,
  })
  async getDisputeStats(
    @User() user: AuthenticatedUser,
    @Organization() organizationId: string,
  ): Promise<DisputeStatsResponseDto> {
    return (await this.disputesService.getDisputeStats(user, organizationId)) as unknown as DisputeStatsResponseDto;
  }

  @Get(":disputeId")
  @ApiOperation({
    summary: "Get a specific dispute",
    description: `
Retrieve detailed information about a specific dispute including 
proof information, resolution details, and audit trail timestamps.
    `.trim(),
  })
  @ApiResponse({
    status: 200,
    description: "Dispute retrieved successfully",
    type: DisputeResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Dispute not found",
  })
  async getDispute(
    @User() user: AuthenticatedUser,
    @Organization() organizationId: string,
    @Param("disputeId") disputeId: string,
  ): Promise<DisputeResponseDto> {
    return this.disputesService.getDispute(user, organizationId, disputeId);
  }

  @Patch(":disputeId/withdraw")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Withdraw a dispute",
    description: `
Withdraw an open dispute. Only the original submitter can withdraw 
a dispute, and only while it's in OPEN status. Withdrawn disputes 
cannot be reopened.
    `.trim(),
  })
  @ApiResponse({
    status: 200,
    description: "Dispute withdrawn successfully",
    type: DisputeResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: "Dispute cannot be withdrawn (wrong status)",
  })
  @ApiResponse({
    status: 403,
    description: "Only the submitter can withdraw the dispute",
  })
  @ApiResponse({
    status: 404,
    description: "Dispute not found",
  })
  async withdrawDispute(
    @User() user: AuthenticatedUser,
    @Organization() organizationId: string,
    @Param("disputeId") disputeId: string,
  ): Promise<DisputeResponseDto> {
    return this.disputesService.withdrawDispute(user, organizationId, disputeId);
  }

  @Patch(":disputeId/assign")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Assign a dispute to a reviewer",
    description: `
Assign an open dispute to a reviewer for resolution. Only administrators
can assign disputes. The assignee must be an active member of the organization.
    `.trim(),
  })
  @ApiResponse({
    status: 200,
    description: "Dispute assigned successfully",
    type: DisputeResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: "Invalid assignee or dispute cannot be assigned",
  })
  @ApiResponse({
    status: 403,
    description: "Only administrators can assign disputes",
  })
  @ApiResponse({
    status: 404,
    description: "Dispute not found",
  })
  async assignDispute(
    @User() user: AuthenticatedUser,
    @Organization() organizationId: string,
    @Param("disputeId") disputeId: string,
    @Body() input: AssignDisputeDto,
  ): Promise<DisputeResponseDto> {
    return this.disputesService.assignDispute(user, organizationId, disputeId, input);
  }

  @Patch(":disputeId/resolve")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Resolve a dispute",
    description: `
Resolve a dispute with an outcome and detailed reasoning. Only administrators
or the assigned reviewer can resolve disputes. Resolution does NOT affect
the cryptographic validity of the proof - it's purely for audit/business workflow.

Common resolution outcomes: UPHELD, DISMISSED, PARTIALLY_UPHELD, etc.
    `.trim(),
  })
  @ApiResponse({
    status: 200,
    description: "Dispute resolved successfully",
    type: DisputeResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: "Invalid resolution data or dispute cannot be resolved",
  })
  @ApiResponse({
    status: 403,
    description: "Only administrators or assigned reviewers can resolve disputes",
  })
  @ApiResponse({
    status: 404,
    description: "Dispute not found",
  })
  async resolveDispute(
    @User() user: AuthenticatedUser,
    @Organization() organizationId: string,
    @Param("disputeId") disputeId: string,
    @Body() input: ResolveDisputeDto,
  ): Promise<DisputeResponseDto> {
    return this.disputesService.resolveDispute(user, organizationId, disputeId, input);
  }
}