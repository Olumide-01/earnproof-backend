import { ApiProperty } from "@nestjs/swagger";
import { IsUrl, MaxLength } from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";
import { IsSafeUrl } from "../../common/validation/url.validator";

export class UpdateWebhookUrlDto {
  @ApiProperty({
    description:
      "New HTTPS destination URL. Changing it reverts the endpoint to " +
      "PENDING and requires re-verification before deliveries resume.",
    example: "https://example.com/webhooks/earnproof-v2",
  })
  @IsUrl({ protocols: ["https"], require_tld: true, require_protocol: true })
  @IsSafeUrl()
  @MaxLength(FIELD_LIMITS.url)
  url!: string;
}
