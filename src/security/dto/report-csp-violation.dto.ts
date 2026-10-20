import { ApiProperty } from "@nestjs/swagger";
import { CspDirective, CspDisposition, CspRouteCategory } from "@prisma/client";
import { IsEnum, IsString, Matches, MaxLength } from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";

/**
 * Bounded version-string format, matching the deployment manifest's own
 * `deploymentVersion` pattern. A release identifier can never be a raw path,
 * timestamp, or other unbounded value.
 */
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/**
 * Ingestion contract for a CSP violation report (#336).
 *
 * Deliberately does NOT mirror the browser's native CSP report shape
 * (`document-uri`, `blocked-uri`, `source-file`, etc.) — those fields carry
 * full URLs, which can leak query strings, tokens, or other identifying data.
 * The caller (the frontend) is expected to map its own raw CSP report into
 * this already-bounded, closed-enum shape before posting; this service never
 * accepts, parses, or stores a URL, DOM data, or free-form user input. The
 * global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`
 * additionally rejects any extra property outright rather than silently
 * dropping it.
 */
export class ReportCspViolationDto {
  @ApiProperty({ enum: CspDirective })
  @IsEnum(CspDirective)
  directive!: CspDirective;

  @ApiProperty({
    enum: CspRouteCategory,
    description: "Coarse frontend page category — never a path or query string.",
  })
  @IsEnum(CspRouteCategory)
  routeCategory!: CspRouteCategory;

  @ApiProperty({
    description: "Frontend app release/version string.",
    example: "2026.10.1",
  })
  @IsString()
  @MaxLength(FIELD_LIMITS.cspRelease)
  @Matches(RELEASE_PATTERN, {
    message: "release must match [A-Za-z0-9][A-Za-z0-9._+-]{0,63}",
  })
  release!: string;

  @ApiProperty({ enum: CspDisposition })
  @IsEnum(CspDisposition)
  disposition!: CspDisposition;
}
