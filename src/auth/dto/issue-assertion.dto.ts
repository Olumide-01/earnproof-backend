import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, Matches } from "class-validator";
import { DESTRUCTIVE_ACTIONS, DestructiveAction } from "../recent-auth.service";

const ALL_ACTIONS = Object.values(DESTRUCTIVE_ACTIONS);

export class IssueAssertionDto {
  @ApiProperty({
    description: "The destructive action this assertion will authorise.",
    enum: ALL_ACTIONS,
    example: DESTRUCTIVE_ACTIONS.KEY_REVOKE,
  })
  @IsString()
  @IsIn(ALL_ACTIONS)
  action!: DestructiveAction;

  @ApiPropertyOptional({
    description:
      "The specific resource ID to bind this assertion to. " +
      "Pass \"*\" to issue an assertion that works for any resource of this action type. " +
      "Defaults to \"*\".",
    example: "clx1abc2def3ghi4",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[\w*-]{1,128}$/)
  resourceId?: string;
}