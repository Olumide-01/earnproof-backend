import { ApiProperty } from "@nestjs/swagger";
import { IssuerAddressRotationStatus } from "@prisma/client";
import { Type } from "class-transformer";
import { IsInt, IsString, Length, Min } from "class-validator";

export class RequestIssuerAddressRotationDto {
  @ApiProperty({
    description: "Stellar account that will replace the issuer's current address.",
    example: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  })
  @IsString()
  @Length(56, 56)
  newStellarAddress!: string;

  @ApiProperty({
    description:
      "The issuer `revision` the request is based on. A request built from a stale view of the issuer is rejected with 409.",
    minimum: 0,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}

export class IssuerAddressRotationResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  issuerId!: string;

  @ApiProperty({ description: "Address the issuer held when the rotation was requested" })
  fromAddress!: string;

  @ApiProperty({ description: "Requested replacement address" })
  toAddress!: string;

  @ApiProperty({
    enum: IssuerAddressRotationStatus,
    description:
      "PENDING and SUBMITTED are open and reconciled automatically. The issuer's address changes only on CONFIRMED, after the contract is observed to hold the new address.",
  })
  status!: IssuerAddressRotationStatus;

  @ApiProperty()
  attemptCount!: number;

  @ApiProperty({ nullable: true, type: String, description: "Bounded error code" })
  lastError!: string | null;

  @ApiProperty({ nullable: true, type: String })
  transactionHash!: string | null;

  @ApiProperty({ nullable: true, type: Date })
  nextAttemptAt!: Date | null;

  @ApiProperty({ nullable: true, type: Date })
  confirmedAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}

export class IssuerAddressHistoryEntryDto {
  @ApiProperty({ description: "An address the issuer used to hold" })
  stellarAddress!: string;

  @ApiProperty()
  retiredAt!: Date;

  @ApiProperty()
  rotationId!: string;

  @ApiProperty({ nullable: true, type: String })
  transactionHash!: string | null;
}

export class IssuerAddressRotationsResponseDto {
  @ApiProperty({ type: [IssuerAddressRotationResponseDto] })
  rotations!: IssuerAddressRotationResponseDto[];

  @ApiProperty({ type: [IssuerAddressHistoryEntryDto] })
  addressHistory!: IssuerAddressHistoryEntryDto[];
}
