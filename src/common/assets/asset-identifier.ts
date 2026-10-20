/**
 * Canonical asset identifier.
 *
 * The supported-asset registry, incoming payments, and issued proofs each
 * describe a Stellar asset with the same three primitives: a network, an
 * asset code, and an optional issuer. Historically each consumer built its
 * own ad-hoc string key from those primitives (see the removed
 * `PaymentsService.assetKey`), which silently dropped the network and used
 * a fragile `code:issuer ?? "native"` convention that could not, by
 * construction, tell a native asset apart from an issued asset whose code
 * happens to be the literal string "native".
 *
 * This module is the single source of truth for turning those primitives
 * into an unambiguous canonical identifier, and for the "does this
 * asset/issuer pair represent the native asset" question that everything
 * else derives from.
 *
 * Canonical form:
 *   `<network>:native:<code>`            - no issuer (native asset)
 *   `<network>:issued:<code>:<issuer>`   - has an issuer (anchored asset)
 *
 * The discriminator ("native" | "issued") is a hard tag rather than an
 * inferred convention, so the two kinds can never collide regardless of
 * what the asset code happens to spell.
 *
 * Network is folded to lower-case because it is our own deployment label
 * (e.g. "testnet", "public"), not attacker- or issuer-controlled data.
 * Asset codes are Stellar-defined and case-sensitive per the protocol
 * (e.g. "USDC" and "usdc" are different assets), so codes are preserved
 * exactly as given - only surrounding whitespace is trimmed defensively.
 * Issuer account IDs (Stellar "G..." addresses) are case-sensitive
 * (base32-encoded) and are likewise preserved exactly.
 */

export interface CanonicalAssetInput {
  network: string;
  code: string;
  issuer?: string | null;
}

export type CanonicalAssetKind = "native" | "issued";

/** Normalizes an issuer value: blank/whitespace-only issuers are treated as "no issuer". */
export function normalizeIssuer(issuer?: string | null): string | null {
  if (issuer === null || issuer === undefined) return null;
  const trimmed = issuer.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeCode(code: string): string {
  return code.trim();
}

function normalizeNetwork(network: string): string {
  return network.trim().toLowerCase();
}

/** Whether a code/issuer pair describes the network's native asset (no issuer). */
export function assetKind(issuer?: string | null): CanonicalAssetKind {
  return normalizeIssuer(issuer) === null ? "native" : "issued";
}

/**
 * Builds the canonical, unambiguous identifier for an asset on a given
 * network. Two inputs produce the same canonical id if and only if they
 * describe the same asset on the same network.
 */
export function canonicalAssetId(input: CanonicalAssetInput): string {
  const network = normalizeNetwork(input.network);
  const code = normalizeCode(input.code);
  const issuer = normalizeIssuer(input.issuer);

  return issuer === null
    ? `${network}:native:${code}`
    : `${network}:issued:${code}:${issuer}`;
}

/** True when both inputs canonicalize to the same asset on the same network. */
export function isSameCanonicalAsset(
  a: CanonicalAssetInput,
  b: CanonicalAssetInput,
): boolean {
  return canonicalAssetId(a) === canonicalAssetId(b);
}
