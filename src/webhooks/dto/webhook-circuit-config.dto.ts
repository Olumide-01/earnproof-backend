import { ApiProperty } from "@nestjs/swagger";
import { IsOptional, IsInt, Min } from "class-validator";

export class UpdateWebhookCircuitConfigDto {
  @ApiProperty({
    description: "Number of consecutive failures before opening the circuit",
    minimum: 1,
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  failureThreshold?: number;

  @ApiProperty({
    description: "Recovery window in milliseconds before allowing probe attempts",
    minimum: 1000,
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(1000)
  recoveryWindowMs?: number;
}