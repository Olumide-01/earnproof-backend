import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";

export class VerifyWebhookDto {
  @ApiProperty({
    description:
      "The token delivered in the `webhook.verification` challenge payload.",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  token!: string;
}
