import {
  Body,
  Controller,
  Headers,
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
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { AuthGuard } from "../common/guards/auth.guard";
import { SESSION_AUTH_SCHEME } from "../common/swagger/security-schemes";
import { AuthenticatedSession } from "./auth.types";
import {
  CompleteWalletRotationDto,
  InitiateWalletRotationDto,
  WalletRotationChallengeResponseDto,
  WalletRotationResultResponseDto,
} from "./dto/wallet-rotation.dto";
import { WalletRotationService } from "./wallet-rotation.service";

@ApiTags("auth")
@ApiBearerAuth(SESSION_AUTH_SCHEME)
@ApiResponse({
  status: HttpStatus.UNAUTHORIZED,
  description:
    "Session missing or invalid; or the rotation is expired, replayed, bound to another network or origin, or carries an invalid signature.",
  type: ApiErrorDto,
})
@UseGuards(AuthGuard)
@Controller("auth/wallet-rotation")
export class WalletRotationController {
  constructor(private readonly walletRotationService: WalletRotationService) {}

  @ApiOperation({
    summary: "Begin rotating the account's wallet address",
    description:
      "Returns two messages: one for the current wallet and one for the replacement wallet. " +
      "Both are bound to the network, the application origin and a single-use nonce, and " +
      "expire in 5 minutes. Starting a new rotation cancels any pending one.",
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: WalletRotationChallengeResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Invalid address, or the replacement equals the current wallet.",
    type: ApiErrorDto,
  })
  @Post()
  initiate(
    @CurrentUser() session: AuthenticatedSession,
    @Body() body: InitiateWalletRotationDto,
    @Headers("origin") origin?: string,
  ) {
    return this.walletRotationService.initiate(session, body.newWalletAddress, origin);
  }

  @ApiOperation({
    summary: "Complete a wallet rotation",
    description:
      "Verifies both signatures and, only if both are valid, replaces the account's wallet " +
      "address and revokes every session. The rotation can be attempted once.",
  })
  @ApiResponse({ status: HttpStatus.OK, type: WalletRotationResultResponseDto })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      "The replacement wallet is already bound to an account, or the account's wallet changed.",
    type: ApiErrorDto,
  })
  @HttpCode(HttpStatus.OK)
  @Post(":rotationId/complete")
  complete(
    @CurrentUser() session: AuthenticatedSession,
    @Param("rotationId") rotationId: string,
    @Body() body: CompleteWalletRotationDto,
    @Headers("origin") origin?: string,
  ) {
    return this.walletRotationService.complete(session, rotationId, body, origin);
  }
}
