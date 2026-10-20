# Authorization and tenant-isolation matrix

All bearer routes require a live session: anonymous, malformed, expired,
revoked, suspended, and deleted users receive `401` without resource data.
`ADMIN` is the only administrator role; `DEVELOPER`, `ISSUER`, and `WORKER`
have no implicit administrative access. A protected resource scoped to another
user or organization is answered as `404`, identical to an absent resource.

| Routes | Identity and permission | Ownership rule | Denial |
| --- | --- | --- | --- |
| `GET/POST /auth/session,/logout,/rotate` | bearer session | own session | 401 |
| `POST /auth/wallet-rotation`, `POST /auth/wallet-rotation/:id/complete` | bearer session + signatures from the current and replacement wallets | own account and own rotation; another account's rotation id is answered like an unknown one | 400/401/409 |
| `GET/POST/PATCH /proofs`, `POST /proofs/*`, `PATCH /proofs/:id/revoke`, `GET /proofs/:id/verification-stats` | bearer session | proof owner | 401/404 |
| `GET /proofs/:id/verify`, `POST /credentials/verify` | public | only published verification result | no protected fields |
| `POST /payment-backfills`, `GET /payment-backfills/:id`, `POST /payment-backfills/:id/cancel` | bearer `ADMIN` | global admin exception | 401/403/404 |
| `GET/POST/PATCH /payments*`, `GET/POST/PATCH/DELETE /trusted-sources*` | bearer session | user-owned record | 401/404 |
| `GET /payments/account-rotations/current`, `POST /payments/account-rotations`, `GET /payments/account-rotations/:id`, `POST /payments/account-rotations/:id/verify,/activate,/rollback,/cancel` | bearer session + signature from the new account | own rotations only; another user's rotation id is answered like an unknown one | 400/401/404/409 |
| `GET /metrics/rollups`, `GET /metrics/rollups/status` | bearer `ADMIN` | global admin exception | 400/401/403 |
| `POST/GET /deployments/config/snapshots*`, `POST /deployments/config/snapshots/import`, `POST/GET /deployments/config/rollouts*` (gates, promote, rollback, cohort) | bearer `ADMIN` | global admin exception | 400/401/403/404/409/503 |
| `GET/POST/PATCH/DELETE /webhooks*`, delivery replay | bearer `DEVELOPER` or `ADMIN` | caller's organization | 401/403/404 |
| `GET /organizations`, `GET/PATCH /organizations/:id` | bearer | creator; ADMIN exception | 401/404 |
| `GET/PATCH /users/me` | bearer session | caller's own account only; identity from the session, never the path | 401/422 |
| `GET /users/:id`, `PATCH /users/:id/status`, `PATCH /users/:id/role` | bearer `ADMIN` | global admin; never the caller's own status or role | 401/403/404/409 |
| `POST /organizations`, issuer create/update/sync and `/issuers/admin*` | bearer `ADMIN` | global admin exception | 401/403 |
| `POST /organizations/:id/archive,/restore`, `PUT/DELETE /organizations/:id/legal-hold`, `GET /organizations/:id/deletion-eligibility`, `DELETE /organizations/:id` | bearer `ADMIN` | global admin only, never the creator | 401/403/404/409 |
| `GET /issuers*` | public for published issuer data; bearer for admin views | published vs admin view | 401/403/404 |
| `POST/GET /issuers/:id/address-rotations`, `POST /issuers/:id/address-rotations/:rotationId/reconcile` | bearer `ADMIN` | global admin; a rotation id is only resolved under its own issuer | 400/401/403/404/409/422/503 |
| `GET/POST/DELETE /api-keys*`, rotate/revoke | bearer organization creator or ADMIN | organization-scoped query | 401/403/404 |
| `GET /integrations/auth-context` | API key + `ORG_READ` | key organization selected by `X-Organization-Id` | 401 invalid/cross-org, 403 scope |
| `GET /health/diagnostics` | API key + `ORG_ADMIN` | key organization | 401/403 |
| `POST /integrations/signature-diagnostics` | API key + `ORG_READ`, 10/min | key organization; nonces consumed in the key's namespace | 400/401/403/429 |
| `GET /organizations/:id/role-approval-policy`, `GET .../history` | bearer ACTIVE member or ADMIN | path organization | 401/403/404 |
| `POST /organizations/:id/role-approval-policy/preview` | bearer organization ADMIN/OWNER or ADMIN | path organization | 400/401/403/404 |
| `PUT /organizations/:id/role-approval-policy` | bearer organization OWNER or ADMIN | path organization; `expectedVersion` must be active | 400/401/403/404/409 |
| `GET /organizations/:id/webhooks/tls-posture`, `GET .../:webhookId/tls-posture` | bearer ACTIVE member or ADMIN | webhook in path organization, else 404 | 401/403/404 |
| `POST /organizations/:id/webhooks/:webhookId/tls-posture/probe` | bearer organization ADMIN/OWNER or ADMIN | webhook in path organization, else 404; 60 s cooldown | 401/403/404/409/429 |
| `GET/POST /admin/audit-legal-holds*` | bearer `ADMIN` | global admin; every decision needs a second administrator | 400/401/403/404/409 |

Account status transitions are `PENDING→ACTIVE|SUSPENDED|REVOKED`,
`ACTIVE→SUSPENDED|REVOKED` and `SUSPENDED→ACTIVE|REVOKED`; `REVOKED` is
terminal and `DELETED` is never assigned through the API. Suspension and
revocation revoke every live session in the same transaction and refuse new
logins; reinstatement revokes again, so it never resurrects a session. An account that still owns a live organization (implicit ownership:
`Organization.createdById`) cannot be moved to `WORKER`.

The table-driven e2e suite verifies allowed and denied sessions, role denial,
cross-tenant indistinguishability, suspended/deleted users, and API-key scopes
without treating a bearer session as an API key. Audit and error envelopes must
contain only bounded identifiers and never credential secrets, wallet material,
payment records, or hidden resource fields.
