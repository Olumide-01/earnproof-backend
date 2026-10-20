# Payment address encryption at rest

Payment sender and recipient addresses are now encrypted in the application
before they reach the database, the same way payment amounts already are.
Equality queries on the sender go through a keyed lookup token instead of the
plaintext.

| Column | Contents |
|---|---|
| `sourceAddressEncrypted`, `destinationAddressEncrypted` | `aenc:v<N>:<iv>:<tag>:<ciphertext>`, AES-256-GCM. The field name is bound in as authenticated data, so a source ciphertext copied into the destination column fails to decrypt. |
| `sourceAddressLookup` | `hmac:v<N>:<mac>`: HMAC-SHA256 of the upper-cased, trimmed sender address, indexed. Supports only "payments from this sender". Recipients have no token because no query needs one. |
| `sourceAddress`, `destinationAddress` | Legacy plaintext. Never written by current code; cleared by the backfill. |

Code: [`protected-address.ts`](../src/common/crypto/protected-address.ts),
[`payment-address-cipher.ts`](../src/common/crypto/payment-address-cipher.ts),
[`payment-address-backfill.ts`](../src/payments/payment-address-backfill.ts).

## Keys and rotation

There is no new secret. For each `PAYMENT_ENCRYPTION_KEY_V<N>`, HKDF-SHA256
derives one key for address encryption and a separate one for lookup tokens.
Neither is the amount key itself. Writes use `PAYMENT_ENCRYPTION_KEY_VERSION`.

Rotation keeps lookups working:

- Every token carries its version.
- `PaymentAddressCipher.sourceLookupTokens(address)` returns a token for
  every loaded version, so a query of the form `sourceAddressLookup IN (...)`
  finds rows written under the retiring key as well as the active one.
- The backfill re-encrypts and re-tokens rows under the active version.

Retire a version only after `--verify-only` reports `staleKeyVersion: 0`. The
wider procedure is in [key rotation](key-rotation.md).

## Migration

1. **Deploy.** Migration `20260925020000_encrypt_payment_addresses` is additive:
   it adds the new columns and index and makes the plaintext columns nullable.
   From then on, sync writes only ciphertext and tokens. Reads prefer
   ciphertext and fall back to plaintext for rows not yet migrated. Re-syncing
   a legacy row also migrates it.
2. **Backfill.** Run:

   ```bash
   npm run payments:backfill-addresses -- --batch-size=200 --max-batches=50
   ```

   - **Bounded:** at most 1,000 rows per batch and `--max-batches` batches per
     run.
   - **Resumable:** a re-run selects only rows that still need work. Pass
     `--after=<cursor>` to continue a walk that stopped early.
   - **Verified:** each row's plaintext is cleared in the same conditional
     update that writes new ciphertext, and only after that ciphertext has
     been decrypted back to the original. If the row changed after it was
     read, it is skipped and picked up next run.
   - **Corruption:** a row whose address cannot be recovered, or whose
     plaintext and ciphertext disagree, is counted as `failed` and left
     untouched for an operator.

   The exit code is 0 when verification finds nothing left, 2 when work
   remains, and 1 on error.
3. **Verify.** Run `npm run payments:backfill-addresses -- --verify-only`. It
   must report `plaintextRemaining`, `missingCiphertext` and `staleKeyVersion`
   all 0.
4. **Contract (later release).** Drop `sourceAddress`, `destinationAddress` and
   the old `sourceAddress` index in a separate migration carrying the
   `migration-safety` destructive-approval markers. This PR does not do that
   step.

## Privacy guarantees

- Script output and backfill results are counts only.
- Decryption errors carry a failure kind (`malformed`,
  `unknown_key_version`, `integrity`) and never a value.
- `sourceAddress`, `destinationAddress`, both ciphertext columns and
  `sourceAddressLookup` are forbidden log fields: the structured logger throws
  if one is passed.
- The owner's payment DTO decrypts addresses. A row that cannot be decrypted
  shows `null` rather than failing the listing or exposing the stored value.
- A payment-receipt proof that discloses the sender decrypts it only when the
  owner asked for that disclosure. If it cannot be decrypted, the request is
  refused with `PAYMENT_NOT_ELIGIBLE`.
