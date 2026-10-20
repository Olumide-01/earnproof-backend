# API Key Authentication Guide

**For integrators and machine-to-machine (M2M) applications.**

API keys are stable, long-lived credentials for machine integrations to authenticate with the EarnProof API without a user present. This guide covers creating, using, rotating, and revoking API keys, scope management, and best practices.

---

## Table of Contents

1. [Overview](#overview)
2. [Getting Started](#getting-started)
3. [API Key Lifecycle](#api-key-lifecycle)
4. [Authentication](#authentication)
5. [Scopes and Permissions](#scopes-and-permissions)
6. [Rate Limiting](#rate-limiting)
7. [Security Best Practices](#security-best-practices)
8. [Code Examples](#code-examples)
9. [Troubleshooting](#troubleshooting)

---

## Overview

### What is an API Key?

An API key is a cryptographically generated secret token that your application uses to authenticate with the EarnProof API. Unlike session tokens (which authenticate individual wallet holders), API keys represent your application's identity and are designed for programmatic, long-lived integrations.

**Key characteristics:**

- **One-time display** — The raw secret is shown only once when created or rotated. Store it securely immediately; you cannot retrieve it later.
- **Organized isolation** — Keys belong to an organization and can only be used within that organization's scope.
- **Scope-based permissions** — Each key is assigned a set of scopes that define what it can do. Keys cannot exceed their assigned scopes.
- **Stable identity** — The key's ID remains the same across rotations, so you don't need to update references in your code.
- **Audit trail** — All key operations (create, rotate, revoke, use) are logged for compliance and security review.

---

## Getting Started

### Prerequisites

You need:
- An EarnProof account and an organization
- Administrator access to your organization (to create and manage keys)
- A way to store secrets securely (see [Security Best Practices](#security-best-practices))

### Create Your First API Key

1. **Authenticate** — Log in to EarnProof with your wallet and session token.
2. **Call the create endpoint** — See [Creating an API Key](#creating-an-api-key) below.
3. **Save the secret immediately** — The secret is displayed only once.
4. **Add it to your secrets manager** — Never commit it to version control.

---

## API Key Lifecycle

### Creating an API Key

**Endpoint:** `POST /api/v1/api-keys`

**Authentication:** Session token (wallet authentication required)

**Request:**

```json
{
  "name": "GitHub CI/CD Pipeline",
  "scopes": ["PROOF_VERIFY", "PAYMENT_READ"],
  "expiresAt": "2027-12-31T23:59:59Z"
}
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Human-readable label for this key (1–120 characters). Use something descriptive like your service name or integration purpose. |
| `scopes` | array | No | List of scopes this key is allowed to use. If omitted, defaults to no scopes (key cannot perform any operations). See [Scopes and Permissions](#scopes-and-permissions). |
| `expiresAt` | string (ISO 8601) | No | Future date/time when the key automatically expires. If omitted, key does not expire. Must be in UTC. |
| `organizationId` | string | No | Organization ID to create the key for. Required only if you manage multiple organizations. |

**Response (201 Created):**

```json
{
  "secret": "dGVzdGtleV8w_VlqXyz...[full 43-character base64url string]",
  "apiKey": {
    "id": "key_ckv8v6h2b0000qzrmn831i7rn",
    "prefix": "dGVzdGtl",
    "name": "GitHub CI/CD Pipeline",
    "status": "ACTIVE",
    "scopes": ["PROOF_VERIFY", "PAYMENT_READ"],
    "createdAt": "2026-08-24T12:00:00Z",
    "expiresAt": "2027-12-31T23:59:59Z"
  }
}
```

**Important:** The `secret` field is the full API key. Save it immediately to your secrets manager. It will never be displayed again. Only the `prefix` (first 8 characters) is retrievable later for identification purposes.

**HTTP Status Codes:**

| Code | Reason |
|------|--------|
| 201 | Key created successfully |
| 400 | Invalid request (e.g., `expiresAt` in the past, unknown scope name) |
| 401 | Session token is missing, invalid, or expired |
| 403 | You are not an organization administrator |

---

### Using an API Key

**Endpoint:** Any authenticated endpoint

**How to authenticate:**

Include the API key in the `Authorization` header with a `Bearer` prefix:

```http
Authorization: Bearer <secret>
```

Also include the organization ID in the `X-Organization-Id` header:

```http
X-Organization-Id: <organization-id>
```

**Example request:**

```bash
curl -X GET https://api.earnproof.com/api/v1/api-keys \
  -H "Authorization: Bearer dGVzdGtleV8w_VlqXyz..." \
  -H "X-Organization-Id: org_12345abc"
```

**Response on success:**

The endpoint executes normally and returns its standard response. The key's `lastUsedAt` timestamp is updated in the background.

**Response on failure:**

| Scenario | Status | Response |
|----------|--------|----------|
| Invalid key format | 401 | `{"statusCode": 401, "code": "UNAUTHORIZED", "message": "Invalid API key"}` |
| Key not found or revoked | 401 | `{"statusCode": 401, "code": "UNAUTHORIZED", "message": "Invalid API key"}` |
| Key expired | 401 | `{"statusCode": 401, "code": "UNAUTHORIZED", "message": "Invalid API key"}` |
| Key lacks required scope | 403 | `{"statusCode": 403, "code": "FORBIDDEN", "message": "Insufficient scopes. Required: PROOF_VERIFY. Missing: PROOF_VERIFY"}` |

**Note:** Authentication failures (401) intentionally return the same message regardless of the root cause (not found, wrong secret, revoked, expired) to prevent attackers from probing which keys are real.

---

### Listing API Keys

**Endpoint:** `GET /api/v1/api-keys`

**Authentication:** Session token (organization admin required)

**Request:**

```http
GET /api/v1/api-keys?organizationId=org_12345abc
Authorization: Bearer <session-token>
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `organizationId` | string | No | Organization ID to list keys for. Required if you manage multiple organizations. |

**Response (200 OK):**

```json
[
  {
    "id": "key_ckv8v6h2b0000qzrmn831i7rn",
    "prefix": "dGVzdGtl",
    "name": "GitHub CI/CD Pipeline",
    "status": "ACTIVE",
    "scopes": ["PROOF_VERIFY", "PAYMENT_READ"],
    "createdAt": "2026-08-24T12:00:00Z",
    "rotatedAt": null,
    "revokedAt": null,
    "expiresAt": "2027-12-31T23:59:59Z",
    "lastUsedAt": "2026-08-24T13:30:00Z"
  }
]
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Stable, unique identifier for this key. Safe to store as a reference. |
| `prefix` | string | First 8 characters of the secret (non-secret, for display/logging). |
| `name` | string | Human-readable label you assigned. |
| `status` | string | `ACTIVE` or `REVOKED`. Only `ACTIVE` keys can authenticate. |
| `scopes` | array | List of scopes this key is permitted to use. |
| `createdAt` | ISO 8601 | When the key was created. |
| `rotatedAt` | ISO 8601 \| null | When the key was last rotated (new secret generated). |
| `revokedAt` | ISO 8601 \| null | When the key was revoked (null if still active). |
| `expiresAt` | ISO 8601 \| null | When the key automatically expires (null if no expiry). |
| `lastUsedAt` | ISO 8601 \| null | When the key was last successfully used to authenticate. |

**HTTP Status Codes:**

| Code | Reason |
|------|--------|
| 200 | Success |
| 401 | Session token is missing, invalid, or expired |
| 403 | You are not an organization administrator |

---

### Rotating an API Key

**Endpoint:** `POST /api/v1/api-keys/:id/rotate`

**Authentication:** Session token (organization admin required)

**Request:**

```http
POST /api/v1/api-keys/key_ckv8v6h2b0000qzrmn831i7rn/rotate
Authorization: Bearer <session-token>
```

**Response (200 OK):**

```json
{
  "secret": "bmV3c2VjcmV0MDEy_VlqXyz...[full 43-character base64url string]",
  "apiKey": {
    "id": "key_ckv8v6h2b0000qzrmn831i7rn",
    "prefix": "bmV3c2Vj",
    "name": "GitHub CI/CD Pipeline",
    "status": "ACTIVE",
    "scopes": ["PROOF_VERIFY", "PAYMENT_READ"],
    "rotatedAt": "2026-08-24T14:00:00Z"
  }
}
```

**What happens:**

1. A new secret is generated
2. The old secret is **immediately invalidated** and cannot be used again
3. The key ID remains the same (your code references don't break)
4. The new secret is returned exactly once—save it immediately
5. The old secret is never retrievable

**Use rotation when:**

- Your current secret may be compromised
- You want to enforce key retirement on a schedule
- An employee or service leaves and needs their access revoked without disabling the integration

**HTTP Status Codes:**

| Code | Reason |
|------|--------|
| 200 | Key rotated; new secret returned |
| 401 | Session token is missing, invalid, or expired |
| 403 | You are not an organization administrator, or the key belongs to another organization |

---

### Revoking an API Key

**Endpoint:** `DELETE /api/v1/api-keys/:id`

**Authentication:** Session token (organization admin required)

**Request:**

```http
DELETE /api/v1/api-keys/key_ckv8v6h2b0000qzrmn831i7rn
Authorization: Bearer <session-token>
```

**Response (204 No Content):**

No body is returned on success.

**What happens:**

1. The key is marked as `REVOKED`
2. Immediate effect—the key stops working instantly
3. No replacement secret is issued
4. The key cannot be reactivated; create a new one if needed

**Use revocation when:**

- You want to permanently disable a key (e.g., service being retired)
- An integration is no longer needed
- As an alternative to rotation when you don't need a replacement

**HTTP Status Codes:**

| Code | Reason |
|------|--------|
| 204 | Key revoked; no content returned |
| 401 | Session token is missing, invalid, or expired |
| 403 | You are not an organization administrator, the key belongs to another organization, or the key does not exist |

---

## Authentication

### How API Key Authentication Works

1. **Include the header** — Add `Authorization: Bearer <secret>` and `X-Organization-Id: <org-id>` to your request
2. **Server verifies** — The API validates the secret against stored hash using constant-time comparison (prevents timing attacks)
3. **Scopes checked** — If the endpoint requires specific scopes, the server verifies your key has them
4. **Request executes** — If all checks pass, the endpoint runs and your key's `lastUsedAt` is updated
5. **Rate limit applied** — Your request counts toward your API key's rate limit (see [Rate Limiting](#rate-limiting))

### Comparing API Keys and Session Tokens

| Aspect | API Key | Session Token |
|--------|---------|---------------|
| **Use case** | Machine-to-machine integrations | Wallet holders (dashboard, web apps) |
| **Lifetime** | Long-lived (months/years) | Short-lived (hours/days) |
| **Issued by** | Admin creates manually | User authenticates with wallet |
| **Scope control** | Yes, per-key scopes | No, inherits user's organization role |
| **Revocation** | Immediate | Can be rotated/logged out |
| **Rate limits** | Scaled up 3x by default | Standard tier |

---

## Scopes and Permissions

Scopes follow the principle of least privilege: each key should have only the scopes it needs to perform its job.

### Available Scopes

#### PROOF_READ
- **Grants:** Read-only access to proof metadata and verification results
- **Use case:** Services that need to check proof status or history but not create new proofs
- **Endpoints affected:**
  - `GET /api/v1/proofs/:id/verify` (public verification)

#### PROOF_VERIFY
- **Grants:** Permission to verify proofs (query proof validity)
- **Use case:** Verification services, credential checkers, compliance systems
- **Endpoints affected:**
  - `POST /api/v1/proofs/:id/verify` (detailed verification)

#### PAYMENT_READ
- **Grants:** Read-only access to payment history and classification
- **Use case:** Analytics, reporting, audit trails
- **Endpoints affected:**
  - `GET /api/v1/payments` (list payments)
  - `GET /api/v1/payments/:id` (payment detail)

#### PAYMENT_WRITE
- **Grants:** Permission to create and manage payments
- **Use case:** Payment ingestion, manual classification, transaction reconciliation
- **Endpoints affected:**
  - `POST /api/v1/payments` (create payment)
  - `PATCH /api/v1/payments/:id` (update classification)
  - `POST /api/v1/payments/sync` (sync from Stellar)

#### ORG_READ
- **Grants:** Read-only access to organization metadata (members, settings, audit logs)
- **Use case:** Organization management dashboards, compliance exports
- **Endpoints affected:**
  - `GET /api/v1/organizations/:id`
  - `GET /api/v1/organizations/:id/members`
  - `GET /api/v1/organizations/:id/audit-logs`

#### ORG_ADMIN
- **Grants:** Full administrative control (members, settings, key management, webhooks)
- **Use case:** Organization administration tools, provisioning systems
- **Endpoints affected:**
  - All organization endpoints including creation, updates, and deletion

### Scope Enforcement

**Fail-closed default:**

- Endpoints with no scope requirement allow any authenticated key
- Endpoints with scope requirements demand **all** specified scopes
- A key lacking even one required scope receives a **403 Forbidden** response with details of missing scopes

**Example:** If an endpoint requires `[PROOF_VERIFY, PAYMENT_READ]` and your key has only `[PROOF_VERIFY]`, the request is rejected with:

```json
{
  "statusCode": 403,
  "code": "FORBIDDEN",
  "message": "Insufficient scopes. Required: PROOF_VERIFY, PAYMENT_READ. Missing: PAYMENT_READ"
}
```

### Requesting Scopes

When creating or updating a key, specify the scopes array:

```bash
curl -X POST https://api.earnproof.com/api/v1/api-keys \
  -H "Authorization: Bearer <session-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Reporting Service",
    "scopes": ["PROOF_READ", "PAYMENT_READ"],
    "expiresAt": "2027-12-31T23:59:59Z"
  }'
```

### Best Practice: Minimal Scopes

Assign only the scopes your integration actually needs. If your service only verifies proofs, request `["PROOF_VERIFY"]`—not all scopes. This limits damage if the key is compromised.

---

| Scope | Grants |
|---|---|
| `ORG_READ` | Read organization context. Required by `GET /api/v1/integrations/auth-context`. |
| `ORG_ADMIN` | Organization administration and operational visibility. Required by `GET /api/v1/health/diagnostics` and `GET /api/v1/jobs/executions`. |
| `PROOF_READ` | Read proofs belonging to the organization. |
| `PROOF_VERIFY` | Verify proofs and credentials on the organization's behalf. |
| `PAYMENT_READ` | Read indexed payments. |
| `PAYMENT_WRITE` | Create or reclassify payments. |
## Rate Limiting

### How Rate Limits Work

The API enforces rate limits per API key to prevent abuse and ensure fair resource allocation. Limits are applied across all authenticated requests from your key.

### Default Limits

| Tier | Requests | Window |
|------|----------|--------|
| **Anonymous** | 100 | 1 minute |
| **API Key** | 300 | 1 minute |
| **Session Token** | 300 | 1 minute |

**Why API keys get higher limits:** Authenticated machine-to-machine traffic is less of an abuse risk and benefits from higher throughput to support real-time integrations.

### Response Headers

Every API response includes rate limit information:

```http
X-RateLimit-Limit: 300
X-RateLimit-Remaining: 287
X-RateLimit-Reset: 1692903660
```

**Headers:**

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Total requests allowed per window (300 for API keys) |
| `X-RateLimit-Remaining` | Requests you can still make in this window |
| `X-RateLimit-Reset` | Unix timestamp when the window resets |

### Handling Rate Limits

**When you hit the limit (429 Too Many Requests):**

```json
{
  "statusCode": 429,
  "code": "TOO_MANY_REQUESTS",
  "message": "Rate limit exceeded",
  "retryAfter": 45
}
```

**Recommended retry strategy:**

1. **Check `X-RateLimit-Remaining`** — Before each request, check the header to estimate if you'll exceed the limit
2. **Back off exponentially** — On 429, wait using the `Retry-After` header (in seconds) or calculate from `X-RateLimit-Reset`
3. **Queue requests** — For bulk operations, queue requests and spread them over multiple windows
4. **Request higher limits** — If your legitimate use case requires more requests, contact support for a higher tier

**Example retry with exponential backoff (Python):**

```python
import time
import requests

MAX_RETRIES = 5
BASE_DELAY = 1  # seconds

for attempt in range(MAX_RETRIES):
    response = requests.get(
        "https://api.earnproof.com/api/v1/proofs/123/verify",
        headers={
            "Authorization": f"Bearer {api_key}",
            "X-Organization-Id": org_id,
        }
    )
    
    if response.status_code == 429:
        retry_after = int(response.headers.get("Retry-After", BASE_DELAY * (2 ** attempt)))
        print(f"Rate limited. Waiting {retry_after}s...")
        time.sleep(retry_after)
        continue
    
    return response

raise Exception("Max retries exceeded")
```

---

## Security Best Practices

### 🔐 Secret Storage

> **Critical:** Treat API key secrets like passwords. Never hardcode them.

**✅ Do:**

- Store secrets in environment variables (`API_KEY_SECRET`)
- Use a secrets manager (AWS Secrets Manager, HashiCorp Vault, 1Password, etc.)
- Load secrets from `.env` files in development (but never commit the file)
- Rotate secrets on a schedule (at least annually)
- Use separate keys for different services/environments

**❌ Don't:**

- Commit secrets to version control (even private repos)
- Log or print the raw secret anywhere
- Share the secret in Slack, email, or chat
- Use the same key across multiple environments (dev, staging, prod)
- Hardcode secrets in source code

**Example `.env` file (development only, never commit):**

```bash
# .env (added to .gitignore)
EARNPROOF_API_KEY=dGVzdGtleV8w_VlqXyz...
EARNPROOF_ORG_ID=org_12345abc
```

**Example loading from environment:**

```python
import os

api_key = os.environ.get("EARNPROOF_API_KEY")
if not api_key:
    raise ValueError("EARNPROOF_API_KEY environment variable not set")
```

### 🔄 Key Rotation

Rotate keys periodically to limit the window of damage if a secret is compromised.

**Recommended rotation schedule:**

| Scenario | Frequency |
|----------|-----------|
| Routine security policy | Every 90 days |
| High-security environment | Every 30 days |
| Low-risk, stable integration | Every 180 days |
| After suspected compromise | Immediately (revoke old, create new) |

**How to rotate without downtime:**

1. Create a new key with the same scopes
2. Update your integration to use the new secret (test it first)
3. Verify all requests work with the new key
4. Revoke the old key

### 🚨 Incident Response

**If you suspect your API key is compromised:**

1. **Revoke immediately** — Use the `/api/v1/api-keys/:id` DELETE endpoint to revoke the key
2. **Review audit logs** — Check the organization audit log for suspicious activity
3. **Create a new key** — Generate a fresh key and update your integration
4. **Monitor usage** — Watch for unusual activity on your account
5. **Notify support** — If you suspect a broader compromise, contact support

### 🌐 Transport Security

- **Always use HTTPS** — Never send API keys over unencrypted HTTP
- **Verify TLS certificates** — In production, ensure your HTTP client validates certificates
- **No key in URL** — Never include the secret in query parameters or URL paths; use the `Authorization` header instead

### 🔍 Monitoring and Alerts

- **Track `lastUsedAt`** — Periodically check when each key was last used; unused keys indicate potential compromise or retired integrations
- **Alert on unusual patterns** — Set up alerts for keys used outside normal hours or from unexpected IP ranges
- **Audit log review** — Regularly review who created, rotated, or revoked keys
- **Scope escalation** — Alert if a key is suddenly given new scopes

---

## Code Examples

### Python

```python
import requests
import json

# Configuration
API_BASE = "https://api.earnproof.com/api/v1"
API_KEY = "dGVzdGtleV8w_VlqXyz..."  # Load from environment in production
ORG_ID = "org_12345abc"

headers = {
    "Authorization": f"Bearer {API_KEY}",
    "X-Organization-Id": ORG_ID,
}

# Verify a proof
response = requests.post(
    f"{API_BASE}/proofs/proof_xyz/verify",
    headers=headers,
    json={"walletAddress": "GABC123..."}
)

if response.status_code == 200:
    result = response.json()
    print(f"Proof is valid: {result['valid']}")
elif response.status_code == 429:
    retry_after = int(response.headers.get("Retry-After", 60))
    print(f"Rate limited. Retry after {retry_after}s")
else:
    print(f"Error {response.status_code}: {response.text}")
```

### Node.js / TypeScript

```typescript
import axios, { AxiosError } from "axios";

interface ApiKeyResponse {
  statusCode: number;
  message: string;
  [key: string]: unknown;
}

const api = axios.create({
  baseURL: "https://api.earnproof.com/api/v1",
  headers: {
    "Authorization": `Bearer ${process.env.EARNPROOF_API_KEY}`,
    "X-Organization-Id": process.env.EARNPROOF_ORG_ID,
  },
});

async function verifyProof(proofId: string) {
  try {
    const { data } = await api.post<ApiKeyResponse>(`/proofs/${proofId}/verify`);
    console.log("Verification result:", data);
    return data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 429) {
        const retryAfter = error.response.headers["retry-after"];
        console.log(`Rate limited. Wait ${retryAfter}s`);
      } else if (error.response?.status === 403) {
        console.log("Insufficient scopes:", error.response.data.message);
      }
    }
    throw error;
  }
}

verifyProof("proof_xyz");
```

### cURL

```bash
#!/bin/bash

API_BASE="https://api.earnproof.com/api/v1"
API_KEY="dGVzdGtleV8w_VlqXyz..."
ORG_ID="org_12345abc"

# Create a new API key
curl -X POST "$API_BASE/api-keys" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Organization-Id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Integration Name",
    "scopes": ["PROOF_VERIFY", "PAYMENT_READ"],
    "expiresAt": "2027-12-31T23:59:59Z"
  }' \
  -w "\nHTTP Status: %{http_code}\n"

# Verify a proof
curl -X POST "$API_BASE/proofs/proof_xyz/verify" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Organization-Id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{"walletAddress": "GABC123..."}' \
  -H "X-Request-ID: req_$(date +%s)" \
  -w "\nX-RateLimit-Remaining: %{header_x-ratelimit-remaining}\n"
```

---

## Troubleshooting

### "Invalid API key" (401)

**Causes:**

- Secret is malformed or truncated
- Key has been revoked
- Key has expired
- Wrong organization ID provided
- Key was deleted

**Solution:**

1. Verify the secret is complete and uncorrupted
2. Check the key's status with `GET /api/v1/api-keys`
3. Create a new key if the current one is revoked or expired

### "Insufficient scopes" (403)

**Cause:**

- Your key doesn't have one or more scopes the endpoint requires

**Example response:**

```json
{
  "statusCode": 403,
  "message": "Insufficient scopes. Required: PROOF_VERIFY, PAYMENT_READ. Missing: PAYMENT_READ"
}
```

**Solution:**

1. Review which scopes the endpoint needs (check the error message)
2. Create a new key with the required scopes, or
3. Ask your organization admin to rotate the existing key and add scopes

### "Not an organization administrator" (403)

**Cause:**

- Your session token's user does not have admin rights for the organization

**Solution:**

1. Contact your organization admin to create the API key for you
2. Or ask them to promote your user role

### Rate limiting (429 Too Many Requests)

**Cause:**

- You've exceeded the rate limit (300 requests/minute for API keys)

**Solution:**

1. Implement exponential backoff retry logic
2. Check `X-RateLimit-Remaining` before each request
3. Space out bulk requests across multiple minutes
4. Contact support if you have a legitimate need for higher limits

### Key rotation failed silently

**Cause:**

- Network error during rotation (the request didn't complete)

**Solution:**

1. Retry the rotation endpoint
2. List keys to check if rotation succeeded
3. If succeeded, the new secret is in that response (one-time only)
4. If failed, try again

---

## Next Steps

- **Explore the full API** — Visit `/docs` in your EarnProof instance for interactive Swagger documentation
- **Review scopes** — Plan which scopes each of your integrations needs
- **Set up monitoring** — Implement alerts for 403 or 401 errors
- **Test in staging** — Always test API key integrations in a staging environment before production
- **Debug request signing** — Use the [signature diagnostics endpoint](request-signature-diagnostics.md) with synthetic requests

For questions or support, contact the EarnProof team.
