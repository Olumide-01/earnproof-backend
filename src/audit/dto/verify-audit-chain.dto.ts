import { IsString, MaxLength } from "class-validator";

export class VerifyAuditChainParamsDto {
  @IsString()
  @MaxLength(64)
  organizationId!: string;
}
