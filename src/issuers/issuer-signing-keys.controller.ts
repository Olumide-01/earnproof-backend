import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { SESSION_AUTH_SCHEME } from "../common/swagger/security-schemes";
import {
  IssuerSigningKeysService,
  RegisterSigningKeyDto,
} from "./issuer-signing-keys.service";

@ApiTags("issuer-signing-keys")
@AuthenticatedRoute({ ownership: "user" })
@ApiBearerAuth(SESSION_AUTH_SCHEME)
@UseGuards(AuthGuard)
@Controller("issuers/:id/signing-keys")
export class IssuerSigningKeysController {
  constructor(private readonly keysService: IssuerSigningKeysService) {}

  @Get()
  @ApiOperation({ summary: "List active and historical signing keys for an issuer" })
  async listKeys(@Param("id") issuerId: string) {
    return this.keysService.listKeys(issuerId);
  }

  @Post()
  @ApiOperation({ summary: "Register a new signing key commitment for an issuer" })
  async registerKey(
    @Param("id") issuerId: string,
    @Body() dto: RegisterSigningKeyDto,
  ) {
    return this.keysService.registerKey(issuerId, dto);
  }

  @Post(":keyId/retire")
  @ApiOperation({ summary: "Retire a signing key upon rotation" })
  async retireKey(
    @Param("id") issuerId: string,
    @Param("keyId") keyId: string,
  ) {
    return this.keysService.retireKey(issuerId, keyId);
  }

  @Post(":keyId/compromise")
  @ApiOperation({ summary: "Flag a signing key as compromised" })
  async compromiseKey(
    @Param("id") issuerId: string,
    @Param("keyId") keyId: string,
  ) {
    return this.keysService.markCompromised(issuerId, keyId);
  }
}
