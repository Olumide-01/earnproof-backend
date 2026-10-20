import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsUrl,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { FIELD_LIMITS } from "../../common/limits/request-limits";
import { IsSafeUrl } from "../../common/validation/url.validator";
import {
  CURRENT_WEBHOOK_PAYLOAD_VERSION,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_PAYLOAD_VERSIONS,
  WebhookEventType,
  WebhookPayloadVersion,
} from "../webhook-event.types";
import { PredicateDto } from "./predicate.dto";

export class CreateWebhookDto {
  @ApiProperty({
    description: "HTTPS URL that will receive webhook deliveries",
    example: "https://example.com/webhooks/earnproof",
  })
  @IsUrl({ protocols: ["https"], require_tld: true, require_protocol: true })
  @IsSafeUrl()
  @MaxLength(FIELD_LIMITS.url)
  url!: string;

  @ApiProperty({
    description: "Event types to subscribe to",
    type: [String],
    enum: WEBHOOK_EVENT_TYPES,
    example: ["proof.created", "proof.verified"],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WEBHOOK_EVENT_TYPES.length)
  @IsIn(WEBHOOK_EVENT_TYPES as unknown as string[], { each: true })
  events!: WebhookEventType[];

  @ApiPropertyOptional({
    description:
      "Payload schema version to pin this endpoint to. Defaults to the current version. " +
      "Pinned endpoints keep receiving this version until they opt in to a newer one.",
    enum: WEBHOOK_PAYLOAD_VERSIONS,
    default: CURRENT_WEBHOOK_PAYLOAD_VERSION,
  })
  @IsOptional()
  @IsIn(WEBHOOK_PAYLOAD_VERSIONS as unknown as string[])
  payloadVersion?: WebhookPayloadVersion;

  @ApiPropertyOptional({
    description:
      "Optional predicate to narrow which events trigger this webhook. " +
      "If omitted or null, all subscribed event types match. " +
      "If provided, both event type AND predicate must match. " +
      "Predicate is a bounded, declarative JSON structure over resource, outcome, and schemaVersion.",
    type: PredicateDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PredicateDto)
  predicate?: PredicateDto | null;
}
