import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ProofStatus } from "@prisma/client";

export class AnchoringResultDto {
  @ApiProperty({
    description: "Whether the proof commitment was anchored on-chain.",
    example: false,
  })
  anchored!: boolean;

  @ApiPropertyOptional({
    description: "Stellar transaction hash of the anchoring transaction, if anchored.",
    example: "abc123def456...",
  })
  transactionHash?: string;

  @ApiPropertyOptional({
    description: "Human-readable reason when anchoring did not occur.",
    example: "disabled",
  })
  reason?: string;
}

/**
 * The signed credential object embedded in proof creation and verification
 * responses. The `proof.signature` field is an HMAC-SHA256 commitment over
 * the canonical (sorted) JSON of the credential body; it is NOT a private key
 * signature and does not expose key material.
 */
export class SignedCredentialDto {
  @ApiProperty({ example: "clx1abc2def3ghi4" })
  id!: string;

  @ApiProperty({ example: "EarnProofMinimumIncomeCredential" })
  type!: string;

  @ApiProperty({ example: "earnproof.minimum-income.v1" })
  schemaVersion!: string;

  @ApiProperty({ example: "earnproof-backend" })
  issuer!: string;

  @ApiProperty({
    description: "Credential subject. Contains only the wallet hash, never the raw address.",
    example: {
      walletHash:
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
  })
  subject!: { walletHash: string };

  @ApiProperty({
    description: "The privacy-preserving income claim.",
    example: {
      operator: "gte",
      thresholdAmount: "500.0000000",
      assetCode: "USDC",
      assetIssuer: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGLA1PIC4CEXLRTKHB0EGB",
      periodStart: "2025-01-01T00:00:00.000Z",
      periodEnd: "2025-01-31T23:59:59.000Z",
      qualifyingPaymentCount: 3,
    },
  })
  claim!: Record<string, unknown>;

  @ApiProperty({
    description: "Privacy flags indicating what is hidden in this credential.",
    example: { exactIncomeHidden: true, sourceTransactionsHidden: true },
  })
  privacy!: Record<string, unknown>;

  @ApiProperty({ example: "2025-01-15T12:00:00.000Z" })
  issuedAt!: string;

  @ApiProperty({ example: "2025-02-14T12:00:00.000Z" })
  expiresAt!: string;

  @ApiProperty({
    description:
      "Integrity proof. `keyId` is a non-secret identifier for the signing key version " +
      "(e.g. `earnproof-v0`) that lets a verifier know which key to check against during " +
      "rotation; it never exposes key material. `credentialHash` is a SHA-256 commitment " +
      "over the canonical credential body. `signature` is an HMAC-SHA256 over the same " +
      "payload — it authenticates the credential as originating from this server but does " +
      "NOT expose private key material.",
    example: {
      type: "HMAC-SHA256",
      keyId: "earnproof-v0",
      credentialHash: "sha256:abc123...",
      signature: "hmac-sha256:xyz789...",
    },
  })
  proof!: {
    type: string;
    keyId: string;
    credentialHash: string;
    signature: string;
  };
}

export class ProofCreatedDto {
  @ApiProperty({ example: "clx1abc2def3ghi4" })
  proofId!: string;

  @ApiProperty({
    enum: ProofStatus,
    example: ProofStatus.ACTIVE,
  })
  status!: ProofStatus;

  @ApiProperty({
    description: "Public URL for third-party verification of this proof.",
    example: "/api/v1/proofs/clx1abc2def3ghi4/verify",
  })
  verificationUrl!: string;

  @ApiProperty({ type: () => SignedCredentialDto })
  credential!: SignedCredentialDto;

  @ApiProperty({ type: () => AnchoringResultDto })
  anchoring!: AnchoringResultDto;
}
