import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WebhookCertificateStatus, WebhookClientCertificate } from "@prisma/client";
import { X509Certificate, createHash } from "crypto";
import { PaymentEncryptionKeyringService } from "../common/crypto/payment-encryption-keyring.service";
import { PrismaService } from "../database/prisma.service";
import { AddClientCertificateDto } from "./dto/add-client-certificate.dto";

@Injectable()
export class WebhookClientCertificateService {
  private readonly paymentEncryptionKeyring: PaymentEncryptionKeyringService;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.paymentEncryptionKeyring = new PaymentEncryptionKeyringService(configService);
  }

  /**
   * Register a client certificate for a webhook. The certificate is parsed
   * and validated (well-formed, not already expired, valid date range)
   * before being stored — a certificate that fails validation is rejected
   * outright so it can never be selected for delivery. Stored as PENDING;
   * {@link activate} promotes it.
   */
  async add(
    organizationId: string,
    webhookId: string,
    dto: AddClientCertificateDto,
  ): Promise<Omit<WebhookClientCertificate, "privateKeyEncrypted">> {
    await this.assertOwnedWebhook(organizationId, webhookId);

    let cert: X509Certificate;
    try {
      cert = new X509Certificate(dto.certificatePem);
    } catch {
      throw new BadRequestException("certificatePem is not a valid X.509 certificate");
    }

    const notBefore = new Date(dto.notBefore);
    const notAfter = new Date(dto.notAfter);

    if (!(notBefore.getTime() < notAfter.getTime())) {
      throw new BadRequestException("notBefore must be earlier than notAfter");
    }
    if (notAfter.getTime() <= Date.now()) {
      throw new BadRequestException("Refusing to register a certificate that has already expired");
    }

    const certValidFrom = new Date(cert.validFrom);
    const certValidTo = new Date(cert.validTo);
    if (notBefore.getTime() < certValidFrom.getTime() || notAfter.getTime() > certValidTo.getTime()) {
      throw new BadRequestException(
        "Declared validity window exceeds the certificate's own validity period",
      );
    }

    const fingerprintSha256 = createHash("sha256")
      .update(cert.raw)
      .digest("hex");

    const privateKeyEncrypted = this.paymentEncryptionKeyring.encrypt(dto.privateKeyPem);

    const created = await this.prisma.webhookClientCertificate.create({
      data: {
        webhookId,
        certificatePem: dto.certificatePem,
        privateKeyEncrypted,
        fingerprintSha256,
        notBefore,
        notAfter,
        status: WebhookCertificateStatus.PENDING,
      },
    });

    return this.withoutKey(created);
  }

  /**
   * Activate a PENDING or ROTATING certificate as the webhook's current
   * client certificate. Any previously ACTIVE certificate is retired in the
   * same transaction, so at most one certificate is ACTIVE at a time.
   */
  async activate(
    organizationId: string,
    webhookId: string,
    certificateId: string,
  ): Promise<Omit<WebhookClientCertificate, "privateKeyEncrypted">> {
    await this.assertOwnedWebhook(organizationId, webhookId);

    const candidate = await this.prisma.webhookClientCertificate.findUnique({
      where: { id: certificateId },
    });

    if (!candidate || candidate.webhookId !== webhookId) {
      throw new NotFoundException(`Certificate ${certificateId} not found for this webhook`);
    }
    if (candidate.notAfter.getTime() <= Date.now()) {
      throw new BadRequestException("Cannot activate a certificate that has already expired");
    }
    if (
      candidate.status !== WebhookCertificateStatus.PENDING &&
      candidate.status !== WebhookCertificateStatus.ROTATING
    ) {
      throw new BadRequestException(
        `Certificate must be PENDING or ROTATING to activate (currently ${candidate.status})`,
      );
    }

    const [, activated] = await this.prisma.$transaction([
      // The outgoing certificate moves to ROTATING rather than being retired
      // outright: it immediately stops being selected for new deliveries
      // (selectActiveCertificate only matches ACTIVE) but can still be
      // re-activated by an operator during a rollback.
      this.prisma.webhookClientCertificate.updateMany({
        where: { webhookId, status: WebhookCertificateStatus.ACTIVE },
        data: { status: WebhookCertificateStatus.ROTATING },
      }),
      this.prisma.webhookClientCertificate.update({
        where: { id: certificateId },
        data: { status: WebhookCertificateStatus.ACTIVE, activatedAt: new Date() },
      }),
    ]);

    return this.withoutKey(activated);
  }

  /**
   * Resolve the certificate to present for an outbound mTLS delivery.
   * Returns `null` if there is no currently valid ACTIVE certificate — the
   * caller must treat that as a delivery failure, never fall back to an
   * unauthenticated connection.
   */
  async selectActiveCertificate(
    webhookId: string,
  ): Promise<{ certificatePem: string; privateKeyPem: string } | null> {
    const active = await this.prisma.webhookClientCertificate.findFirst({
      where: {
        webhookId,
        status: WebhookCertificateStatus.ACTIVE,
        notAfter: { gt: new Date() },
      },
    });

    if (!active) {
      return null;
    }

    return {
      certificatePem: active.certificatePem,
      privateKeyPem: this.paymentEncryptionKeyring.decrypt(active.privateKeyEncrypted),
    };
  }

  /** Sweep certificates past their notAfter into EXPIRED. Returns the count affected. */
  async expireStale(): Promise<number> {
    const result = await this.prisma.webhookClientCertificate.updateMany({
      where: {
        status: { in: [WebhookCertificateStatus.ACTIVE, WebhookCertificateStatus.PENDING, WebhookCertificateStatus.ROTATING] },
        notAfter: { lt: new Date() },
      },
      data: { status: WebhookCertificateStatus.EXPIRED, retiredAt: new Date() },
    });
    return result.count;
  }

  private withoutKey(
    cert: WebhookClientCertificate,
  ): Omit<WebhookClientCertificate, "privateKeyEncrypted"> {
    const { privateKeyEncrypted, ...rest } = cert;
    void privateKeyEncrypted;
    return rest;
  }

  private async assertOwnedWebhook(organizationId: string, webhookId: string): Promise<void> {
    const webhook = await this.prisma.webhook.findUnique({
      where: { id: webhookId },
      select: { organizationId: true },
    });

    if (!webhook) {
      throw new NotFoundException(`Webhook ${webhookId} not found`);
    }
    if (webhook.organizationId !== organizationId) {
      throw new ForbiddenException("Webhook does not belong to this organisation");
    }
  }
}
