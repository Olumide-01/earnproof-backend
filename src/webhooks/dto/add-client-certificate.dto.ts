import { ApiProperty } from "@nestjs/swagger";
import { IsISO8601, IsString, MinLength } from "class-validator";

export class AddClientCertificateDto {
  @ApiProperty({ description: "PEM-encoded X.509 client certificate" })
  @IsString()
  @MinLength(1)
  certificatePem: string;

  @ApiProperty({ description: "PEM-encoded private key. Encrypted at rest; never returned." })
  @IsString()
  @MinLength(1)
  privateKeyPem: string;

  @ApiProperty({ description: "ISO-8601 validity start" })
  @IsISO8601()
  notBefore: string;

  @ApiProperty({ description: "ISO-8601 validity end" })
  @IsISO8601()
  notAfter: string;
}
