import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "../common/guards/auth.guard";
import { AddClientCertificateDto } from "./dto/add-client-certificate.dto";
import { WebhookClientCertificateService } from "./webhook-client-certificate.service";

@ApiBearerAuth()
@ApiTags("webhooks")
@Controller("organizations/:organizationId/webhooks/:webhookId/certificates")
@UseGuards(AuthGuard)
export class WebhookClientCertificatesController {
  constructor(private readonly certificates: WebhookClientCertificateService) {}

  @Post()
  @ApiOperation({ summary: "Register a client certificate for mTLS delivery" })
  add(
    @Param("organizationId") organizationId: string,
    @Param("webhookId") webhookId: string,
    @Body() dto: AddClientCertificateDto,
  ) {
    return this.certificates.add(organizationId, webhookId, dto);
  }

  @Post(":certificateId/activate")
  @ApiOperation({ summary: "Activate a registered certificate, retiring the current one" })
  activate(
    @Param("organizationId") organizationId: string,
    @Param("webhookId") webhookId: string,
    @Param("certificateId") certificateId: string,
  ) {
    return this.certificates.activate(organizationId, webhookId, certificateId);
  }
}
