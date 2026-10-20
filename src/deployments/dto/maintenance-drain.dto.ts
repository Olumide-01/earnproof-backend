import { ApiProperty } from "@nestjs/swagger";
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from "class-validator";

export enum MaintenancePhase {
  NORMAL = "NORMAL",
  DRAINING = "DRAINING",
  MAINTENANCE = "MAINTENANCE",
  RESUMING = "RESUMING",
}

export class InitiateDrainDto {
  @ApiProperty({ description: "Target maintenance reason" })
  @IsString()
  @IsNotEmpty()
  reason!: string;

  @ApiProperty({ description: "Drain timeout in seconds before force maintenance transition", default: 300, minimum: 10, maximum: 3600 })
  @IsNumber()
  @Min(10)
  @Max(3600)
  timeoutSeconds!: number;
}

export class DrainStatusResponseDto {
  @ApiProperty({ enum: MaintenancePhase })
  phase!: MaintenancePhase;

  @ApiProperty({ description: "Whether write operations / mutations are allowed" })
  mutationsAllowed!: boolean;

  @ApiProperty({ description: "Whether read queries are allowed" })
  readsAllowed!: boolean;

  @ApiProperty({ description: "Active in-flight mutation count" })
  inFlightMutations!: number;

  @ApiProperty({ description: "When the drain was initiated, if active" })
  drainStartedAt?: string;

  @ApiProperty({ description: "Deadline when drain will timeout" })
  drainDeadline?: string;
}
