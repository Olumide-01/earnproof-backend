import { ApiProperty } from "@nestjs/swagger";
import { IsArray, IsIn, ArrayMinSize, ArrayMaxSize, IsInt, Min } from "class-validator";
import { WEBHOOK_EVENT_TYPES, WebhookEventType } from "../webhook-event.types";

export class UpdateWebhookEventsDto {
  @ApiProperty({
    description:
      "Expected revision number for optimistic concurrency control. Must match current revision or update will fail with 409 conflict.",
    example: 0,
  })
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @ApiProperty({
    description: "Replacement set of event type subscriptions",
    type: [String],
    enum: WEBHOOK_EVENT_TYPES,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WEBHOOK_EVENT_TYPES.length)
  @IsIn(WEBHOOK_EVENT_TYPES as unknown as string[], { each: true })
  events!: WebhookEventType[];
}
