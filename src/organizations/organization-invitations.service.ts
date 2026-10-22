import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  OrganizationInvitation,
  OrganizationInvitationStatus,
  OrganizationMemberRole,
  Prisma,
  ResourceStatus,
} from "@prisma/client";
import { randomBytes, timingSafeEqual } from "crypto";
import { AuthenticatedUser } from "../auth/auth.types";
import { sha256 } from "../common/crypto/hash";
import { Clock, SystemClock } from "../common/time/clock";
import { PrismaService } from "../database/prisma.service";
import { AcceptOrganizationInvitationDto } from "./dto/accept-organization-invitation.dto";
import { CreateOrganizationInvitationDto } from "./dto/create-organization-invitation.dto";
import { DeclineOrganizationInvitationDto } from "./dto/decline-organization-invitation.dto";
import { ListOrganizationInvitationsDto } from "./dto/list-organization-invitations.dto";
import {
  CreateOrganizationInvitationResponseDto,
  InspectOrganizationInvitationResponseDto,
  OrganizationInvitationResponseDto,
  PaginatedOrganizationInvitationsDto,
} from "./dto/organization-invitation-response.dto";

/** Minimum invitation TTL: 5 minutes (300 seconds). */
export const MIN_INVITATION_TTL_SECONDS = 300;

/** Default invitation TTL: 7 days (604,800 seconds). */
export const DEFAULT_INVITATION_TTL_SECONDS = 604800;

/** Maximum invitation TTL: 30 days (2,592,000 seconds). */
export const MAX_INVITATION_TTL_SECONDS = 2592000;

