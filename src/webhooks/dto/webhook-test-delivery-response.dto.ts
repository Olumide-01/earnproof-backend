import { ApiProperty } from "@nestjs/swagger";
import { WEBHOOK_TEST_STATUS_CLASSES } from "../webhook-delivery.service";
import {
  WEBHOOK_TEST_EVENT_TYPE,
  WEBHOOK_TEST_EVENT_VERSION,
} from "../webhook-event.types";

export class WebhookTestDeliveryResponseBodyDto {
  @ApiProperty({
    description:
      "The receiver's response body after redaction of credential-like values " +
      "(authorization, password, secret, token, api key, bearer tokens), bounded " +
      "to `maxBytes` characters plus a `…[truncated]` marker. Null when no " +
      "response was received.",
    type: String,
    nullable: true,
    example: '{"received":true}',
  })
  body!: string | null;

  @ApiProperty({
    description: "True when the body was cut at `maxBytes`.",
    example: false,
  })
  truncated!: boolean;

  @ApiProperty({
    description: "Size bound applied to `body` — the same bound stored for real deliveries.",
    example: 1024,
  })
  maxBytes!: number;
}

/**
 * Diagnostic contract of `POST /webhooks/:id/test`.
 *
 * Contains no signing secret, signature, request payload, or destination
 * policy detail.
 */
export class WebhookTestDeliveryResponseDto {
  @ApiProperty({ example: "ckv8v6h2b0002qzrm7t4k9xza" })
  webhookId!: string;

  @ApiProperty({
    description:
      "Id sent in `X-EarnProof-Delivery` and the envelope `id`. Always prefixed " +
      "`test_`, so it can never collide with a real event id.",
    example: "test_3f2b1c9e-8d7a-4b6c-9e5f-1a2b3c4d5e6f",
  })
  eventId!: string;

  @ApiProperty({
    description:
      "Sent in `X-EarnProof-Event`. Not a subscribable business event type.",
    enum: [WEBHOOK_TEST_EVENT_TYPE],
    example: WEBHOOK_TEST_EVENT_TYPE,
  })
  eventType!: string;

  @ApiProperty({
    description:
      "Always true. The delivered envelope also carries `synthetic: true` at the " +
      "top level and in `data`.",
    enum: [true],
    example: true,
  })
  synthetic!: boolean;

  @ApiProperty({
    description: "Version of the synthetic event's `data` shape.",
    enum: [WEBHOOK_TEST_EVENT_VERSION],
    example: WEBHOOK_TEST_EVENT_VERSION,
  })
  testEventVersion!: string;

  @ApiProperty({
    description: "ISO-8601 time the synthetic event was created.",
    example: "2026-08-24T12:00:00.000Z",
  })
  sentAt!: string;

  @ApiProperty({
    description: "True only when the receiver answered 2xx.",
    example: true,
  })
  delivered!: boolean;

  @ApiProperty({
    description:
      "Coarse outcome. `1xx`–`5xx`: receiver status class. `timeout`: no answer " +
      "within the delivery timeout. `redirect_rejected`: the receiver redirected; " +
      "redirects are never followed. `destination_rejected`: the outbound " +
      "destination policy refused the URL. `network_error`: connection, TLS, or " +
      "DNS failure. `signing_error`: the signing secret could not be decrypted.",
    enum: WEBHOOK_TEST_STATUS_CLASSES,
    example: "2xx",
  })
  statusClass!: string;

  @ApiProperty({
    description: "Receiver HTTP status, or null when no response was received.",
    type: Number,
    nullable: true,
    example: 200,
  })
  statusCode!: number | null;

  @ApiProperty({
    description: "Wall-clock time from send to response (or failure), in ms.",
    example: 142,
  })
  durationMs!: number;

  @ApiProperty({
    description: "Stable, non-identifying failure description, or null on success.",
    type: String,
    nullable: true,
    example: null,
  })
  failureReason!: string | null;

  @ApiProperty({ type: WebhookTestDeliveryResponseBodyDto })
  response!: WebhookTestDeliveryResponseBodyDto;
}
