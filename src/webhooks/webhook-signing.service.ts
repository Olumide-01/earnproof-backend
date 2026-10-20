import { Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "crypto";

/**
 * Webhook signing and verification.
 *
 * ## Signing scheme
 *
 * Algorithm: HMAC-SHA256
 *
 * Signing base string (all four parts joined with a literal `.`):
 *   `<unix-timestamp-seconds>.<deliveryId>.<keyId>.<raw-request-body>`
 *
 * Example:
 *   `1724400000.clxyz123.key_v1.{"specVersion":"1","id":"clxyz123",...}`
 *
 * ## Request headers sent on every delivery
 *
 * | Header                    | Value                                      |
 * |---------------------------|--------------------------------------------|
 * | `X-EarnProof-Timestamp`   | Unix timestamp in seconds (string)         |
 * | `X-EarnProof-Delivery`    | Delivery ID (cuid)                         |
 * | `X-EarnProof-Event`       | Event type, e.g. `proof.created`           |
 * | `X-EarnProof-Signature`   | `v1.key_id=<hex-encoded-HMAC-SHA256>`     |
 * | `Content-Type`            | `application/json`                         |
 *
 * ## Integrator verification procedure
 *
 * 1. Read `X-EarnProof-Timestamp`, `X-EarnProof-Delivery`, and `X-EarnProof-Signature` from headers.
 * 2. Extract keyId from signature: split on `=` and take the part after `v1.`.
 * 3. Look up the signing secret for this webhook using the keyId.
 * 4. Construct the signing base string:
 *    `timestamp + "." + deliveryId + "." + keyId + "." + rawRequestBody`
 * 5. Compute `HMAC-SHA256(signingSecret, baseString)` and hex-encode.
 * 6. Prepend `v1.keyId=` and compare with `X-EarnProof-Signature` using a
 *    constant-time comparison.
 * 7. Optionally reject requests where the timestamp is more than 5 minutes
 *    old to prevent replay attacks.
 */
@Injectable()
export class WebhookSigningService {
  /**
   * Compute the signature header value for an outbound delivery.
   *
   * @param secret      Raw (decrypted) signing secret for the endpoint.
   * @param timestamp   Unix timestamp in seconds.
   * @param deliveryId  Delivery ID (cuid).
   * @param keyId       Non-secret key identifier (from WebhookSecretVersion).
   * @param body        Serialised JSON request body.
   */
  sign(
    secret: string,
    timestamp: number,
    deliveryId: string,
    keyId: string,
    body: string,
  ): string {
    const baseString = `${timestamp}.${deliveryId}.${keyId}.${body}`;
    const digest = createHmac("sha256", secret)
      .update(baseString, "utf8")
      .digest("hex");
    return `v1.${keyId}=${digest}`;
  }

  /**
   * Verify an inbound signature (used in tests and by integrators).
   *
   * Returns `true` only when the computed digest matches the supplied
   * signature in constant time.
   *
   * Extracts keyId from the signature header for key identification.
   */
  verify(
    secret: string,
    timestamp: number,
    deliveryId: string,
    keyId: string,
    body: string,
    signature: string,
  ): boolean {
    const expected = this.sign(secret, timestamp, deliveryId, keyId, body);
    try {
      return timingSafeEqual(
        Buffer.from(expected, "utf8"),
        Buffer.from(signature, "utf8"),
      );
    } catch {
      // Buffers differ in length — definitely not equal.
      return false;
    }
  }

  /**
   * Extract the keyId from a signature header.
   *
   * Expected format: `v1.<keyId>=<digest>`
   * Returns null if signature format is invalid.
   */
  extractKeyId(signature: string): string | null {
    const match = signature.match(/^v1\.([^=]+)=/);
    return match ? match[1] : null;
  }
}
