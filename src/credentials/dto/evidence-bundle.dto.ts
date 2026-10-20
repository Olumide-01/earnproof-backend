import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString } from "class-validator";

export const SUPPORTED_BUNDLE_MANIFEST_VERSION = "1.0.0";
export const MAX_EVIDENCE_BUNDLE_BYTES = 64 * 1024; // 64 KB bounded size

export interface EvidenceBundlePayload {
  manifestVersion: "1.0.0";
  bundleId: string;
  network: string;
  proofId: string;
  evidence: {
    credentialHash: string;
    contractTransactionHash?: string | null;
    commitment?: string | null;
    assetCode: string;
    assetIssuer?: string | null;
    verifiedAt: string;
    expiresAt: string;
  };
}

export interface EvidenceBundleSigning {
  keyId: string;
  algorithm: "hmac-sha256";
  signature: string;
  signedAt: string;
}

export interface SignedEvidenceBundle {
  manifest: EvidenceBundlePayload;
  signing: EvidenceBundleSigning;
}

export class GenerateEvidenceBundleDto {
  @ApiProperty({ description: "Proof ID to bundle" })
  @IsNotEmpty()
  @IsString()
  proofId!: string;

  @ApiPropertyOptional({ description: "Target Stellar network", default: "testnet" })
  @IsOptional()
  @IsString()
  network?: string;
}

export class VerifyEvidenceBundleDto {
  @ApiProperty({ description: "Signed evidence bundle object or JSON string" })
  @IsNotEmpty()
  bundle!: SignedEvidenceBundle | string;

  @ApiPropertyOptional({ description: "Expected Stellar network (e.g., testnet, public)" })
  @IsOptional()
  @IsString()
  expectedNetwork?: string;
}

export class VerifyEvidenceBundleResponseDto {
  @ApiProperty({ description: "Whether the bundle signature and evidence are valid" })
  valid!: boolean;

  @ApiPropertyOptional({ description: "Failure reason if invalid" })
  reason?: string;

  @ApiPropertyOptional({ description: "Bundle ID if valid" })
  bundleId?: string;

  @ApiPropertyOptional({ description: "Proof ID if valid" })
  proofId?: string;

  @ApiPropertyOptional({ description: "Signing Key ID used" })
  keyId?: string;
}
