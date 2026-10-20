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
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AuthenticatedUser } from "../auth/auth.types";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { AuthGuard } from "../common/guards/auth.guard";
import {
  PaymentAccountRotationVersionDto,
  RequestPaymentAccountRotationDto,
  RollbackPaymentAccountRotationDto,
  VerifyPaymentAccountRotationDto,
} from "./dto/payment-account-rotation.dto";
import { PaymentAccountRotationService } from "./payment-account-rotation.service";

/**
 * Payment account rotation and checkpoint handoff (#321). Every route acts on
 * the authenticated user's own rotations only; another user's rotation id is
 * answered exactly like an unknown one.
 */
@ApiBearerAuth()
@ApiTags("payments")
@AuthenticatedRoute({ ownership: "user" })
@UseGuards(AuthGuard)
@ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ApiErrorDto })
@Controller("payments/account-rotations")
export class PaymentAccountRotationController {
  constructor(private readonly rotations: PaymentAccountRotationService) {}

  @ApiOperation({ summary: "The account payments are currently indexed from" })
  @ApiResponse({ status: HttpStatus.OK })
  @Get("current")
  current(@CurrentUser() user: AuthenticatedUser) {
    return this.rotations.currentAccount(user);
  }

  @ApiOperation({
    summary: "Request a payment account rotation",
    description:
      "Returns a single-use challenge for the NEW account to sign. Bound to this network, user, both " +
      "accounts and an expiry. Secret keys are refused.",
  })
  @ApiResponse({ status: HttpStatus.CREATED })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Wrong network, not a public account id, secret material, or same as the current account.",
    type: ApiErrorDto,
  })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: "A rotation is already open.", type: ApiErrorDto })
  @Post()
  request(@CurrentUser() user: AuthenticatedUser, @Body() body: RequestPaymentAccountRotationDto) {
    return this.rotations.request(user, body);
  }

  @ApiOperation({ summary: "Read one of your rotations" })
  @ApiParam({ name: "id" })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, type: ApiErrorDto })
  @Get(":id")
  get(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.rotations.get(user, id);
  }

  @ApiOperation({
    summary: "Prove control of the new account",
    description: "Single use: a second attempt, valid or not, is refused.",
  })
  @ApiParam({ name: "id" })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: "Account bound elsewhere, or current account changed.", type: ApiErrorDto })
  @HttpCode(HttpStatus.OK)
  @Post(":id/verify")
  verify(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: VerifyPaymentAccountRotationDto,
  ) {
    return this.rotations.verify(user, id, body.signature);
  }

  @ApiOperation({
    summary: "Activate a verified rotation (checkpoint handoff)",
    description:
      "Captures the current account's final checkpoint, switches indexing to the new account with a fresh " +
      "checkpoint, and queues the planned backfill.",
  })
  @ApiParam({ name: "id" })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "Not verified, stale version, diverged history, or account bound elsewhere.",
    type: ApiErrorDto,
  })
  @HttpCode(HttpStatus.OK)
  @Post(":id/activate")
  activate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: PaymentAccountRotationVersionDto,
  ) {
    return this.rotations.activate(user, id, body.expectedVersion);
  }

  @ApiOperation({ summary: "Roll back an activated rotation within its window" })
  @ApiParam({ name: "id" })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: "Not activated, window elapsed, or superseded.", type: ApiErrorDto })
  @HttpCode(HttpStatus.OK)
  @Post(":id/rollback")
  rollback(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: RollbackPaymentAccountRotationDto,
  ) {
    return this.rotations.rollback(user, id, body);
  }

  @ApiOperation({ summary: "Cancel a rotation that has not been activated" })
  @ApiParam({ name: "id" })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.CONFLICT, type: ApiErrorDto })
  @HttpCode(HttpStatus.OK)
  @Post(":id/cancel")
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: PaymentAccountRotationVersionDto,
  ) {
    return this.rotations.cancel(user, id, body.expectedVersion);
  }
}
