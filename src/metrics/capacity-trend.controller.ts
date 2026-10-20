/**
 * CapacityTrendController
 *
 * Exposes tenant-safe operations endpoints for capacity trend data.
 *
 * Authorization:
 *  - GET /metrics/capacity/trends       → ADMIN role or API key with ORG_ADMIN scope
 *  - GET /metrics/capacity/trends/:type → ADMIN role or API key with ORG_ADMIN scope
 *
 * Tenant safety:
 *  - Only aggregate counts and trend estimates are returned.
 *  - No wallet addresses, proof IDs, user IDs, or private records.
 *  - Estimate labels are human-readable strings, not raw data.
 */

import {
  Controller,
  Get,
  Param,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { RequiredRole } from "../common/decorators/required-role.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import {
  KNOWN_RESOURCE_TYPES,
  ResourceTypeValue,
} from "./capacity-types";
import { CapacityTrendService } from "./capacity-trend.service";

@ApiTags("metrics")
@ApiBearerAuth()
@UseGuards(AuthGuard, RoleGuard)
@RequiredRole("ADMIN")
@Controller("metrics/capacity")
export class CapacityTrendController {
  constructor(private readonly trendService: CapacityTrendService) {}

  @ApiOperation({
    summary: "Get all capacity trends",
    description:
      "Returns growth rates, exhaustion estimates, and alert states for all " +
      "tracked registry resources (issuer, schema, proof, storage). " +
      "Only aggregate counts — no private records.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Capacity trends for all resource types.",
  })
  @HttpCode(HttpStatus.OK)
  @Get("trends")
  async getAllTrends() {
    return this.trendService.getAllTrends();
  }

  @ApiOperation({
    summary: "Get capacity trend for a specific resource type",
    description:
      "Returns the growth rate, exhaustion estimate, and alert state for a " +
      "single resource type (ISSUER, SCHEMA, PROOF, or STORAGE).",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Capacity trend for the specified resource type.",
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Unknown resource type.",
  })
  @HttpCode(HttpStatus.OK)
  @Get("trends/:resourceType")
  async getTrend(@Param("resourceType") resourceType: string) {
    if (!KNOWN_RESOURCE_TYPES.has(resourceType)) {
      throw new BadRequestException(
        `Unknown resource type "${resourceType}". Valid types: ${[...KNOWN_RESOURCE_TYPES].join(", ")}`,
      );
    }
    return this.trendService.getTrend(resourceType as ResourceTypeValue);
  }
}