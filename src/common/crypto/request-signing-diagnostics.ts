import { timingSafeEqual } from "crypto";
import {
  bodyDigest,
  buildCanonicalString,
  computeSignature,
  DEFAULT_CLOCK_WINDOW_SECONDS,
  deriveSigningKey,
  NONCE_PATTERN,
  SIGNING_VERSION,
  SignatureFailureReason,
} from "./request-signing";

/**
 * Signed-request diagnostics (#316).
 *
 * Evaluates a synthetic signed request the way `RequestSigningGuard` would and
 * explains the outcome, without ever disclosing anything an integrator could
 * not already compute from their own inputs:
 *
 * - The expected signature, the derived signing key, and the server's
 *   canonical string are never returned. Component checks only say whether
 *   each line of the caller's *declared* canonical string matches the line the
 *   server built from the caller's own inputs.
 * - The nonce is never echoed. Its status is reported by category only.
 * - Checks run in the guard's order, so `failureCategory` is the error the
 *   guard would have produced for the same request.
 *
 * Nonce handling is done by the caller (the service), which consumes every
 * well-formed, in-window nonce it evaluates. A request that went through
 * diagnostics can therefore never be replayed against a live endpoint.
 */

export const DIAGNOSTICS_CANONICALIZATION_VERSION = SIGNING_VERSION;

/** Canonical string lines, in order. */
export const COVERED_COMPONENTS = ["method", "path", "timestamp", "nonce", "body-sha256"] as const;
export type CoveredComponent = (typeof COVERED_COMPONENTS)[number];

export type HeaderStatus = "PRESENT" | "MISSING" | "MALFORMED";
export type TimestampWindowStatus = "WITHIN" | "TOO_OLD" | "TOO_NEW" | "MALFORMED" | "MISSING";
export type ComponentStatus = "MATCH" | "MISMATCH" | "NOT_DECLARED";
export type CanonicalStructure =
  | "OK"
  | "NOT_DECLARED"
  | "CRLF_LINE_ENDINGS"
  | "TRAILING_NEWLINE"
  | "WRONG_LINE_COUNT";
export type NonceStatus = "CONSUMED" | "REPLAYED" | "MALFORMED" | "MISSING" | "NOT_EVALUATED";

/** Stable failure categories: the guard's reasons plus a replayed nonce. */
export type DiagnosticFailureCategory = SignatureFailureReason | "NONCE_REPLAYED";

export interface SignatureDiagnosticInput {
  method: string;
  path: string;
  /** Raw body exactly as signed. Mutually exclusive with `bodySha256`. */
  body?: string;
  /** Lowercase hex SHA-256 of the body, when the body itself is not sent. */
  bodySha256?: string;
  signature?: string;
  timestamp?: string;
  nonce?: string;
  /** The canonical string the integrator built, for line-by-line comparison. */
  declaredCanonical?: string;
}

export interface SignatureDiagnosticReport {
  canonicalizationVersion: string;
  coveredComponents: readonly CoveredComponent[];
  headers: { signature: HeaderStatus; timestamp: HeaderStatus; nonce: HeaderStatus };
  timestampWindow: {
    status: TimestampWindowStatus;
    /** Server time minus request time, in seconds. Null when unparseable. */
    skewSeconds: number | null;
    windowSeconds: number;
  };
  canonicalStructure: CanonicalStructure;
  components: { component: CoveredComponent; status: ComponentStatus }[];
  /** Whether the HMAC matched. Null when an earlier check prevented evaluation. */
  signatureMatches: boolean | null;
  /** First failure in guard order, before nonce handling. */
  failureCategory: SignatureFailureReason | null;
  /** True when the nonce should be claimed (well-formed and in window). */
  nonceClaimable: boolean;
  nonceStatus: NonceStatus;
}

