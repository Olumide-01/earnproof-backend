import { BadRequestException } from "@nestjs/common";
import { ApiKeyScope } from "@prisma/client";
import { ApiKeyContext } from "../../api-keys/api-key.types";
import { RequestNonceService } from "../../api-keys/request-nonce.service";
import {
  bodyDigest,
  buildCanonicalString,
  computeSignature,
  deriveSigningKey,
} from "../../common/crypto/request-signing";
import { Clock } from "../../common/time/clock";
import { SignatureDiagnosticsRequestDto } from "./dto/signature-diagnostics.dto";
import { SignatureDiagnosticsService } from "./signature-diagnostics.service";


/** Synthetic secret, only ever used in this spec. */
const SECRET = "test-secret-key-abcdefghij012345";
const NOW_SECONDS = 1_724_400_000;
const NONCE = "abc123def456ghi7";
const BODY = '{"thresholdAmount":"500.0000000"}';

const context = { keyId: "key-1", organizationId: "org-1", scopes: [ApiKeyScope.ORG_READ] } as unknown as ApiKeyContext;

class FixedClock extends Clock {
  now(): Date {
    return new Date(NOW_SECONDS * 1_000);
  }
}

/** Mirrors RequestNonceService.claimNonce: atomic first-claim-wins per key and nonce. */
function nonceStore() {
  const claimed = new Set<string>();
  const claimNonce = jest.fn(async (keyId: string, nonce: string) => {
    const key = `${keyId}:${nonce}`;
    if (claimed.has(key)) return false;
    claimed.add(key);
    return true;
  });
  return { claimNonce, claimed };
}

function request(overrides: Partial<SignatureDiagnosticsRequestDto["headers"]> = {}, extra: Partial<SignatureDiagnosticsRequestDto> = {}) {
  const canonical = buildCanonicalString({
    method: "POST",
    path: "/api/v1/proofs/minimum-income",
    timestamp: NOW_SECONDS,
    nonce: NONCE,
    bodySha256: bodyDigest(BODY),
  });
  return {
    method: "POST",
    path: "/api/v1/proofs/minimum-income",
    body: BODY,
    headers: {
      signature: computeSignature(deriveSigningKey(SECRET), canonical),
      timestamp: String(NOW_SECONDS),
      nonce: NONCE,
      ...overrides,
    },
    ...extra,
  } as SignatureDiagnosticsRequestDto;
}

function build() {
  const nonces = nonceStore();
  const service = new SignatureDiagnosticsService(nonces as unknown as RequestNonceService, new FixedClock());
  return { service, nonces };
}

describe("SignatureDiagnosticsService", () => {
  it("reports a valid request and consumes its nonce", async () => {
    const { service, nonces } = build();

    await expect(service.diagnose(context, SECRET, request())).resolves.toMatchObject({
      result: "VALID",
      failureCategory: null,
      nonceStatus: "CONSUMED",
    });
    expect(nonces.claimNonce).toHaveBeenCalledWith("key-1", NONCE, NOW_SECONDS);
  });

  it("reports a replay of the same synthetic request", async () => {
    const { service } = build();
    await service.diagnose(context, SECRET, request());

    await expect(service.diagnose(context, SECRET, request())).resolves.toMatchObject({
      result: "INVALID",
      failureCategory: "NONCE_REPLAYED",
      nonceStatus: "REPLAYED",
      signatureMatches: true,
    });
  });

  it("consumes the nonce even when the signature is wrong, so the request is never reusable", async () => {
    const { service, nonces } = build();

    const report = await service.diagnose(context, "a-different-synthetic-secret-000", request());

    expect(report).toMatchObject({ failureCategory: "SIGNATURE_INVALID", nonceStatus: "CONSUMED" });
    expect(nonces.claimed.has(`key-1:${NONCE}`)).toBe(true);
  });

  it("lets exactly one of two concurrent diagnostics consume a nonce", async () => {
    const { service } = build();

    const reports = await Promise.all([
      service.diagnose(context, SECRET, request()),
      service.diagnose(context, SECRET, request()),
    ]);

    expect(reports.map((report) => report.nonceStatus).sort()).toEqual(["CONSUMED", "REPLAYED"]);
  });

  it("does not claim a nonce outside the timestamp window or when malformed", async () => {
    const { service, nonces } = build();

    await expect(
      service.diagnose(context, SECRET, request({ timestamp: String(NOW_SECONDS - 301) })),
    ).resolves.toMatchObject({ failureCategory: "STALE_TIMESTAMP", nonceStatus: "NOT_EVALUATED" });
    await expect(
      service.diagnose(context, SECRET, request({ nonce: "short" })),
    ).resolves.toMatchObject({ failureCategory: "MALFORMED_NONCE", nonceStatus: "MALFORMED" });
    expect(nonces.claimNonce).not.toHaveBeenCalled();
  });

  it("reports a failing nonce store as a replay (fail closed)", async () => {
    const { service, nonces } = build();
    nonces.claimNonce.mockResolvedValueOnce(false);

    await expect(service.diagnose(context, SECRET, request())).resolves.toMatchObject({
      result: "INVALID",
      failureCategory: "NONCE_REPLAYED",
    });
  });

  it("rejects both body and bodySha256", async () => {
    const { service } = build();
    await expect(
      service.diagnose(context, SECRET, request({}, { bodySha256: bodyDigest(BODY) })),
    ).rejects.toThrow(BadRequestException);
  });

  it("never returns the nonce, the signature or internal claim flags", async () => {
    const { service } = build();
    const dto = request();

    const report = await service.diagnose(context, SECRET, dto);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(NONCE);
    expect(serialized).not.toContain(dto.headers.signature!.slice(3));
    expect(report).not.toHaveProperty("nonceClaimable");
  });
});
