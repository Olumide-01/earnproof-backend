import { ApiProperty } from "@nestjs/swagger";

export type ReadinessCheckStatus =
  | "PASSED"
  | "FAILED"
  | "UNAVAILABLE";

export type ReadinessCheckKind = "REQUIRED" | "OPTIONAL";

export type OrganizationReadinessState =
  | "READY"
  | "PARTIAL"
  | "DEGRADED"
  | "BLOCKED"
  | "ARCHIVED";

export class OrganizationReadinessCheckDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({
    enum: ["REQUIRED", "OPTIONAL"],
  })
  kind: ReadinessCheckKind;

  @ApiProperty({
    enum: ["PASSED", "FAILED", "UNAVAILABLE"],
  })
  status: ReadinessCheckStatus;

  @ApiProperty()
  action: string;

  @ApiProperty()
  message: string;
}

export class OrganizationReadinessResponseDto {
  @ApiProperty()
  organizationId: string;

  @ApiProperty()
  version: string;

  @ApiProperty({
    enum: [
      "READY",
      "PARTIAL",
      "DEGRADED",
      "BLOCKED",
      "ARCHIVED",
    ],
  })
  state: OrganizationReadinessState;

  @ApiProperty({ type: [OrganizationReadinessCheckDto] })
  checks: OrganizationReadinessCheckDto[];

  @ApiProperty()
  generatedAt: string;
}
