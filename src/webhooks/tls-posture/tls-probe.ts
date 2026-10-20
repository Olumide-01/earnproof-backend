import { WebhookTlsProbeOutcome } from "@prisma/client";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as tls from "node:tls";
import {
  assertSafeDestinationUrl,
  DestinationBlockedError,
  isBlockedHost,
} from "../../common/http/destination-guard";

/**
 * TLS posture probe for a webhook endpoint (#315).
 *
 * The probe is a TLS handshake and nothing else: no HTTP request is written,
 * so there is no response, no redirect to follow, and no endpoint behaviour is
 * triggered. Destination safety reuses the outbound guard
 * (`common/http/destination-guard`) and goes further than delivery does:
 *
 * 1. The URL must pass `assertSafeDestinationUrl` (https only, default port,
 *    no credentials, no internal hostnames or literals).
 * 2. The hostname is resolved once and **every** address must be public.
 * 3. The socket connects to the address that was checked, with the hostname
 *    sent as SNI. Connecting by address rather than by name is what closes the
 *    DNS-rebinding window between the check and the connection.
 *
 * Results are categories plus public certificate facts. The resolved address,
 * resolver errors and TLS library messages are never returned, so a probe
 * cannot be used to map internal name resolution.
 *
 * Weak protocols are detected by offering TLS 1.0 and above: a server that
 * negotiates TLS 1.0/1.1, or that only speaks something older, is reported as
 * WEAK_PROTOCOL. A server that supports TLS 1.2+ *and* older versions
 * negotiates the newest and is reported healthy; enumerating every supported
 * version is out of scope.
 */

export const TLS_PROBE_PORT = 443;
export const DEFAULT_TLS_PROBE_TIMEOUT_MS = 5_000;
export const DEFAULT_EXPIRY_WARNING_DAYS = 14;

/** Protocols accepted as strong. Anything else that completes a handshake is weak. */
const STRONG_PROTOCOLS = new Set(["TLSv1.2", "TLSv1.3"]);

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Certificate fields the probe reads. A subset of `tls.PeerCertificate`. */
export interface ProbeCertificate {
  valid_from?: string;
  valid_to?: string;
  fingerprint256?: string;
  subject?: unknown;
  subjectaltname?: string;
}

export interface TlsHandshake {
  authorized: boolean;
  protocol: string | null;
  certificate: ProbeCertificate | null;
}

export interface TlsConnectTarget {
  address: string;
  port: number;
  /** SNI name; omitted for IP-literal endpoints. */
  servername?: string;
  timeoutMs: number;
}

/** Performs a handshake; rejects with an error carrying a `code` on failure. */
export type TlsConnector = (target: TlsConnectTarget) => Promise<TlsHandshake>;

export type IdentityCheck = (hostname: string, certificate: ProbeCertificate) => Error | undefined;

export interface TlsProbeResult {
  outcome: WebhookTlsProbeOutcome;
  protocol: string | null;
  certificateNotBefore: Date | null;
  certificateNotAfter: Date | null;
  certificateFingerprint: string | null;
  durationMs: number;
}

export interface TlsProbeDependencies {
  resolve?: typeof lookup;
  connect?: TlsConnector;
  checkIdentity?: IdentityCheck;
  now?: () => Date;
  timeoutMs?: number;
  expiryWarningDays?: number;
}

