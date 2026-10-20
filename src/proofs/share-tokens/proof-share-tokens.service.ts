import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  ProofShareScope,
  ProofShareToken,
  ProofStatus,
} from "@prisma/client";
import { randomBytes } from "crypto";
import { AuthenticatedUser } from "../../auth/auth.types";
import { sha256 } from "../../common/crypto/hash";
import { ApiErrorCode } from "../../common/dto/api-error.dto";
import { PrismaService } from "../../database/prisma.service";
import { ProofsService } from "../proofs.service";
import { CreateProofShareTokenDto } from "./dto/share-token.dto";

/** Share tokens are `eps_` + 32 random bytes, base64url (43 chars). */
const TOKEN_PREFIX = "eps_";
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^eps_[A-Za-z0-9_-]{43}$/;

const DEFAULT_TTL_MINUTES = 1_440;
const MAX_TTL_MINUTES = 10_080;

/**
 * One uniform answer for every unusable token. Unknown, malformed, revoked,
 * expired, superseded, and exhausted tokens are indistinguishable to the
 * caller, so the endpoint cannot be used to probe which tokens exist.
 */
const INVALID_SHARE = "Share link is invalid or has expired";

/**
 * Time-limited, scoped sharing of a single proof (#197).
 *
 * Security properties, and where each one is enforced:
 *
 * - **Raw token shown once.** Only a SHA-256 hash is stored; the raw value is
 *   returned from {@link issue} and nowhere else.
 * - **Immutable scope.** No code path updates scope, proof, owner, expiry, or
 *   use limit. The database trigger `ProofShareToken_immutable` rejects any
 *   such update as well.
 * - **Fail closed.** A token is usable only while it is not revoked, not
 *   superseded, not expired, not exhausted, and still owned by the proof's
 *   owner. Use is consumed by one conditional UPDATE, so a revocation or the
 *   last permitted use racing a request cannot be bypassed.
 * - **Tenant isolation.** Issue, list, and revoke are all filtered by the
 *   proof owner; another user's proof or token is reported as not found.
 * - **No session exposure.** Resolution is unauthenticated, reads no session,
 *   and returns only proof verification data.
 */
