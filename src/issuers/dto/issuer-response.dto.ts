import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ResourceStatus } from "@prisma/client";

export class IssuerResponseDto {
  @ApiProperty({ description: "Issuer unique ID" })
  id: string;

  @ApiProperty({ description: "Organization ID this issuer belongs to" })
  organizationId: string;

  @ApiProperty({ description: "Stellar public key address" })
  stellarAddress: string;

  @ApiProperty({
    description: "Issuer status (PENDING, ACTIVE, SUSPENDED, REVOKED, DELETED)",
    enum: ["ACTIVE", "PENDING", "SUSPENDED", "REVOKED", "DELETED"],
  })
  status: ResourceStatus;

  @ApiProperty({
    description:
      "Revision number for optimistic concurrency control. Incremented on each update.",
  })
  revision: number;

  @ApiPropertyOptional({
    description: "Hash of the public metadata for integrity verification",
    nullable: true,
  })
  metadataHash: string | null;

  @ApiPropertyOptional({
    description: "Allowlisted issuer metadata stored by the API.",
    nullable: true,
  })
  publicMetadata?: Record<string, string> | null;

  @ApiProperty({
    description: "Latest issuer-registry synchronization state.",
    enum: ["PENDING", "SYNCED", "FAILED", "DISABLED"],
  })
  contractSyncState: string;

  @ApiPropertyOptional({ nullable: true })
  contractTransactionHash?: string | null;

  @ApiPropertyOptional({ nullable: true })
  contractSyncedAt?: Date | null;

  @ApiPropertyOptional({
    description: "ISO 8601 timestamp when issuer was verified/activated",
    nullable: true,
  })
  verifiedAt: Date | null;

  @ApiPropertyOptional({
    description: "ISO 8601 timestamp when issuer was suspended",
    nullable: true,
  })
  suspendedAt: Date | null;

  @ApiPropertyOptional({
    description: "ISO 8601 timestamp when issuer was revoked",
    nullable: true,
  })
  revokedAt: Date | null;

  @ApiProperty({ description: "ISO 8601 timestamp when issuer was created" })
  createdAt: Date;

  @ApiProperty({
    description: "ISO 8601 timestamp when issuer was last updated",
  })
  updatedAt: Date;
}

export class IssuerPublicResponseDto {
  @ApiProperty({ description: "Issuer unique ID" })
  id: string;

  @ApiProperty({ description: "Stellar public key address" })
  stellarAddress: string;

  @ApiProperty({
    description:
      "Effective trust status (based on status, suspension, and revocation)",
  })
  trustStatus: "TRUSTED" | "PENDING" | "SUSPENDED" | "REVOKED";

  @ApiProperty({
    description:
      "Allowlisted public metadata (name, description, logoUrl only)",
  })
  publicMetadata: {
    name?: string;
    description?: string;
    logoUrl?: string;
  };

  @ApiProperty({ description: "ISO 8601 timestamp when issuer was created" })
  createdAt: Date;
}