export async function probeTlsEndpoint(
  url: string,
  deps: TlsProbeDependencies = {},
): Promise<TlsProbeResult> {
  const now = deps.now ?? (() => new Date());
  const started = now().getTime();
  const finish = (partial: Partial<TlsProbeResult> & { outcome: WebhookTlsProbeOutcome }): TlsProbeResult => ({
    protocol: null,
    certificateNotBefore: null,
    certificateNotAfter: null,
    certificateFingerprint: null,
    ...partial,
    durationMs: Math.max(0, now().getTime() - started),
  });

  try {
    assertSafeDestinationUrl(url);
  } catch (error) {
    if (error instanceof DestinationBlockedError) return finish({ outcome: "DESTINATION_BLOCKED" });
    throw error;
  }

  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(hostname) !== 0;
  let address = hostname;

  if (!literal) {
    let addresses: { address: string }[];
    try {
      addresses = await (deps.resolve ?? lookup)(hostname, { all: true, verbatim: true });
    } catch {
      return finish({ outcome: "UNREACHABLE" });
    }
    if (addresses.length === 0) return finish({ outcome: "UNREACHABLE" });
    if (addresses.some((entry) => isBlockedHost(entry.address))) {
      return finish({ outcome: "DESTINATION_BLOCKED" });
    }
    address = addresses[0].address;
  }

  let handshake: TlsHandshake;
  try {
    handshake = await (deps.connect ?? nodeTlsConnector)({
      address,
      port: TLS_PROBE_PORT,
      servername: literal ? undefined : hostname,
      timeoutMs: deps.timeoutMs ?? DEFAULT_TLS_PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    return finish({ outcome: classifyConnectError(error) });
  }

  const facts = certificateFacts(handshake.certificate);
  return finish({
    ...facts,
    protocol: handshake.protocol ? handshake.protocol.slice(0, 16) : null,
    outcome: classifyHandshake(
      hostname,
      handshake,
      now(),
      deps.expiryWarningDays ?? DEFAULT_EXPIRY_WARNING_DAYS,
      deps.checkIdentity ?? defaultIdentityCheck,
    ),
  });
}

/**
 * Classifies a completed handshake. First matching rule wins, so a
 * certificate with several problems always reports the same one:
 * no certificate -> expired -> not yet valid -> hostname mismatch ->
 * untrusted chain -> weak protocol -> expiring soon -> healthy.
 *
 * Boundaries: a certificate is EXPIRED only strictly after `valid_to` (X.509
 * validity is inclusive), and EXPIRING_SOON when `valid_to` is within the
 * warning window, inclusive.
 */
export function classifyHandshake(
  hostname: string,
  handshake: TlsHandshake,
  now: Date,
  expiryWarningDays: number,
  checkIdentity: IdentityCheck = defaultIdentityCheck,
): WebhookTlsProbeOutcome {
  const certificate = handshake.certificate;
  const { certificateNotBefore, certificateNotAfter } = certificateFacts(certificate);

  if (!certificate || !certificateNotAfter || !certificateNotBefore) return "HANDSHAKE_FAILED";
  if (now.getTime() > certificateNotAfter.getTime()) return "EXPIRED";
  if (now.getTime() < certificateNotBefore.getTime()) return "NOT_YET_VALID";
  if (checkIdentity(hostname, certificate)) return "HOSTNAME_MISMATCH";
  if (!handshake.authorized) return "UNTRUSTED";
  if (!handshake.protocol || !STRONG_PROTOCOLS.has(handshake.protocol)) return "WEAK_PROTOCOL";
  if (certificateNotAfter.getTime() - now.getTime() <= expiryWarningDays * DAY_MS) {
    return "EXPIRING_SOON";
  }
  return "HEALTHY";
}

/** Maps a connection failure to a category. Never inspects or keeps the message. */
export function classifyConnectError(error: unknown): WebhookTlsProbeOutcome {
  const code = String((error as { code?: unknown } | null)?.code ?? "");

  if (code === "ETIMEDOUT") return "TIMEOUT";
  if (
    ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ENOTFOUND", "EAI_AGAIN"].includes(code)
  ) {
    return "UNREACHABLE";
  }
  if (/UNSUPPORTED_PROTOCOL|ALERT_PROTOCOL_VERSION|NO_PROTOCOLS_AVAILABLE/.test(code)) {
    return "WEAK_PROTOCOL";
  }
  return "HANDSHAKE_FAILED";
}

function certificateFacts(certificate: ProbeCertificate | null): Pick<
  TlsProbeResult,
  "certificateNotBefore" | "certificateNotAfter" | "certificateFingerprint"
> {
  const date = (value?: string) => {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  const fingerprint = certificate?.fingerprint256;

  return {
    certificateNotBefore: date(certificate?.valid_from),
    certificateNotAfter: date(certificate?.valid_to),
    certificateFingerprint:
      fingerprint && /^[0-9A-F:]{1,95}$/i.test(fingerprint) ? fingerprint : null,
  };
}

function defaultIdentityCheck(hostname: string, certificate: ProbeCertificate): Error | undefined {
  return tls.checkServerIdentity(hostname, certificate as tls.PeerCertificate);
}

/**
 * Production connector. `rejectUnauthorized: false` is deliberate: the probe
 * must complete the handshake to *report* an untrusted or mismatched
 * certificate. No application data is ever written to the socket, and the
 * relaxed security level only lets the probe observe a weak protocol; it is
 * never used for delivery.
 */
export const nodeTlsConnector: TlsConnector = (target) =>
  new Promise<TlsHandshake>((resolve, reject) => {
    const socket = tls.connect({
      host: target.address,
      port: target.port,
      servername: target.servername,
      rejectUnauthorized: false,
      minVersion: "TLSv1",
      ciphers: "DEFAULT@SECLEVEL=0",
    });

    const fail = (error: unknown) => {
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(target.timeoutMs, () =>
      fail(Object.assign(new Error("TLS probe timed out"), { code: "ETIMEDOUT" })),
    );
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      const handshake: TlsHandshake = {
        authorized: socket.authorized,
        protocol: socket.getProtocol() ?? null,
        certificate: certificate && Object.keys(certificate).length > 0 ? certificate : null,
      };
      socket.destroy();
      resolve(handshake);
    });
  });
