import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "node:crypto";

export type CspReportClientContext = {
  /** Request IP is used transiently and is never stored. */
  ip?: string;
};

/**
 * Strict sampling for CSP violation reports (#336).
 *
 * A single misbehaving page can fire the same violation on every paint; left
 * unsampled, that client alone could dominate — or flood — an aggregate
 * bucket's count. This caps how many reports from one client contribute to
 * one bucket (directive x routeCategory x release x disposition) within a
 * window; reports past the cap are dropped (not stored, not counted, no
 * error returned to the caller — the endpoint always responds the same way
 * regardless of sampling outcome, so it cannot be used to probe the limit).
 *
 * Keys are HMACs held only in process memory; the raw IP is never persisted
 * or logged, matching ProofVerificationAbuseService's pattern for the other
 * public, unauthenticated endpoint in this service.
 */
@Injectable()
export class CspViolationAbuseService {
  private readonly windowMs: number;
  private readonly perClientBucketLimit: number;
  private readonly secret: string;
  private readonly seen = new Map<string, number[]>();

  constructor(configService: ConfigService) {
    this.windowMs = configService.get<number>(
      "rateLimit.cspReportWindowMs",
      60_000,
    );
    this.perClientBucketLimit = configService.get<number>(
      "rateLimit.cspReportPerClientBucketLimit",
      1,
    );
    this.secret =
      configService.get<string>("credentialSigningSecret") ??
      "temporary-csp-report-key";
  }

  /** Returns true if this client/bucket combination should be accepted and counted. */
  shouldAccept(
    context: CspReportClientContext | undefined,
    bucketKey: string,
  ): boolean {
    const now = Date.now();
    const key = `${this.hash(context?.ip ?? "unknown-client")}:${this.hash(bucketKey)}`;
    const timestamps = (this.seen.get(key) ?? []).filter(
      (timestamp) => timestamp + this.windowMs > now,
    );

    if (timestamps.length >= this.perClientBucketLimit) {
      this.seen.set(key, timestamps);
      return false;
    }

    timestamps.push(now);
    this.seen.set(key, timestamps);
    return true;
  }

  /** Test/support hook for bounded lifecycle cleanup without exposing keys. */
  pruneExpired(now = Date.now()): void {
    for (const [key, timestamps] of this.seen) {
      const kept = timestamps.filter(
        (timestamp) => timestamp + this.windowMs > now,
      );
      if (kept.length === 0) {
        this.seen.delete(key);
      } else {
        this.seen.set(key, kept);
      }
    }
  }

  private hash(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("hex");
  }
}
