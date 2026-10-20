import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsEnum, Min } from "class-validator";
import { ResourceStatus } from "@prisma/client";

export class UpdateAssetStatusDto {
  @ApiProperty({
    description:
      "Expected revision number for optimistic locking. Request will fail if revision has changed.",
    example: 0,
  })
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @ApiProperty({
    description: "Target status for the asset",
    enum: ["ACTIVE", "PENDING", "SUSPENDED", "REVOKED", "DELETED"],
  })
  @IsEnum(ResourceStatus)
  status: ResourceStatus;
}
