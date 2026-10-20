import { ApiProperty } from "@nestjs/swagger";

export class DeploymentNetworkDto {
  @ApiProperty({
    enum: ["testnet", "mainnet", "futurenet"],
    example: "testnet",
  })
  name!: string;

  @ApiProperty({
    description:
      "Network passphrase. Every contract in this document belongs to this " +
      "network; a document never mixes networks.",
    example: "Test SDF Network ; September 2015",
  })
  passphrase!: string;
}

export class DeploymentContractDto {
  @ApiProperty({ example: "proof_registry" })
  name!: string;

  @ApiProperty({
    description: "Soroban contract address on the document's network.",
    example: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
  })
  address!: string;

  @ApiProperty({
    description: "Lowercase hex SHA-256 of the deployed contract WASM.",
    example: "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
  })
  wasmHash!: string;
}

export class DeploymentArtifactDto {
  @ApiProperty({ example: "api_image" })
  name!: string;

  @ApiProperty({
    description: "Lowercase hex SHA-256 of the artifact.",
    example: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  })
  sha256!: string;
}

export class DeploymentMetadataDocumentDto {
  @ApiProperty({ example: "earnproof.deployment-metadata" })
  schema!: string;

  @ApiProperty({
    description: "Document format version. Incremented on breaking changes.",
    example: 1,
  })
  schemaVersion!: number;

  @ApiProperty({ example: "2026.09.1" })
  deploymentVersion!: string;

  @ApiProperty({ type: DeploymentNetworkDto })
  network!: DeploymentNetworkDto;

  @ApiProperty({
    type: [DeploymentContractDto],
    description: "Sorted by name.",
  })
  contracts!: DeploymentContractDto[];

  @ApiProperty({
    type: [DeploymentArtifactDto],
    description: "Sorted by name. Empty when the manifest declares none.",
  })
  artifacts!: DeploymentArtifactDto[];
}

export class DeploymentMetadataIntegrityDto {
  @ApiProperty({ enum: ["sha256"], example: "sha256" })
  algorithm!: string;

  @ApiProperty({
    description:
      "Canonical form hashed: object keys sorted recursively, compact " +
      "JSON.stringify, UTF-8.",
    enum: ["json-sorted-keys"],
    example: "json-sorted-keys",
  })
  canonicalization!: string;

  @ApiProperty({
    description:
      "Lowercase hex SHA-256 of the canonical `document`. Also served as the " +
      "ETag.",
    example: "5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef",
  })
  digest!: string;
}

export class DeploymentMetadataResponseDto {
  @ApiProperty({ type: DeploymentMetadataDocumentDto })
  document!: DeploymentMetadataDocumentDto;

  @ApiProperty({ type: DeploymentMetadataIntegrityDto })
  integrity!: DeploymentMetadataIntegrityDto;
}
