import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, ResourceStatus } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../database/prisma.service";
import {
  isAllowedStatusTransition,
  LIVE_ORGANIZATION_STATUSES,
  ORGANIZATION_OWNER_ROLES,
  transitionRevokesSessions,
} from "../auth/account-status.policy";
import {
  AccountStatusChangeResponseDto,
  AdminUserResponseDto,
  UserProfileResponseDto,
  UserRoleChangeResponseDto,
} from "./dto/user-profile-response.dto";
import { UpdateAccountStatusDto } from "./dto/update-account-status.dto";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { UpdateUserRoleDto } from "./dto/update-user-role.dto";

/** Columns of the caller's own profile. `walletHash` is never selected. */
const PROFILE_SELECT = {
  id: true,
  walletAddress: true,
  displayName: true,
  role: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  lastLoginAt: true,
} satisfies Prisma.UserSelect;

/** Columns of the administrative view: no wallet address, no wallet hash. */
const ADMIN_SELECT = {
  id: true,
  displayName: true,
  role: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  lastLoginAt: true,
} satisfies Prisma.UserSelect;

export const USER_STATUS_CHANGED_ACTION = "user.status_changed";
export const USER_ROLE_CHANGED_ACTION = "user.role_changed";
export const USER_AUDIT_RESOURCE_TYPE = "user";

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's own profile. Identity comes from the session, never a parameter. */
  async getProfile(userId: string): Promise<UserProfileResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: PROFILE_SELECT,
    });
    if (!user) throw new NotFoundException("User not found");
    return user;
  }

  /** Updates the caller's own profile. Only `displayName` is writable. */
  async updateProfile(
    userId: string,
    input: UpdateProfileDto,
  ): Promise<UserProfileResponseDto> {
    if (input.displayName === undefined) {
      return this.getProfile(userId);
    }

    try {
      return await this.prisma.user.update({
        where: { id: userId },
        data: { displayName: input.displayName },
        select: PROFILE_SELECT,
      });
    } catch (error) {
      if (isRecordNotFound(error)) throw new NotFoundException("User not found");
      throw error;
    }
  }

  async getUser(userId: string): Promise<AdminUserResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: ADMIN_SELECT,
    });
    if (!user) throw new NotFoundException("User not found");
    return user;
  }

  /**
   * Moves an account between lifecycle states.
   *
   * Suspension and revocation revoke every live session, and so does
   * reinstatement (see `transitionRevokesSessions`).
   *
   * The status write, the session revocation and the audit record commit
   * together: a suspension that revoked no sessions, or one that left no
   * evidence, cannot be observed. The status write is conditional on the
   * status that was read, so two administrators racing on the same account
   * cannot both succeed from the same starting state.
   */
  async changeStatus(
    actor: AuthenticatedUser,
    userId: string,
    input: UpdateAccountStatusDto,
  ): Promise<AccountStatusChangeResponseDto> {
    if (actor.id === userId) {
      throw new ForbiddenException(
        "Administrators cannot change their own account status",
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: { status: true },
      });
      if (!current) throw new NotFoundException("User not found");

      const previousStatus = current.status;
      if (!isAllowedStatusTransition(previousStatus, input.status)) {
        throw new ConflictException(
          `Account status cannot change from ${previousStatus} to ${input.status}`,
        );
      }

      const updated = await tx.user.updateMany({
        where: { id: userId, status: previousStatus },
        data: { status: input.status },
      });
      if (updated.count !== 1) {
        throw new ConflictException(
          "Account status changed concurrently; reload and retry",
        );
      }

      let sessionsRevoked = 0;
      if (transitionRevokesSessions(previousStatus, input.status)) {
        const revoked = await tx.authSession.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        sessionsRevoked = revoked.count;
      }

      await tx.auditLog.create({
        data: {
          actorType: "user",
          actorId: actor.id,
          action: USER_STATUS_CHANGED_ACTION,
          resourceType: USER_AUDIT_RESOURCE_TYPE,
          resourceId: userId,
          metadata: {
            previousStatus,
            newStatus: input.status,
            reason: input.reason ?? null,
            sessionsRevoked,
          },
        },
      });

      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: ADMIN_SELECT,
      });

      return { ...user, previousStatus, sessionsRevoked };
    });
  }

  /**
   * Changes an account's global role.
   *
   * Role is read from the database on every request by `AuthGuard`, so the
   * change governs the very next request without revoking sessions.
   *
   * Organisation membership policy: ownership is implicit (the creator of an
   * organisation administers it), so an account that still owns a live
   * organisation cannot be moved to a role that may not own one.
   */
  async changeRole(
    actor: AuthenticatedUser,
    userId: string,
    input: UpdateUserRoleDto,
  ): Promise<UserRoleChangeResponseDto> {
    if (actor.id === userId) {
      throw new ForbiddenException(
        "Administrators cannot change their own role",
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: { role: true, status: true },
      });
      if (!current) throw new NotFoundException("User not found");

      if (current.status !== ResourceStatus.ACTIVE) {
        throw new ConflictException("Role changes require an active account");
      }

      const previousRole = current.role;
      if (previousRole === input.role) {
        throw new ConflictException(`User already holds the ${input.role} role`);
      }

      if (!ORGANIZATION_OWNER_ROLES.has(input.role)) {
        const ownedOrganizations = await tx.organization.count({
          where: {
            createdById: userId,
            status: { in: [...LIVE_ORGANIZATION_STATUSES] },
          },
        });
        if (ownedOrganizations > 0) {
          throw new ConflictException(
            `User owns ${ownedOrganizations} live organization(s); retire ownership before assigning the ${input.role} role`,
          );
        }
      }

      const updated = await tx.user.updateMany({
        where: { id: userId, role: previousRole, status: ResourceStatus.ACTIVE },
        data: { role: input.role },
      });
      if (updated.count !== 1) {
        throw new ConflictException(
          "Account changed concurrently; reload and retry",
        );
      }

      await tx.auditLog.create({
        data: {
          actorType: "user",
          actorId: actor.id,
          action: USER_ROLE_CHANGED_ACTION,
          resourceType: USER_AUDIT_RESOURCE_TYPE,
          resourceId: userId,
          metadata: { previousRole, newRole: input.role },
        },
      });

      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: ADMIN_SELECT,
      });

      return { ...user, previousRole };
    });
  }
}

function isRecordNotFound(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2025"
  );
}