export function diagnoseSignature(params: {
  rawSecret: string;
  input: SignatureDiagnosticInput;
  nowSeconds: number;
  windowSeconds?: number;
}): SignatureDiagnosticReport {
  const { rawSecret, input, nowSeconds } = params;
  const windowSeconds = params.windowSeconds ?? DEFAULT_CLOCK_WINDOW_SECONDS;

  const timestamp = parseTimestamp(input.timestamp);
  const headers = {
    signature: headerStatus(input.signature, (value) => /^v1=[a-f0-9]{64}$/.test(value)),
    timestamp: headerStatus(input.timestamp, () => timestamp !== null),
    nonce: headerStatus(input.nonce, (value) => NONCE_PATTERN.test(value)),
  };

  const skewSeconds = timestamp === null ? null : nowSeconds - timestamp;
  const timestampWindow = {
    status: windowStatus(headers.timestamp, skewSeconds, windowSeconds),
    skewSeconds,
    windowSeconds,
  };

  const bodySha256 = input.bodySha256 ?? bodyDigest(input.body ?? null);
  const serverLines = [
    input.method.toUpperCase(),
    input.path,
    input.timestamp ?? "",
    input.nonce ?? "",
    bodySha256,
  ];
  const { structure, components } = compareCanonical(input.declaredCanonical, serverLines);

  const failureCategory = firstFailure(headers, timestampWindow.status);

  // The HMAC is only computed once every input is well-formed, as in the guard.
  let signatureMatches: boolean | null = null;
  if (failureCategory === null || failureCategory === SignatureFailureReason.STALE_TIMESTAMP) {
    if (headers.signature === "PRESENT" && headers.nonce === "PRESENT" && timestamp !== null) {
      signatureMatches = constantTimeMatch(
        input.signature!,
        computeSignature(
          deriveSigningKey(rawSecret),
          buildCanonicalString({
            method: input.method,
            path: input.path,
            timestamp,
            nonce: input.nonce!,
            bodySha256,
          }),
        ),
      );
    }
  }

  return {
    canonicalizationVersion: DIAGNOSTICS_CANONICALIZATION_VERSION,
    coveredComponents: COVERED_COMPONENTS,
    headers,
    timestampWindow,
    canonicalStructure: structure,
    components,
    signatureMatches,
    failureCategory:
      failureCategory ?? (signatureMatches === false ? SignatureFailureReason.SIGNATURE_INVALID : null),
    nonceClaimable: headers.nonce === "PRESENT" && timestampWindow.status === "WITHIN",
    nonceStatus:
      headers.nonce === "MISSING" ? "MISSING" : headers.nonce === "MALFORMED" ? "MALFORMED" : "NOT_EVALUATED",
  };
}

function parseTimestamp(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isInteger(value) && String(value) === raw.trim() ? value : null;
}

function headerStatus(value: string | undefined, valid: (value: string) => boolean): HeaderStatus {
  if (value === undefined || value === "") return "MISSING";
  return valid(value) ? "PRESENT" : "MALFORMED";
}

/** Exactly at ±window is accepted, matching `verifySignature` (`> window` fails). */
function windowStatus(
  header: HeaderStatus,
  skewSeconds: number | null,
  windowSeconds: number,
): TimestampWindowStatus {
  if (header === "MISSING") return "MISSING";
  if (skewSeconds === null) return "MALFORMED";
  if (skewSeconds > windowSeconds) return "TOO_OLD";
  if (skewSeconds < -windowSeconds) return "TOO_NEW";
  return "WITHIN";
}

/** Guard order: headers present -> timestamp -> window -> nonce -> signature format. */
function firstFailure(
  headers: SignatureDiagnosticReport["headers"],
  window: TimestampWindowStatus,
): SignatureFailureReason | null {
  if (Object.values(headers).includes("MISSING")) return SignatureFailureReason.MISSING_HEADERS;
  if (headers.timestamp === "MALFORMED") return SignatureFailureReason.MALFORMED_TIMESTAMP;
  if (window !== "WITHIN") return SignatureFailureReason.STALE_TIMESTAMP;
  if (headers.nonce === "MALFORMED") return SignatureFailureReason.MALFORMED_NONCE;
  if (headers.signature === "MALFORMED") return SignatureFailureReason.MALFORMED_SIGNATURE;
  return null;
}

function compareCanonical(
  declared: string | undefined,
  serverLines: string[],
): { structure: CanonicalStructure; components: SignatureDiagnosticReport["components"] } {
  if (declared === undefined) {
    return {
      structure: "NOT_DECLARED",
      components: COVERED_COMPONENTS.map((component) => ({ component, status: "NOT_DECLARED" })),
    };
  }

  const structure: CanonicalStructure = declared.includes("\r")
    ? "CRLF_LINE_ENDINGS"
    : declared.endsWith("\n")
      ? "TRAILING_NEWLINE"
      : declared.split("\n").length !== COVERED_COMPONENTS.length
        ? "WRONG_LINE_COUNT"
        : "OK";

  // Lines are compared after removing a CR so one mistake is not reported five times.
  const lines = declared.replace(/\r/g, "").split("\n");
  return {
    structure,
    components: COVERED_COMPONENTS.map((component, index) => ({
      component,
      status: lines[index] === serverLines[index] ? "MATCH" : "MISMATCH",
    })),
  };
}

function constantTimeMatch(presented: string, expected: string): boolean {
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
