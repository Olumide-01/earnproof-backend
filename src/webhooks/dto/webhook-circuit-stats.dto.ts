import { ApiProperty } from "@nestjs/swagger";
import { WebhookCircuitState } from "@prisma/client";

export class WebhookCircuitStatsDto {
  @ApiProperty({ enum: WebhookCircuitState })
  state!: WebhookCircuitState;

  @ApiProperty()
  failureCount!: number;

  @ApiProperty()
  failureThreshold!: number;

  @ApiProperty({ required: false })
  lastFailureAt?: Date;

  @ApiProperty({ required: false })
  lastSuccessAt?: Date;

  @ApiProperty({ required: false })
  openedAt?: Date;
}