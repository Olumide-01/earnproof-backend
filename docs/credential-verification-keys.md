# Credential verification keys

`GET /api/v1/credentials/keys` publishes the public Ed25519 JWKs needed to
verify newly issued credentials. The response contains only `kty`, `crv`,
`x`, `alg`, `use`, `kid`, and lifecycle metadata; private signing material is
never returned.

New credentials identify their signing key in the proof block with `keyId` and
`algorithm: "EdDSA"`. Older HMAC credentials remain verifiable during the
migration.

To rotate a credential key, configure `CREDENTIAL_SIGNING_SECRET_PREVIOUS`
with the old secret before deploying the new `CREDENTIAL_SIGNING_SECRET`.
The previous key is published as `retired` for
`CREDENTIAL_SIGNING_KEY_OVERLAP_DAYS` (30 days by default), after which it is
removed from discovery and rejected for new verification requests. Keep the
overlap at least as long as the maximum credential verification lifetime.

The response is sorted by key identifier and includes an `ETag` plus
`Cache-Control: public, max-age=300, must-revalidate`. A matching
`If-None-Match` receives `304 Not Modified`.
