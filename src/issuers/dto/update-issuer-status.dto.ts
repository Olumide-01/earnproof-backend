import { ApiProperty } from "@nestjs/swagger";
import { IsEnum, IsInt, Min } from "class-validator";
import { ResourceStatus } from "@prisma/client";

export class UpdateIssuerStatusDto {
  @ApiProperty({
    description:
      "Expected revision number for optimistic concurrency control. Must match current revision or update will fail with 409 conflict.",
    example: 0,
  })
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @ApiProperty({
    description:
      "Target status. Valid transitions: PENDING→ACTIVE, ACTIVE→SUSPENDED, SUSPENDED→ACTIVE, ACTIVE→REVOKED",
    enum: ["ACTIVE", "PENDING", "SUSPENDED", "REVOKED", "DELETED"],
  })
  @IsEnum(ResourceStatus)
  status: ResourceStatus;
}