@Injectable()
export class OrganizationInvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  /**
   * Create an expiring, single-use invitation for a recipient wallet.
   * Stores ONLY the SHA-256 hash of the generated secret.
   * The raw secret token is returned once to the caller and never stored.
   */
  async createInvitation(
    user: AuthenticatedUser,
    organizationId: string,
    dto: CreateOrganizationInvitationDto,
  ): Promise<CreateOrganizationInvitationResponseDto> {
    const org = await this.getOrganizationOrThrow(organizationId);

    // Verify inviter authorization
    const inviterRole = await this.getCallerOrganizationRole(user.id, organizationId);
    if (user.role !== "ADMIN" && inviterRole !== "OWNER" && inviterRole !== "ADMIN") {
      throw new ForbiddenException(
        "Only organization administrators or owners can create invitations",
      );
    }

    // Role privilege check: only OWNER (or global ADMIN) can invite OWNER
    if (
      dto.role === OrganizationMemberRole.OWNER &&
      inviterRole !== OrganizationMemberRole.OWNER &&
      user.role !== "ADMIN"
    ) {
      throw new ForbiddenException(
        "Only organization owners can invite new owners",
      );
    }

    const recipientWallet = dto.recipientWalletAddress.trim().toUpperCase();

    // Check if the recipient is already a member of this organization
    const existingUser = await this.prisma.user.findUnique({
      where: { walletAddress: recipientWallet },
    });

    if (existingUser) {
      const existingMember = await this.prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId,
            userId: existingUser.id,
          },
        },
      });

      if (existingMember && existingMember.status === ResourceStatus.ACTIVE) {
        throw new ConflictException(
          `User with wallet "${dto.recipientWalletAddress}" is already an active member of this organization`,
        );
      }
    }

    // Bounded expiration
    const ttlSeconds = dto.ttlSeconds ?? DEFAULT_INVITATION_TTL_SECONDS;
    if (
      ttlSeconds < MIN_INVITATION_TTL_SECONDS ||
      ttlSeconds > MAX_INVITATION_TTL_SECONDS
    ) {
      throw new BadRequestException(
        `Invitation TTL must be between ${MIN_INVITATION_TTL_SECONDS} and ${MAX_INVITATION_TTL_SECONDS} seconds`,
      );
    }

    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    // Revoke any previous pending invitations for this wallet in this organization
    await this.prisma.organizationInvitation.updateMany({
      where: {
        organizationId,
        recipientWalletAddress: recipientWallet,
        status: OrganizationInvitationStatus.PENDING,
      },
      data: {
        status: OrganizationInvitationStatus.REVOKED,
        revokedAt: now,
        revokedById: user.id,
      },
    });

    // Generate high-entropy secret
    const rawSecret = randomBytes(32).toString("hex");
    const secretHash = sha256(rawSecret);
    const recipientWalletHash = sha256(recipientWallet);

    const invitation = await this.prisma.organizationInvitation.create({
      data: {
        organizationId,
        role: dto.role,
        inviterId: user.id,
        recipientWalletAddress: recipientWallet,
        recipientWalletHash,
        secretHash,
        status: OrganizationInvitationStatus.PENDING,
        expiresAt,
      },
    });

    // Token format: <invitationId>.<rawSecret>
    const token = `${invitation.id}.${rawSecret}`;

    // Audit log: NO secrets, NO raw tokens, wallet hash only
    await this.createAuditLog(
      user,
      "organization.invitation.created",
      "OrganizationInvitation",
      invitation.id,
      {
        organizationId,
        invitationId: invitation.id,
        role: invitation.role,
        recipientWalletHash,
        expiresAt: invitation.expiresAt.toISOString(),
      },
    );

    return {
      ...this.toResponseDto(invitation),
      token,
    };
  }

  /**
   * Inspect an invitation by raw token or by invitation ID.
   * Returns safe details (role, org, recipient wallet, status, expiry)
   * without exposing secrets or secret hashes.
   */
  async inspectInvitation(
    tokenOrId: string,
    organizationId?: string,
  ): Promise<InspectOrganizationInvitationResponseDto> {
    const invitation = await this.resolveInvitation(tokenOrId);

    if (organizationId && invitation.organizationId !== organizationId) {
      throw new ForbiddenException(
        "Invitation does not belong to specified organization",
      );
    }

    const now = this.clock.now();
    let effectiveStatus = invitation.status;
    if (
      effectiveStatus === OrganizationInvitationStatus.PENDING &&
      now >= invitation.expiresAt
    ) {
      effectiveStatus = OrganizationInvitationStatus.EXPIRED;
    }

    return {
      id: invitation.id,
      organizationId: invitation.organizationId,
      organizationName: invitation.organization?.name || "",
      role: invitation.role,
      recipientWalletAddress: invitation.recipientWalletAddress,
      status: effectiveStatus,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
      inviterId: invitation.inviterId,
    };
  }

  /**
   * Accept an invitation and atomically create an active organization membership.
   * Fails closed on wrong-wallet, replay, expired, revoked, or cross-tenant attempts.
   */
  async acceptInvitation(
    user: AuthenticatedUser,
    input: AcceptOrganizationInvitationDto,
    routeOrgId?: string,
  ): Promise<{
    invitation: OrganizationInvitationResponseDto;
    membership: { id: string; organizationId: string; userId: string; role: OrganizationMemberRole };
  }> {
    const invitation = await this.resolveInvitation(input.token);

    // Cross-tenant verification
    const expectedOrgId = routeOrgId || input.organizationId;
    if (expectedOrgId && invitation.organizationId !== expectedOrgId) {
      throw new ForbiddenException(
        "Invitation does not belong to specified organization",
      );
    }

    // Wrong-wallet verification
    const userWallet = (user.walletAddress || "").trim().toUpperCase();
    const recipientWallet = (invitation.recipientWalletAddress || "").trim().toUpperCase();
    if (userWallet !== recipientWallet) {
      throw new ForbiddenException(
        "Invitation was issued for a different wallet address",
      );
    }

    // Revoked check
    if (
      invitation.status === OrganizationInvitationStatus.REVOKED ||
      invitation.revokedAt != null
    ) {
      throw new ConflictException("Invitation has been revoked");
    }

    // Declined check
    if (
      invitation.status === OrganizationInvitationStatus.DECLINED ||
      invitation.declinedAt != null
    ) {
      throw new ConflictException("Invitation has been declined");
    }

    // Replay check
    if (
      invitation.status === OrganizationInvitationStatus.ACCEPTED ||
      invitation.acceptedAt != null
    ) {
      throw new ConflictException("Invitation has already been accepted");
    }

    // Expiry check
    const now = this.clock.now();
    if (
      invitation.status === OrganizationInvitationStatus.EXPIRED ||
      now >= invitation.expiresAt
    ) {
      throw new BadRequestException("Invitation has expired");
    }

    // Atomic consumption and membership creation
    return await this.prisma.$transaction(async (tx) => {
      // Conditional update ensures only one concurrent request transitions PENDING -> ACCEPTED
      const updated = await tx.organizationInvitation.updateMany({
        where: {
          id: invitation.id,
          status: OrganizationInvitationStatus.PENDING,
          expiresAt: { gt: now },
        },
        data: {
          status: OrganizationInvitationStatus.ACCEPTED,
          acceptedAt: now,
          acceptedById: user.id,
        },
      });

      if (updated.count === 0) {
        throw new ConflictException(
          "Invitation is no longer pending or has already been accepted/expired",
        );
      }

      // Check if user is already a member
      const existingMember = await tx.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: invitation.organizationId,
            userId: user.id,
          },
        },
      });

      if (existingMember) {
        throw new ConflictException(
          "User is already a member of this organization",
        );
      }

      // Create membership atomically
      const member = await tx.organizationMember.create({
        data: {
          organizationId: invitation.organizationId,
          userId: user.id,
          role: invitation.role,
          status: ResourceStatus.ACTIVE,
          joinedAt: now,
        },
      });

      // Audit log inside the transaction
      await this.createAuditLog(
        user,
        "organization.invitation.accepted",
        "OrganizationInvitation",
        invitation.id,
        {
          organizationId: invitation.organizationId,
          invitationId: invitation.id,
          role: invitation.role,
          recipientWalletHash: invitation.recipientWalletHash,
          memberId: member.id,
        },
        tx,
      );

      const acceptedInvitation: OrganizationInvitation = {
        ...invitation,
        status: OrganizationInvitationStatus.ACCEPTED,
        acceptedAt: now,
        acceptedById: user.id,
      };

      return {
        invitation: this.toResponseDto(acceptedInvitation),
        membership: {
          id: member.id,
          organizationId: member.organizationId,
          userId: member.userId,
          role: member.role,
        },
      };
    });
  }

  /**
   * Decline a pending invitation.
   * Fails closed on wrong-wallet, replay, expired, revoked, or cross-tenant attempts.
   */
  async declineInvitation(
    user: AuthenticatedUser,
    input: DeclineOrganizationInvitationDto,
    routeOrgId?: string,
  ): Promise<OrganizationInvitationResponseDto> {
    const invitation = await this.resolveInvitation(input.token);

    // Cross-tenant verification
    const expectedOrgId = routeOrgId || input.organizationId;
    if (expectedOrgId && invitation.organizationId !== expectedOrgId) {
      throw new ForbiddenException(
        "Invitation does not belong to specified organization",
      );
    }

    // Wrong-wallet verification
    const userWallet = (user.walletAddress || "").trim().toUpperCase();
    const recipientWallet = (invitation.recipientWalletAddress || "").trim().toUpperCase();
    if (userWallet !== recipientWallet) {
      throw new ForbiddenException(
        "Invitation was issued for a different wallet address",
      );
    }

    // Status checks
    if (invitation.status === OrganizationInvitationStatus.REVOKED) {
      throw new ConflictException("Invitation has been revoked");
    }
    if (invitation.status === OrganizationInvitationStatus.ACCEPTED) {
      throw new ConflictException("Invitation has already been accepted");
    }
    if (invitation.status === OrganizationInvitationStatus.DECLINED) {
      throw new ConflictException("Invitation has already been declined");
    }

    const now = this.clock.now();
    if (now >= invitation.expiresAt) {
      throw new BadRequestException("Invitation has expired");
    }

    return await this.prisma.$transaction(async (tx) => {
      const updated = await tx.organizationInvitation.updateMany({
        where: {
          id: invitation.id,
          status: OrganizationInvitationStatus.PENDING,
          expiresAt: { gt: now },
        },
        data: {
          status: OrganizationInvitationStatus.DECLINED,
          declinedAt: now,
          declinedById: user.id,
        },
      });

      if (updated.count === 0) {
        throw new ConflictException("Invitation is no longer pending");
      }

      await this.createAuditLog(
        user,
        "organization.invitation.declined",
        "OrganizationInvitation",
        invitation.id,
        {
          organizationId: invitation.organizationId,
          invitationId: invitation.id,
          recipientWalletHash: invitation.recipientWalletHash,
        },
        tx,
      );

      const declinedInvitation: OrganizationInvitation = {
        ...invitation,
        status: OrganizationInvitationStatus.DECLINED,
        declinedAt: now,
        declinedById: user.id,
      };

      return this.toResponseDto(declinedInvitation);
    });
  }

  /**
   * Revoke an active or pending organization invitation.
   * Only organization administrators or owners can revoke invitations.
   */
  async revokeInvitation(
    user: AuthenticatedUser,
    organizationId: string,
    invitationId: string,
  ): Promise<OrganizationInvitationResponseDto> {
    await this.ensureCanManageOrganization(user, organizationId);

    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation || invitation.organizationId !== organizationId) {
      throw new NotFoundException("Invitation not found");
    }

    if (invitation.status === OrganizationInvitationStatus.ACCEPTED) {
      throw new ConflictException(
        "Cannot revoke an already accepted invitation",
      );
    }

    if (invitation.status === OrganizationInvitationStatus.REVOKED) {
      return this.toResponseDto(invitation);
    }

    const now = this.clock.now();
    const revoked = await this.prisma.organizationInvitation.update({
      where: { id: invitationId },
      data: {
        status: OrganizationInvitationStatus.REVOKED,
        revokedAt: now,
        revokedById: user.id,
      },
    });

    await this.createAuditLog(
      user,
      "organization.invitation.revoked",
      "OrganizationInvitation",
      revoked.id,
      {
        organizationId,
        invitationId: revoked.id,
        role: revoked.role,
        recipientWalletHash: revoked.recipientWalletHash,
      },
    );

    return this.toResponseDto(revoked);
  }

  /**
   * List invitations for an organization.
   * Only organization administrators or owners can list invitations.
   */
  async listInvitations(
    user: AuthenticatedUser,
    organizationId: string,
    query: ListOrganizationInvitationsDto,
  ): Promise<PaginatedOrganizationInvitationsDto> {
    await this.ensureCanManageOrganization(user, organizationId);

    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.OrganizationInvitationWhereInput = {
      organizationId,
      ...(query.status ? { status: query.status } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.organizationInvitation.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.organizationInvitation.count({ where }),
    ]);

    return {
      items: items.map((inv) => this.toResponseDto(inv)),
      total,
      page,
      limit,
    };
  }

  /**
   * Get an invitation by ID within an organization.
   */
  async getInvitation(
    user: AuthenticatedUser,
    organizationId: string,
    invitationId: string,
  ): Promise<OrganizationInvitationResponseDto> {
    await this.ensureCanManageOrganization(user, organizationId);

    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation || invitation.organizationId !== organizationId) {
      throw new NotFoundException("Invitation not found");
    }

    return this.toResponseDto(invitation);
  }

  /**
   * Reconcile/cleanup expired invitations by transitioning PENDING invitations
   * past expiresAt to EXPIRED status.
   */
  async cleanupExpiredInvitations(
    organizationId?: string,
  ): Promise<{ reconciledCount: number }> {
    const now = this.clock.now();
    const where: Prisma.OrganizationInvitationWhereInput = {
      ...(organizationId ? { organizationId } : {}),
      status: OrganizationInvitationStatus.PENDING,
      expiresAt: { lte: now },
    };

    const result = await this.prisma.organizationInvitation.updateMany({
      where,
      data: {
        status: OrganizationInvitationStatus.EXPIRED,
      },
    });

    return { reconciledCount: result.count };
  }

  // ---------------------------------------------------------------------------
  // Helper methods
  // ---------------------------------------------------------------------------

  /**
   * Resolves an invitation record by token or id.
   * If token is <id>.<secret>, look up by id and verify secret in constant time.
   * If token is a raw secret, look up by secretHash.
   */
  private async resolveInvitation(tokenOrId: string): Promise<OrganizationInvitation & { organization: { name: string } }> {
    if (!tokenOrId || typeof tokenOrId !== "string") {
      throw new NotFoundException("Invitation not found or invalid token");
    }

    const trimmed = tokenOrId.trim();

    // Check if token has <id>.<secret> format
    const dotIndex = trimmed.indexOf(".");
    if (dotIndex > 0) {
      const id = trimmed.substring(0, dotIndex);
      const secret = trimmed.substring(dotIndex + 1);

      const invitation = await this.prisma.organizationInvitation.findUnique({
        where: { id },
        include: { organization: { select: { name: true } } },
      });

      if (!invitation) {
        throw new NotFoundException("Invitation not found or invalid token");
      }

      const computedHash = sha256(secret);
      if (!this.safeEqual(computedHash, invitation.secretHash)) {
        throw new NotFoundException("Invitation not found or invalid token");
      }

      return invitation;
    }

    // Try lookup by secretHash
    const secretHash = sha256(trimmed);
    let invitation = await this.prisma.organizationInvitation.findUnique({
      where: { secretHash },
      include: { organization: { select: { name: true } } },
    });

    if (invitation) {
      return invitation;
    }

    // Fallback: try lookup by cuid id
    invitation = await this.prisma.organizationInvitation.findUnique({
      where: { id: trimmed },
      include: { organization: { select: { name: true } } },
    });

    if (invitation) {
      return invitation;
    }

    throw new NotFoundException("Invitation not found or invalid token");
  }

  private safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  }

  private async getOrganizationOrThrow(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!org) {
      throw new NotFoundException(`Organization "${organizationId}" not found`);
    }

    if (org.archivedAt) {
      throw new ForbiddenException("Organization is archived");
    }

    if (org.deletedAt) {
      throw new NotFoundException("Organization has been deleted");
    }

    return org;
  }

  private async getCallerOrganizationRole(
    userId: string,
    organizationId: string,
  ): Promise<OrganizationMemberRole | null> {
    const member = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId,
        },
      },
    });

    return member && member.status === ResourceStatus.ACTIVE ? member.role : null;
  }

  private async ensureCanManageOrganization(
    user: AuthenticatedUser,
    organizationId: string,
  ): Promise<void> {
    if (user.role === "ADMIN") {
      return;
    }

    const role = await this.getCallerOrganizationRole(user.id, organizationId);
    if (!role || (role !== "OWNER" && role !== "ADMIN")) {
      throw new ForbiddenException(
        "You do not have administrative permissions in this organization",
      );
    }
  }

  private createAuditLog(
    user: AuthenticatedUser,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown>,
    tx?: Prisma.TransactionClient,
  ) {
    const data: Prisma.AuditLogCreateArgs = {
      data: {
        actorId: user.id,
        actorType: "User",
        action,
        resourceType,
        resourceId,
        organizationId: metadata.organizationId as string | undefined,
        metadata: metadata as any,
        createdAt: new Date(),
      },
    };

    if (tx) {
      return this.prisma.appendAuditLog(tx, data);
    }
    return this.prisma.auditLog.create(data);
  }

  toResponseDto(invitation: OrganizationInvitation): OrganizationInvitationResponseDto {
    return {
      id: invitation.id,
      organizationId: invitation.organizationId,
      role: invitation.role,
      inviterId: invitation.inviterId,
      recipientWalletAddress: invitation.recipientWalletAddress,
      recipientWalletHash: invitation.recipientWalletHash,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt,
      acceptedById: invitation.acceptedById,
      declinedAt: invitation.declinedAt,
      declinedById: invitation.declinedById,
      revokedAt: invitation.revokedAt,
      revokedById: invitation.revokedById,
      createdAt: invitation.createdAt,
      updatedAt: invitation.updatedAt,
    };
  }
}
