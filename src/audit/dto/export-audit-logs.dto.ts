import { IsDateString, IsOptional, IsString, MaxLength } from "class-validator";

export class ExportAuditLogsDto {
  /** Required: exports never span organizations. */
  @IsString()
  @MaxLength(64)
  organizationId!: string;

  /** Required: exports always enforce a bounded date range (see
   * MAX_EXPORT_RANGE_DAYS in audit-admin.service.ts). */
  @IsDateString()
  createdFrom!: string;

  @IsDateString()
  createdTo!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  actorType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  resourceType?: string;
}
