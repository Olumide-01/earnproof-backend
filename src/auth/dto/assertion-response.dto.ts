import { ApiProperty } from "@nestjs/swagger";

export class AssertionResponseDto {
  @ApiProperty({
    description:
      "Opaque assertion token. Present this in the X-Recent-Auth header " +
      "when calling the destructive endpoint.",
    example: "dGVzdC1hc3NlcnRpb24...",
  })
  token!: string;

  @ApiProperty({
    description: "ISO-8601 UTC timestamp when this assertion expires (5 minutes from issuance).",
    example: "2026-09-01T12:05:00.000Z",
  })
  expiresAt!: string;

  @ApiProperty({ example: "key:revoke" })
  action!: string;

  @ApiProperty({ example: "clx1abc2def3ghi4" })
  resourceId!: string;
}