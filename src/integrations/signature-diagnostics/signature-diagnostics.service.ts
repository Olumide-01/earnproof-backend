import { BadRequestException, Injectable, Logger, Optional } from "@nestjs/common";
import { ApiKeyContext } from "../../api-keys/api-key.types";
import { RequestNonceService } from "../../api-keys/request-nonce.service";
import {
  diagnoseSignature,
  DiagnosticFailureCategory,
  SignatureDiagnosticReport,
} from "../../common/crypto/request-signing-diagnostics";
import { Clock, SystemClock } from "../../common/time/clock";
import { SignatureDiagnosticsRequestDto } from "./dto/signature-diagnostics.dto";

export type SignatureDiagnosticsResult = Omit<
  SignatureDiagnosticReport,
  "failureCategory" | "nonceClaimable"
> & {
  result: "VALID" | "INVALID";
  failureCategory: DiagnosticFailureCategory | null;
};

/**
 * Request signature verification diagnostics (#316).
 *
 * Nonce rule: every well-formed nonce whose timestamp is inside the window is
 * consumed, whether or not the signature matched, through the same atomic
 * store the guard uses and in the calling key's namespace. So a request that
 * was diagnosed can never afterwards be accepted by a live endpoint, and of
 * two concurrent diagnostics with one nonce exactly one reports CONSUMED.
 * If the nonce store is unavailable the claim fails closed and the nonce is
 * reported REPLAYED, as the guard would reject it.
 */
@Injectable()
export class SignatureDiagnosticsService {
  private readonly logger = new Logger(SignatureDiagnosticsService.name);

  constructor(
    private readonly nonces: RequestNonceService,
    @Optional() private readonly clock: Clock = new SystemClock(),
  ) {}

  async diagnose(
    context: ApiKeyContext,
    rawSecret: string,
    dto: SignatureDiagnosticsRequestDto,
  ): Promise<SignatureDiagnosticsResult> {
    if (dto.body !== undefined && dto.bodySha256 !== undefined) {
      throw new BadRequestException("Provide either body or bodySha256, not both.");
    }

    const report = diagnoseSignature({
      rawSecret,
      nowSeconds: Math.floor(this.clock.nowMs() / 1_000),
      input: {
        method: dto.method,
        path: dto.path,
        body: dto.body,
        bodySha256: dto.bodySha256,
        signature: dto.headers.signature,
        timestamp: dto.headers.timestamp,
        nonce: dto.headers.nonce,
        declaredCanonical: dto.declaredCanonical,
      },
    });

    let nonceStatus = report.nonceStatus;
    if (report.nonceClaimable) {
      const fresh = await this.nonces.claimNonce(
        context.keyId,
        dto.headers.nonce!,
        Number(dto.headers.timestamp),
      );
      nonceStatus = fresh ? "CONSUMED" : "REPLAYED";
    }

    const failureCategory: DiagnosticFailureCategory | null =
      report.failureCategory ?? (nonceStatus === "REPLAYED" ? "NONCE_REPLAYED" : null);

    // Key id and category only: never the nonce, signature, or body.
    this.logger.log(
      `Signature diagnostics for key ${context.keyId}: ${failureCategory ?? "VALID"}`,
    );

    const { nonceClaimable, ...rest } = report;
    void nonceClaimable;
    return {
      ...rest,
      result: failureCategory === null ? "VALID" : "INVALID",
      failureCategory,
      nonceStatus,
    };
  }
}
