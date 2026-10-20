import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { ProposalLifecycleState } from "@prisma/client";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { SESSION_AUTH_SCHEME } from "../common/swagger/security-schemes";
import { GovernanceProposalResponseDto, GovernanceService } from "./governance.service";

@ApiTags("governance")
@AuthenticatedRoute({ ownership: "user" })
@ApiBearerAuth(SESSION_AUTH_SCHEME)
@UseGuards(AuthGuard)
@Controller("contracts/:contractId/governance/proposals")
export class GovernanceController {
  constructor(private readonly governanceService: GovernanceService) {}

  @Get()
  @ApiOperation({ summary: "List contract governance proposals for review" })
  @ApiQuery({ name: "network", required: false, example: "testnet" })
  @ApiQuery({ name: "status", required: false, enum: ProposalLifecycleState })
  @ApiQuery({ name: "limit", required: false, type: Number })
  async listProposals(
    @Param("contractId") contractId: string,
    @Query("network") network = "testnet",
    @Query("status") status?: ProposalLifecycleState,
    @Query("limit") limit?: string,
  ): Promise<GovernanceProposalResponseDto[]> {
    return this.governanceService.listProposals(network, contractId, {
      status,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(":proposalId")
  @ApiOperation({ summary: "Get proposal detail with decoded action and raw hash" })
  @ApiQuery({ name: "network", required: false, example: "testnet" })
  async getProposal(
    @Param("contractId") contractId: string,
    @Param("proposalId") proposalId: string,
    @Query("network") network = "testnet",
  ): Promise<GovernanceProposalResponseDto> {
    return this.governanceService.getProposal(network, contractId, proposalId);
  }
}
