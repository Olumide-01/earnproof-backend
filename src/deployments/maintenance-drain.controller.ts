import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "../common/guards/auth.guard";
import { MaintenanceDrainService } from "./maintenance-drain.service";
import { InitiateDrainDto, DrainStatusResponseDto } from "./dto/maintenance-drain.dto";

@ApiTags("Deployments & Maintenance")
@Controller("deployments/maintenance")
export class MaintenanceDrainController {
  constructor(private readonly drainService: MaintenanceDrainService) {}

  @Get("status")
  @ApiOperation({ summary: "Get current maintenance drain and deployment readiness status" })
  @ApiResponse({ type: DrainStatusResponseDto })
  getStatus(): DrainStatusResponseDto {
    return this.drainService.getStatus();
  }

  @Post("drain")
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: "Initiate graceful write drain before deployment (Admin only)" })
  @ApiResponse({ type: DrainStatusResponseDto })
  initiateDrain(@Body() dto: InitiateDrainDto): DrainStatusResponseDto {
    return this.drainService.initiateDrain(dto);
  }

  @Post("resume")
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: "Resume normal operations post-deployment (Admin only)" })
  @ApiResponse({ type: DrainStatusResponseDto })
  resumeNormal(): DrainStatusResponseDto {
    return this.drainService.resumeNormal();
  }
}
