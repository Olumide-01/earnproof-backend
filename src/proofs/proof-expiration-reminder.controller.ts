import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import {
  ProofReminderDeliveryDto,
  ProofReminderPreferencesDto,
  UpdateProofReminderPreferencesDto,
} from "./dto/proof-reminder.dto";
import { ProofExpirationReminderService } from "./proof-expiration-reminder.service";

@ApiBearerAuth()
@ApiTags("proof-reminders")
@UseGuards(AuthGuard)
@Controller("proofs/reminders")
export class ProofExpirationReminderController {
  constructor(
    private readonly reminderService: ProofExpirationReminderService,
  ) {}

  @ApiOperation({
    summary: "Get proof expiration reminder preferences",
    description: "Returns reminder notification preferences and lead time configurations for the user.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "User reminder preferences.",
    type: ProofReminderPreferencesDto,
  })
  @Get("preferences")
  @AuthenticatedRoute({ ownership: "user" })
  getPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.reminderService.getPreferences(user.id);
  }

  @ApiOperation({
    summary: "Update proof expiration reminder preferences",
    description: "Enables, disables, or customizes expiration reminder lead times.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Updated reminder preferences.",
    type: ProofReminderPreferencesDto,
  })
  @Put("preferences")
  @AuthenticatedRoute({ ownership: "user" })
  updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProofReminderPreferencesDto,
  ) {
    return this.reminderService.updatePreferences(user.id, dto);
  }

  @ApiOperation({
    summary: "Get scheduled reminders for a proof",
    description: "Returns scheduled delivery records for the specified proof owned by the authenticated user.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "List of scheduled reminder deliveries.",
    type: [ProofReminderDeliveryDto],
  })
  @Get(":proofId")
  @AuthenticatedRoute({ ownership: "user" })
  getProofReminders(
    @CurrentUser() user: AuthenticatedUser,
    @Param("proofId") proofId: string,
  ) {
    return this.reminderService.getRemindersForProof(user.id, proofId);
  }
}
