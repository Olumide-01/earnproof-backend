# Signed Verification Evidence Bundles

## Overview

Signed Verification Evidence Bundles provide a portable, cryptographic manifest tying public proof outcomes to backend verification, contract state, Stellar ledger evidence, and expiration freshness without disclosing private source financial records or worker transaction histories.

## Bounded Scope & Security Model

1. **Allowed Evidence**:
   - `credentialHash`: Unique SHA-256 hash commitment of the issued credential.
   - `contractTransactionHash`: On-chain Stellar Soroban anchoring transaction hash (if anchored).
   - `commitment`: Contract-anchored commitment value.
   - `assetCode` & `assetIssuer`: Identity of the attested asset.
   - `verifiedAt`: ISO timestamp when verification occurred.
   - `expiresAt`: ISO timestamp when evidence validity expires.

2. **Privacy Guarantees**:
   - Zero raw memos, account balances, or counterparty addresses are included in the bundle.
   - The bundle contains only cryptographic commitments, verifiable signatures, and public contract identifiers.

3. **Size Bound**:
   - Total bundle manifest payload is strictly capped at 64 KB (`MAX_EVIDENCE_BUNDLE_BYTES`). Submissions exceeding this limit are rejected before processing.

## Manifest Structure

Version `1.0.0` canonical manifest specification:

```json
{
  "manifest": {
    "manifestVersion": "1.0.0",
    "bundleId": "bundle_1729094400000_abc123",
    "network": "testnet",
    "proofId": "clx1abc2def3ghi4",
    "evidence": {
      "credentialHash": "sha256:7d3a1c9e5b2f48a06c1d7e93b5a4f80213c6e9d5a7b1c3e5f7092a4b6c8d0e2f",
      "contractTransactionHash": "tx_abcdef123456...",
      "commitment": "sha256:4a8b7c6d5e...",
      "assetCode": "USDC",
      "assetIssuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      "verifiedAt": "2026-10-16T12:00:00.000Z",
      "expiresAt": "2026-11-16T12:00:00.000Z"
    }
  },
  "signing": {
    "keyId": "earnproof-v0",
    "algorithm": "hmac-sha256",
    "signature": "3a4f6c8d0e...",
    "signedAt": "2026-10-16T12:00:00.000Z"
  }
}
```

## Key Rotation and Overlap Windows

- **Active Version**: Only the active key (`CREDENTIAL_SIGNING_KEY_VERSION`) signs newly generated evidence bundles.
- **Verification Window**: Phased-out versions remain usable for verification until their explicit `CREDENTIAL_SIGNING_SECRET_V{n}_VERIFY_UNTIL` deadline.
- **Terminal Retired State**: Once a secret is removed from the keyring or passes its verify deadline, verification against it is rejected fail-closed with `unsupported_key`.

## Endpoints

- `POST /credentials/evidence-bundle/generate`: Generates and signs a bundle for an active, unexpired proof.
- `POST /credentials/evidence-bundle/verify`: Public verification endpoint that checks signatures, expiry, network consistency, and version compatibility.
