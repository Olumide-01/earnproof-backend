import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "node:crypto";

export type VerificationClientContext = {
  /** Request IP is used transiently and is never stored. */
  ip?: string;
};

type Counter = { timestamps: number[] };

const GENERIC_LIMIT_MESSAGE = "Verification temporarily unavailable";

/**
 * Proof-aware verification budgets. Keys are HMACs held only in process memory;
 * raw IPs and submitted proof identifiers are never persisted or logged.
 */
@Injectable()
export class ProofVerificationAbuseService {
  private readonly windowMs: number;
  private readonly unknownLimit: number;
  private readonly repeatedLimit: number;
  private readonly distinctClientLimit: number;
  private readonly secret: string;
  private readonly repeated = new Map<string, Counter>();
  private readonly distinct = new Map<string, Map<string, number>>();

  constructor(configService: ConfigService) {
    this.windowMs = configService.get<number>(
      "rateLimit.proofVerificationWindowMs",
      15 * 60 * 1000,
    );
    this.unknownLimit = configService.get<number>(
      "rateLimit.proofVerificationUnknownLimit",
      10,
    );
    this.repeatedLimit = configService.get<number>(
      "rateLimit.proofVerificationRepeatedLimit",
      60,
    );
    this.distinctClientLimit = configService.get<number>(
      "rateLimit.proofVerificationDistinctClientLimit",
      100,
    );
    this.secret = configService.get<string>("credentialSigningSecret") ?? "temporary-verification-key";
  }

  /** Apply the high-cardinality client budget before querying storage. */
  checkClientCardinality(
    context: VerificationClientContext | undefined,
    proofId: string,
  ): void {
    const now = Date.now();
    const clientKey = this.hash(context?.ip ?? "unknown-client");
    const proofKey = this.hash(proofId.slice(0, 256));
    const entries = this.distinct.get(clientKey) ?? new Map<string, number>();

    for (const [key, timestamp] of entries) {
      if (timestamp + this.windowMs <= now) entries.delete(key);
    }
    if (!entries.has(proofKey) && entries.size >= this.distinctClientLimit) {
      throw this.limited();
    }
    entries.set(proofKey, now);
    this.distinct.set(clientKey, entries);
  }

  /** Apply separate budgets for unknown identifiers and repeated verification. */
  checkVerification(
    context: VerificationClientContext | undefined,
    proofId: string,
    knownProof: boolean,
  ): void {
    const now = Date.now();
    const key = `${this.hash(context?.ip ?? "unknown-client")}:${this.hash(proofId.slice(0, 256))}:${knownProof ? "known" : "unknown"}`;
    const counter = this.repeated.get(key) ?? { timestamps: [] };
    counter.timestamps = counter.timestamps.filter(
      (timestamp) => timestamp + this.windowMs > now,
    );
    const limit = knownProof ? this.repeatedLimit : this.unknownLimit;
    if (counter.timestamps.length >= limit) throw this.limited();
    counter.timestamps.push(now);
    this.repeated.set(key, counter);
  }

  /** Test/support hook for bounded lifecycle cleanup without exposing keys. */
  pruneExpired(now = Date.now()): void {
    for (const [key, counter] of this.repeated) {
      counter.timestamps = counter.timestamps.filter(
        (timestamp) => timestamp + this.windowMs > now,
      );
      if (counter.timestamps.length === 0) this.repeated.delete(key);
    }
    for (const [clientKey, entries] of this.distinct) {
      for (const [proofKey, timestamp] of entries) {
        if (timestamp + this.windowMs <= now) entries.delete(proofKey);
      }
      if (entries.size === 0) this.distinct.delete(clientKey);
    }
  }

  private hash(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("hex");
  }

  private limited(): HttpException {
    return new HttpException(GENERIC_LIMIT_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
  }
}
