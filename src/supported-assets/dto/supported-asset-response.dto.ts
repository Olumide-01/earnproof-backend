import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ResourceStatus } from "@prisma/client";

export class SupportedAssetResponseDto {
  @ApiProperty({ description: "Asset unique ID" })
  id: string;

  @ApiProperty({ description: "Organization ID this asset belongs to" })
  organizationId: string;

  @ApiProperty({
    description:
      "Computed asset key: ${network}:${code}:${issuer || 'native'}",
    example: "testnet:USDC:GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTBTQUGS7SEEDS23ABC123DEF45",
  })
  assetKey: string;

  @ApiProperty({
    description: "Asset code (1-12 alphanumeric characters)",
    example: "USDC",
  })
  code: string;

  @ApiPropertyOptional({
    description: "Stellar issuer public key address. Null for native XLM.",
    example: "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTBTQUGS7SEEDS23ABC123DEF45",
    nullable: true,
  })
  issuer: string | null;

  @ApiProperty({
    description: "Stellar network identifier",
    example: "testnet",
    enum: ["testnet", "pubnet"],
  })
  network: string;

  @ApiProperty({
    description: "Number of decimal places (0-7)",
    example: 7,
  })
  decimals: number;

  @ApiProperty({
    description: "Asset status",
    enum: ["ACTIVE", "PENDING", "SUSPENDED", "REVOKED", "DELETED"],
  })
  status: ResourceStatus;

  @ApiProperty({
    description:
      "Revision number for optimistic concurrency control. Incremented on each update.",
  })
  revision: number;

  @ApiProperty({ description: "ISO 8601 timestamp when asset was created" })
  createdAt: Date;

  @ApiProperty({
    description: "ISO 8601 timestamp when asset was last updated",
  })
  updatedAt: Date;
}
