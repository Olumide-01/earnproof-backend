import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { IsSafeString } from "../../common/validation/safe-string.validator";

export const DISPLAY_NAME_MAX_LENGTH = 64;

/**
 * Self-service profile update.
 *
 * Deliberately narrow: `displayName` is the only field a user may change about
 * themselves. Role, status and wallet address are rejected by the global
 * `forbidNonWhitelisted` validation rather than silently ignored.
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({
    description: "Display label. Send null to clear it.",
    example: "Ada",
    maxLength: DISPLAY_NAME_MAX_LENGTH,
    nullable: true,
    type: String,
  })
  // `@IsOptional` skips the remaining rules for both undefined and null, which
  // is what lets null clear the field.
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(DISPLAY_NAME_MAX_LENGTH)
  @IsSafeString()
  displayName?: string | null;
}
