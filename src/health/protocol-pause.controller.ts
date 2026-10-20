import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { PublicRoute } from "../common/decorators/authorization-policy.decorator";
import {
  ProtocolPauseService,
  ProtocolPauseStateResponseDto,
} from "./protocol-pause.service";

@ApiTags("health")
@PublicRoute()
@Controller("health/protocol-pause")
export class ProtocolPauseController {
  constructor(private readonly pauseService: ProtocolPauseService) {}

  @Get()
  @ApiOperation({ summary: "List protocol pause states across contracts" })
  @ApiQuery({ name: "network", required: false, example: "testnet" })
  async listPauseStates(
    @Query("network") network = "testnet",
  ): Promise<ProtocolPauseStateResponseDto[]> {
    return this.pauseService.listPauseStates(network);
  }

  @Get(":contractId")
  @ApiOperation({ summary: "Get protocol pause and incident state for a specific contract" })
  @ApiQuery({ name: "network", required: false, example: "testnet" })
  async getPauseState(
    @Param("contractId") contractId: string,
    @Query("network") network = "testnet",
  ): Promise<ProtocolPauseStateResponseDto> {
    return this.pauseService.getPauseState(network, contractId);
  }
}