@Injectable()
export class ProofShareTokensService {
  private readonly maxTtlMinutes: number;
  private readonly defaultTtlMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly proofsService: ProofsService,
    configService: ConfigService,
  ) {
    this.maxTtlMinutes =
      configService.get<number>("proofSharing.maxTtlMinutes") ??
      MAX_TTL_MINUTES;
    this.defaultTtlMinutes =
      configService.get<number>("proofSharing.defaultTtlMinutes") ??
      DEFAULT_TTL_MINUTES;
  }

  /**
   * Issue a share token for a proof the caller owns.
   *
   * Issuing supersedes any live token for the same proof and scope, in the
   * same transaction. A partial unique index guarantees at most one live
   * token per (proof, scope) even under concurrent issuance.
   */
  async issue(
    user: AuthenticatedUser,
    proofId: string,
    input: CreateProofShareTokenDto,
  ) {
    const ttlMinutes = input.expiresInMinutes ?? this.defaultTtlMinutes;
    if (ttlMinutes > this.maxTtlMinutes) {
      throw new BadRequestException(
        `expiresInMinutes must not exceed ${this.maxTtlMinutes}`,
      );
    }

    const proof = await this.prisma.proof.findFirst({
      where: { id: proofId, userId: user.id },
      select: { id: true, status: true, expiresAt: true },
    });
    if (!proof) {
      throw new NotFoundException("Proof not found");
    }

    const now = new Date();
    if (proof.status !== ProofStatus.ACTIVE || proof.expiresAt <= now) {
      throw new UnprocessableEntityException({
        code: ApiErrorCode.PROOF_NOT_SHAREABLE,
        message: "Only active, unexpired proofs can be shared",
      });
    }

    // A share never outlives the proof it discloses.
    const requestedExpiry = new Date(now.getTime() + ttlMinutes * 60_000);
    const expiresAt =
      requestedExpiry < proof.expiresAt ? requestedExpiry : proof.expiresAt;

    const rawToken = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
    const tokenHash = sha256(rawToken);

    let created: ProofShareToken;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const live = await tx.proofShareToken.findMany({
          where: {
            proofId: proof.id,
            ownerId: user.id,
            scope: input.scope,
            revokedAt: null,
            supersededAt: null,
          },
          select: { id: true },
        });
        const liveIds = live.map((t) => t.id);

        if (liveIds.length > 0) {
          await tx.proofShareToken.updateMany({
            where: { id: { in: liveIds }, supersededAt: null, revokedAt: null },
            data: { supersededAt: now },
          });
        }

        const token = await tx.proofShareToken.create({
          data: {
            proofId: proof.id,
            ownerId: user.id,
            tokenHash,
            scope: input.scope,
            label: input.label ?? null,
            maxUses: input.maxUses ?? null,
            expiresAt,
            createdAt: now,
          },
        });

        if (liveIds.length > 0) {
          await tx.proofShareToken.updateMany({
            where: { id: { in: liveIds } },
            data: { supersededById: token.id },
          });
        }

        // Audit identifiers only — never the raw token or its hash.
        await tx.auditLog.create({
          data: {
            actorType: "user",
            actorId: user.id,
            action: "proof.share_token.issued",
            resourceType: "proofShareToken",
            resourceId: token.id,
            metadata: {
              proofId: proof.id,
              scope: input.scope,
              expiresAt: expiresAt.toISOString(),
              maxUses: input.maxUses ?? null,
              superseded: liveIds,
            },
          },
        });

        return token;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        // A concurrent issuance for the same proof and scope won the race.
        throw new ConflictException(
          "Another share token for this proof and scope was issued concurrently",
        );
      }
      throw error;
    }

    return {
      // Returned exactly once. Never stored, never retrievable again.
      token: rawToken,
      shareToken: this.toView(created),
    };
  }

  /** Live, usable tokens for a proof the caller owns. Metadata only. */
  async listActive(user: AuthenticatedUser, proofId: string) {
    await this.assertOwnedProof(user, proofId);

    const now = new Date();
    const tokens = await this.prisma.proofShareToken.findMany({
      where: {
        proofId,
        ownerId: user.id,
        revokedAt: null,
        supersededAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
    });

    return tokens
      .filter((t) => t.maxUses === null || t.useCount < t.maxUses)
      .map((t) => this.toView(t));
  }

  /** Revoke a token. Idempotent; revocation is terminal. */
  async revoke(user: AuthenticatedUser, proofId: string, tokenId: string) {
    const now = new Date();
    const scoped = { id: tokenId, proofId, ownerId: user.id };

    const result = await this.prisma.proofShareToken.updateMany({
      where: { ...scoped, revokedAt: null },
      data: { revokedAt: now },
    });

    if (result.count === 0) {
      const existing = await this.prisma.proofShareToken.findFirst({
        where: scoped,
        select: { id: true, revokedAt: true },
      });
      if (!existing?.revokedAt) {
        throw new NotFoundException("Share token not found");
      }
      return { id: existing.id, revokedAt: existing.revokedAt };
    }

    await this.prisma.auditLog.create({
      data: {
        actorType: "user",
        actorId: user.id,
        action: "proof.share_token.revoked",
        resourceType: "proofShareToken",
        resourceId: tokenId,
        metadata: { proofId },
      },
    });

    return { id: tokenId, revokedAt: now };
  }

  /**
   * Resolve a raw share token into a scoped verification result.
   *
   * Unauthenticated by design: possession of the token is the authorization.
   * Nothing here reads or creates a session.
   */
  async resolve(rawToken: string) {
    if (!TOKEN_PATTERN.test(rawToken)) {
      throw new NotFoundException(INVALID_SHARE);
    }

    const token = await this.prisma.proofShareToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
      include: { proof: { select: { id: true, userId: true } } },
    });

    const now = new Date();
    if (
      !token ||
      token.revokedAt !== null ||
      token.supersededAt !== null ||
      token.expiresAt <= now ||
      (token.maxUses !== null && token.useCount >= token.maxUses) ||
      token.proof.userId !== token.ownerId
    ) {
      throw new NotFoundException(INVALID_SHARE);
    }

    // Consume one use atomically. The conditions are re-checked by the
    // database, so a revocation, supersession, expiry, or the last permitted
    // use landing between the read above and this write still fails closed.
    const consumed = await this.prisma.proofShareToken.updateMany({
      where: {
        id: token.id,
        revokedAt: null,
        supersededAt: null,
        expiresAt: { gt: now },
        ...(token.maxUses !== null
          ? { useCount: { lt: token.maxUses } }
          : undefined),
      },
      data: { useCount: { increment: 1 }, lastUsedAt: now },
    });
    if (consumed.count !== 1) {
      throw new NotFoundException(INVALID_SHARE);
    }

    const verification = await this.proofsService.verifyProof(token.proof.id, {
      shareTokenId: token.id,
    });
    if (!("proof" in verification) || !verification.proof) {
      throw new NotFoundException(INVALID_SHARE);
    }

    const { contractStatus: _contractStatus, id, ...publicProof } =
      verification.proof;
    void _contractStatus;

    const base = {
      scope: token.scope,
      result: verification.result,
      status: verification.status,
      shareExpiresAt: token.expiresAt.toISOString(),
    };

    if (token.scope === ProofShareScope.VERIFY_CREDENTIAL) {
      return {
        ...base,
        proof: { id, ...publicProof },
        credential: verification.credential,
      };
    }

    // VERIFY_STATUS: no proof id, no credential, no subject.
    return { ...base, proof: publicProof };
  }

  private async assertOwnedProof(user: AuthenticatedUser, proofId: string) {
    const proof = await this.prisma.proof.findFirst({
      where: { id: proofId, userId: user.id },
      select: { id: true },
    });
    if (!proof) {
      throw new NotFoundException("Proof not found");
    }
  }

  /** Owner-facing metadata. Never the hash, never the raw token. */
  private toView(token: ProofShareToken) {
    return {
      id: token.id,
      proofId: token.proofId,
      scope: token.scope,
      label: token.label,
      expiresAt: token.expiresAt.toISOString(),
      maxUses: token.maxUses,
      useCount: token.useCount,
      remainingUses:
        token.maxUses === null ? null : Math.max(0, token.maxUses - token.useCount),
      lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
      createdAt: token.createdAt.toISOString(),
    };
  }
}
