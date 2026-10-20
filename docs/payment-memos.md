# Payment memos

Stellar memos are user-supplied data attached to a transaction. EarnProof
keeps them only so an owner can recognise their own payments, so they are
normalized, bounded and encrypted before they reach the database.
Implementation: [`memo-normalizer.ts`](../src/stellar/memo-normalizer.ts)
(Horizon to normalized) and [`payment-memo.ts`](../src/payments/payment-memo.ts)
(normalized to stored, and back).

## Allowlist by Stellar memo type

| Horizon `memo_type` | Accepted value | Stored as |
|---|---|---|
| `none` (or absent) | nothing | `none` |
| `text` | 1 to 28 UTF-8 bytes (the protocol limit), measured on the raw bytes | `text` |
| `text`, empty | nothing | `none` |
| `id` | decimal `0` to `18446744073709551615`, no sign or leading zeros | `id` |
| `hash` | exactly 32 bytes (canonical padded base64 or raw bytes) | `hash` |
| `return` | exactly 32 bytes | `return_hash` |
| any other type | nothing | `none`, `omitted: "unsupported"` |

Values outside these rules are never stored. A value that is too long becomes
`omitted: "oversized"`, and any other invalid value becomes
`omitted: "malformed"`. Only the reason is kept, never the content.

## Stored representation (version 2)

```json
{ "version": 2, "type": "none" }
{ "version": 2, "type": "none", "omitted": "unsupported | malformed | oversized | legacy" }
{ "version": 2, "type": "text | id | hash | return_hash", "ciphertext": "enc:v<key>:..." }
```

- **Encrypted, never plaintext.** Memo values are encrypted with the payment
  keyring (AES-256-GCM, the same versioned keys as payment amounts, so key
  rotation covers them). The memo type is part of the encrypted payload, so a
  ciphertext cannot be moved to another type.
- **Bounded before the write.** The serialized value must be at most 512 bytes
  before it is sent to the database. If it would be larger, it is replaced with
  an `oversized` omission. A database CHECK constraint
  (`Payment_memo_version_2_bounded`) rejects any non-version-2 value or any
  value over 1024 bytes as a backstop.
- **Strict on read.** Reading accepts only this exact shape: no extra fields,
  a known type, a ciphertext that decrypts and matches its type, and a value
  that passes the rules above again. Anything else, including arbitrary JSON,
  is reported to the owner as `{ "type": "none" }`.

The owner payment API (`memoContext`) keeps its existing shape. Text memos
report `truncated: false`, since protocol-sized memos are never truncated.

## Proof eligibility

Proof issuance never reads `Payment.memo`. Eligibility uses only
classification, `isEligible`, asset, amount and time. A unit test fails if any
module outside `src/payments` and `src/stellar` references the memo column.

## Compatibility policy for existing rows

Migration `20260926100000_version_payment_memos` handles existing rows:

- Rows whose memo is `NULL` are unchanged.
- Rows already in version 2 are unchanged.
- A legacy row recording no memo (`{"type": "none"}`) becomes
  `{"version": 2, "type": "none"}`.
- Every other legacy row, including the plaintext text, id and hash objects
  written by earlier releases and any arbitrary JSON, becomes
  `{"version": 2, "type": "none", "omitted": "legacy"}`.

Legacy plaintext is deliberately purged rather than migrated: the database
cannot encrypt it with the application keyring. Memos are public on-chain, so
the next payment sync re-derives each memo from Horizon and stores it in the
encrypted form. Until then, the API reports those payments as having no memo,
which is how it already treats unreadable memos. Rollback is dropping the CHECK
constraint. The purged content is not restorable from the database, by design.
