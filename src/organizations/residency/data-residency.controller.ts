import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { DataResidencyClass } from "@prisma/client";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthGuard } from "../../common/guards/auth.guard";
import { AuthenticatedUser } from "../../auth/auth.types";
import { DataResidencyService } from "./data-residency.service";
import { RecordResidencyAssignmentDto } from "./dto/record-residency-assignment.dto";
import { SetResidencyPolicyDto } from "./dto/set-residency-policy.dto";

@ApiBearerAuth()
@ApiTags("organizations")
@Controller("organizations/:organizationId/residency")
@UseGuards(AuthGuard)
export class DataResidencyController {
  constructor(private readonly residency: DataResidencyService) {}

  @Post("policies")
  @ApiOperation({ summary: "Set (version) the residency policy for a data class" })
  setPolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Body() dto: SetResidencyPolicyDto,
  ) {
    return this.residency.setPolicy(user, organizationId, dto);
  }

  @Get("policies")
  @ApiOperation({ summary: "Get the active residency policy for a data class" })
  getPolicy(
    @Param("organizationId") organizationId: string,
    @Query("dataClass") dataClass: DataResidencyClass,
  ) {
    return this.residency.getActivePolicy(organizationId, dataClass);
  }

  @Post("assignments")
  @ApiOperation({ summary: "Record the region a resource is placed in, enforcing policy" })
  recordAssignment(
    @Param("organizationId") organizationId: string,
    @Body() dto: RecordResidencyAssignmentDto,
  ) {
    return this.residency.recordAssignment(organizationId, dto);
  }
}
