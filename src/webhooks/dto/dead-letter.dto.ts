import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export const DEAD_LETTER_STATES = ["pending", "redriven", "all"] as const;
export type DeadLetterState = (typeof DEAD_LETTER_STATES)[number];

/** Hard ceiling on a batch; the configured limit may be lower. */
export const REDRIVE_BATCH_HARD_LIMIT = 100;

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

export class ListDeadLettersQueryDto {
  @ApiPropertyOptional({ description: "Restrict to one webhook endpoint." })
  @IsOptional()
  @IsString()
  webhookId?: string;

  @ApiPropertyOptional({
    enum: DEAD_LETTER_STATES,
    default: "pending",
    description: "`pending` = not yet redriven.",
  })
  @IsOptional()
  @IsIn(DEAD_LETTER_STATES as unknown as string[])
  state?: DeadLetterState;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: "Opaque cursor from a previous page." })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class RedriveDeadLetterDto {
  @ApiProperty({
    description:
      "Why this redrive is being performed. Required and recorded in the audit log.",
    minLength: 10,
    maxLength: 500,
    example: "Customer endpoint restored after outage INC-1234",
  })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  @Matches(/\S/, { message: "reason must not be blank" })
  reason!: string;
}

export class RedriveDeadLettersBatchDto extends RedriveDeadLetterDto {
  @ApiProperty({
    type: [String],
    description: `Dead-lettered delivery ids. At most the configured batch size (hard ceiling ${REDRIVE_BATCH_HARD_LIMIT}).`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(REDRIVE_BATCH_HARD_LIMIT)
  @IsString({ each: true })
  deliveryIds!: string[];
}
