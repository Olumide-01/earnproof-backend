import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { SupportAccessStatus } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { CreateSupportAccessGrantDto, RevokeSupportAccessGrantDto } from "./dto/support-access.dto";

@Injectable()
export class SupportAccessService {
  private readonly logger = new Logger(SupportAccessService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Request or create a time-limited support access grant for an organization.
   */
  async createGrant(
    organizationId: string,
    requestedById: string,
    dto: CreateSupportAccessGrantDto,
  ) {
    const expiresAt = new Date(Date.now() + dto.durationMinutes * 60 * 1000);

    const grant = await this.prisma.supportAccessGrant.create({
      data: {
        organizationId,
        supportUserId: dto.supportUserId,
        requestedById,
        reason: dto.reason,
        capabilities: dto.capabilities,
        status: SupportAccessStatus.PENDING,
        expiresAt,
      },
    });

    this.logger.log(`Created support access grant ${grant.id} for org ${organizationId}`);
    return grant;
  }

  /**
   * Approves a pending grant. Approval must be performed by a tenant admin (not requester).
   */
  async approveGrant(grantId: string, approvedById: string) {
    const grant = await this.prisma.supportAccessGrant.findUnique({
      where: { id: grantId },
    });

    if (!grant) {
      throw new NotFoundException(`Support access grant ${grantId} not found`);
    }

    if (grant.requestedById === approvedById) {
      throw new ForbiddenException("Requester cannot approve their own support access grant");
    }

    if (grant.status !== SupportAccessStatus.PENDING) {
      throw new BadRequestException(`Cannot approve grant in status ${grant.status}`);
    }

    if (new Date() > grant.expiresAt) {
      await this.prisma.supportAccessGrant.update({
        where: { id: grantId },
        data: { status: SupportAccessStatus.EXPIRED },
      });
      throw new BadRequestException("Grant has already expired");
    }

    return this.prisma.supportAccessGrant.update({
      where: { id: grantId },
      data: {
        status: SupportAccessStatus.APPROVED,
        approvedById,
      },
    });
  }

  /**
   * Activates an approved grant when support begins session.
   */
  async activateGrant(grantId: string, supportUserId: string) {
    const grant = await this.prisma.supportAccessGrant.findUnique({
      where: { id: grantId },
    });

    if (!grant) {
      throw new NotFoundException(`Support access grant ${grantId} not found`);
    }

    if (grant.supportUserId !== supportUserId) {
      throw new ForbiddenException("Only the designated support agent can activate this grant");
    }

    if (grant.status !== SupportAccessStatus.APPROVED) {
      throw new BadRequestException(`Cannot activate grant in status ${grant.status}`);
    }

    if (new Date() > grant.expiresAt) {
      await this.prisma.supportAccessGrant.update({
        where: { id: grantId },
        data: { status: SupportAccessStatus.EXPIRED },
      });
      throw new BadRequestException("Grant has already expired");
    }

    return this.prisma.supportAccessGrant.update({
      where: { id: grantId },
      data: {
        status: SupportAccessStatus.ACTIVE,
        activatedAt: new Date(),
      },
    });
  }

  /**
   * Asserts whether a support agent currently holds a valid, active grant with the requested capability.
   */
  async assertActiveCapability(
    organizationId: string,
    supportUserId: string,
    capability: string,
  ): Promise<boolean> {
    const now = new Date();
    const grant = await this.prisma.supportAccessGrant.findFirst({
      where: {
        organizationId,
        supportUserId,
        status: SupportAccessStatus.ACTIVE,
        expiresAt: { gt: now },
      },
    });

    if (!grant) {
      return false;
    }

    const caps = grant.capabilities as string[];
    if (!Array.isArray(caps) || !caps.includes(capability)) {
      return false;
    }

    return true;
  }

  /**
   * Explicit early revocation of a support grant.
   */
  async revokeGrant(
    grantId: string,
    revokedById: string,
    dto: RevokeSupportAccessGrantDto,
  ) {
    const grant = await this.prisma.supportAccessGrant.findUnique({
      where: { id: grantId },
    });

    if (!grant) {
      throw new NotFoundException(`Support access grant ${grantId} not found`);
    }

    if (grant.status === SupportAccessStatus.REVOKED || grant.status === SupportAccessStatus.EXPIRED) {
      return grant;
    }

    return this.prisma.supportAccessGrant.update({
      where: { id: grantId },
      data: {
        status: SupportAccessStatus.REVOKED,
        revokedAt: new Date(),
        revokedById,
        revocationReason: dto.reason,
      },
    });
  }
}
