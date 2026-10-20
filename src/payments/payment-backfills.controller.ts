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
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthenticatedUser } from "../auth/auth.types";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequiredRole } from "../common/decorators/required-role.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { CreatePaymentBackfillDto } from "./dto/create-payment-backfill.dto";
import { PaymentBackfillResponseDto } from "./dto/payment-backfill-response.dto";
import { PaymentBackfillService } from "./payment-backfill.service";

/**
 * Operator endpoints for bounded ledger-range payment backfills. Requests only
 * persist or change job state; the scan itself runs in the background worker,
 * so no API request waits on Horizon.
 */
@ApiBearerAuth()
@ApiTags("payment-backfills")
@AuthenticatedRoute({ roles: ["ADMIN"] })
@UseGuards(AuthGuard, RoleGuard)
@Controller("payment-backfills")
export class PaymentBackfillsController {
  constructor(private readonly backfills: PaymentBackfillService) {}

  @ApiOperation({
    summary: "Request a ledger-range payment backfill",
    description:
      "Admin only. Queues a rescan of one user's incoming payments over an inclusive ledger range of at most " +
      "120960 ledgers. Overlapping active jobs for the same user are rejected.",
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: PaymentBackfillResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "The range is inverted, out of bounds, or too large.",
    type: ApiErrorDto,
  })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ApiErrorDto })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Admin role required.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "User not found.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "An active backfill for this user overlaps the range.",
    type: ApiErrorDto,
  })
  @RequiredRole("ADMIN")
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreatePaymentBackfillDto,
  ) {
    return this.backfills.createJob(user, body);
  }

  @ApiOperation({ summary: "Get a payment backfill job (admin only)" })
  @ApiParam({ name: "id" })
  @ApiResponse({ status: HttpStatus.OK, type: PaymentBackfillResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ApiErrorDto })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, type: ApiErrorDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, type: ApiErrorDto })
  @RequiredRole("ADMIN")
  @Get(":id")
  get(@Param("id") id: string) {
    return this.backfills.getJob(id);
  }

  @ApiOperation({
    summary: "Cancel a payment backfill job (admin only)",
    description:
      "A pending job is cancelled immediately. A running job stops at its next page boundary; pages already " +
      "committed are kept.",
  })
  @ApiParam({ name: "id" })
  @ApiResponse({ status: HttpStatus.OK, type: PaymentBackfillResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ApiErrorDto })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, type: ApiErrorDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, type: ApiErrorDto })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "The job already finished or is being cancelled.",
    type: ApiErrorDto,
  })
  @RequiredRole("ADMIN")
  @HttpCode(HttpStatus.OK)
  @Post(":id/cancel")
  cancel(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.backfills.cancelJob(user, id);
  }
}
