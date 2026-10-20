import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { IssuerKeyLifecycleState } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";

export interface RegisterSigningKeyDto {
  keyId: string;
  publicKey: string;
  commitmentHash: string;
  activateImmediately?: boolean;
}

export interface SigningKeyResponseDto {
  id: string;
  issuerId: string;
  keyId: string;
  publicKey: string;
  commitmentHash: string;
  state: IssuerKeyLifecycleState;
  activatedAt: Date | null;
  retiredAt: Date | null;
  compromisedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class IssuerSigningKeysService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List all signing keys for an issuer. Privacy-safe: never returns private material.
   */
  async listKeys(issuerId: string): Promise<SigningKeyResponseDto[]> {
    const keys = await this.prisma.issuerSigningKey.findMany({
      where: { issuerId },
      orderBy: { createdAt: "desc" },
    });

    return keys.map((k) => ({
      id: k.id,
      issuerId: k.issuerId,
      keyId: k.keyId,
      publicKey: k.publicKey,
      commitmentHash: k.commitmentHash,
      state: k.state,
      activatedAt: k.activatedAt,
      retiredAt: k.retiredAt,
      compromisedAt: k.compromisedAt,
      revokedAt: k.revokedAt,
      createdAt: k.createdAt,
    }));
  }

  /**
   * Register a new signing key for an issuer.
   */
  async registerKey(
    issuerId: string,
    dto: RegisterSigningKeyDto,
  ): Promise<SigningKeyResponseDto> {
    const issuer = await this.prisma.issuer.findUnique({
      where: { id: issuerId },
    });
    if (!issuer) {
      throw new NotFoundException(`Issuer with ID "${issuerId}" not found`);
    }

    const existing = await this.prisma.issuerSigningKey.findUnique({
      where: {
        issuerId_keyId: {
          issuerId,
          keyId: dto.keyId,
        },
      },
    });

    if (existing) {
      throw new ConflictException(
        `Signing key "${dto.keyId}" already exists for issuer "${issuerId}"`,
      );
    }

    const state = dto.activateImmediately
      ? IssuerKeyLifecycleState.ACTIVE
      : IssuerKeyLifecycleState.PENDING;

    const key = await this.prisma.issuerSigningKey.create({
      data: {
        issuerId,
        keyId: dto.keyId,
        publicKey: dto.publicKey,
        commitmentHash: dto.commitmentHash,
        state,
        activatedAt: dto.activateImmediately ? new Date() : null,
      },
    });

    return {
      id: key.id,
      issuerId: key.issuerId,
      keyId: key.keyId,
      publicKey: key.publicKey,
      commitmentHash: key.commitmentHash,
      state: key.state,
      activatedAt: key.activatedAt,
      retiredAt: key.retiredAt,
      compromisedAt: key.compromisedAt,
      revokedAt: key.revokedAt,
      createdAt: key.createdAt,
    };
  }

  /**
   * Transition key to RETIRED state (normal rotation).
   */
  async retireKey(issuerId: string, keyId: string): Promise<SigningKeyResponseDto> {
    const key = await this.prisma.issuerSigningKey.findUnique({
      where: { issuerId_keyId: { issuerId, keyId } },
    });
    if (!key) throw new NotFoundException(`Signing key "${keyId}" not found`);

    if (key.state === IssuerKeyLifecycleState.COMPROMISED) {
      throw new BadRequestException("Cannot retire a compromised key");
    }

    const updated = await this.prisma.issuerSigningKey.update({
      where: { id: key.id },
      data: {
        state: IssuerKeyLifecycleState.RETIRED,
        retiredAt: new Date(),
      },
    });

    return {
      id: updated.id,
      issuerId: updated.issuerId,
      keyId: updated.keyId,
      publicKey: updated.publicKey,
      commitmentHash: updated.commitmentHash,
      state: updated.state,
      activatedAt: updated.activatedAt,
      retiredAt: updated.retiredAt,
      compromisedAt: updated.compromisedAt,
      revokedAt: updated.revokedAt,
      createdAt: updated.createdAt,
    };
  }

  /**
   * Mark key as COMPROMISED (security incident).
   */
  async markCompromised(
    issuerId: string,
    keyId: string,
  ): Promise<SigningKeyResponseDto> {
    const key = await this.prisma.issuerSigningKey.findUnique({
      where: { issuerId_keyId: { issuerId, keyId } },
    });
    if (!key) throw new NotFoundException(`Signing key "${keyId}" not found`);

    const updated = await this.prisma.issuerSigningKey.update({
      where: { id: key.id },
      data: {
        state: IssuerKeyLifecycleState.COMPROMISED,
        compromisedAt: new Date(),
      },
    });

    return {
      id: updated.id,
      issuerId: updated.issuerId,
      keyId: updated.keyId,
      publicKey: updated.publicKey,
      commitmentHash: updated.commitmentHash,
      state: updated.state,
      activatedAt: updated.activatedAt,
      retiredAt: updated.retiredAt,
      compromisedAt: updated.compromisedAt,
      revokedAt: updated.revokedAt,
      createdAt: updated.createdAt,
    };
  }

  /**
   * Reconcile local key commitment with on-chain contract state.
   */
  async reconcileKeyWithContract(
    issuerId: string,
    keyId: string,
    onChainCommitment: string,
  ): Promise<{ reconciled: boolean; conflict?: string }> {
    const key = await this.prisma.issuerSigningKey.findUnique({
      where: { issuerId_keyId: { issuerId, keyId } },
    });
    if (!key) throw new NotFoundException(`Signing key "${keyId}" not found`);

    if (key.commitmentHash !== onChainCommitment) {
      return {
        reconciled: false,
        conflict: `Commitment hash mismatch: local=${key.commitmentHash}, on-chain=${onChainCommitment}`,
      };
    }

    await this.prisma.issuerSigningKey.update({
      where: { id: key.id },
      data: { contractSyncedAt: new Date() },
    });

    return { reconciled: true };
  }
}
