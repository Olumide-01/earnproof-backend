# EarnProof Backend

EarnProof is an open-source, privacy-focused income and payment verification protocol built on Stellar.

This repository contains the NestJS API for wallet authentication, Stellar payment indexing, payment classification, minimum-income proof issuance, public proof verification, proof revocation, optional contract anchoring, and operational health. Issuer management, webhooks, API keys, and audit-log expansion are implemented. API keys are ready for production machine-to-machine integrations.

## Product Role

The backend is the trust and verification service for EarnProof. It should let workers create signed credentials from qualifying Stellar testnet payments while preventing verifiers from seeing full wallet history, unrelated transactions, total balances, or hidden income details.

The first implementation targets Stellar testnet, Freighter wallet authentication, and signed JSON credentials.

## Current Scope

Implemented:

- NestJS application shell
- Versioned `/api/v1` prefix
- Environment validation
- Swagger documentation at `/docs`
- Health endpoint at `/api/v1/health`
- Wallet challenge generation at `/api/v1/auth/challenge`
- Freighter-compatible SEP-53 challenge verification at `/api/v1/auth/verify`
- Bearer-token session lookup and logout endpoints
- Incoming Stellar testnet payment synchronization at `/api/v1/payments/sync`
- Authenticated payment listing, detail lookup, and manual classification
- Minimum-income proof creation at `/api/v1/proofs/minimum-income`
- Public proof verification at `/api/v1/proofs/:id/verify`
- Authenticated proof revocation at `/api/v1/proofs/:id/revoke`
- Deterministic credential canonicalization, hashing, Ed25519 signing, and legacy HMAC verification
- Public credential verification-key discovery with overlap-key rotation support
- AES-256-GCM protection for indexed payment amounts
- Optional Stellar CLI proof commitment anchoring, revocation, and public status checks for deployed proof registry contracts
- PostgreSQL and Redis Docker Compose services
- Prisma lifecycle service
- Prisma schema for core product entities
- Initial database migration
- Seed script for native XLM testnet asset
- Jest tests for auth, token handling, health, Stellar payment mapping, payment sync/classification, and proof issuance/verification states
- PostgreSQL integration test harness that applies every migration to an empty database

Core entities currently modeled:

- Users
- Wallet challenges
- Organizations
- Issuers
- Supported assets
- Payments
- Trusted sources
- Proofs
- Proof claims
- Attestations
- Verification events
- API keys
- Webhooks
- Audit logs

Planned next:

- Issuer management
- Webhooks and API keys
- Database-backed verification event enrichment
- End-to-end API tests with a test database

## Tech Stack

- NestJS
- TypeScript
- PostgreSQL
- Prisma
- Redis
- Stellar JavaScript SDK
- BullMQ, planned for background jobs
- OpenAPI/Swagger
- Jest
- Docker Compose

## Repository Structure

```text
src/
  app.module.ts
  main.ts
  auth/
  config/
  common/
  database/
  health/
  payments/
  proofs/
  stellar/
prisma/
  schema.prisma
  seed.ts
  migrations/
test/
  integration/
    harness/
docs/
```

## Architecture

[`docs/architecture.md`](docs/architecture.md) is the maintained map of the
backend: what each module owns, which dependencies it must not take, how the
critical flows run, and which domain invariants hold. Every invariant links to
the code that enforces it and the test that fails if it stops — the handbook is
checked against the codebase by [`src/docs-links.spec.ts`](src/docs-links.spec.ts),
so a module added without documentation, or a link to a moved file, fails the
build.

[`docs/adr/`](docs/adr/) records the decisions that shaped it, including when a
new ADR is required.

[`docs/webhooks.md`](docs/webhooks.md) is the integrator-facing guide to
verifying signed webhook deliveries, backed by frozen conformance vectors and a
runnable reference receiver (`npm run webhook:conformance`).

[`docs/api-keys-guide.md`](docs/api-keys-guide.md) is the integrator-facing guide
to machine-to-machine authentication: creating a key, the two headers it is
presented with, what each scope grants, rotating without dropping traffic,
revocation, rate limiting, and how to store a secret that is only ever shown
once.

Start there before adding a module, moving a table, or introducing an
unauthenticated endpoint.

## Local Setup

```bash
npm install
cp .env.example .env
docker compose up -d
npm run prisma:generate
npm run prisma:migrate
npm run start:dev
```

Default local API:

```text
http://localhost:4000/api/v1
```

Health check:

```text
GET http://localhost:4000/api/v1/health
```

Swagger docs:

```text
http://localhost:4000/docs
```

## Container Deployment

A production image is defined by [`Dockerfile`](Dockerfile): a multi-stage build
that compiles the application with the full toolchain, installs runtime
dependencies separately with `npm ci --omit=dev`, and ships only `dist/`, the
pruned `node_modules`, and the Prisma schema. It runs as the non-root `node`
user and declares a health check against `/api/v1/health`.

```bash
docker build -t earnproof-api:local .

docker run --rm -p 4000:4000 --env-file production.env earnproof-api:local

curl http://localhost:4000/api/v1/health
```

`production.env` above is an uncommitted file holding the five required secrets
and connection strings; `-e` flags work equally well.

[`docs/deployment.md`](docs/deployment.md) documents every environment variable
and its default, how to run the image against the Compose services, how to apply
migrations from the same artefact, which probe an orchestrator should use, and
the security properties of the image.

Hosted Node services that start with `npm run start` apply pending Prisma
migrations through the npm `prestart` lifecycle before accepting traffic.
Container deployments continue to use a separate pre-deploy migration job.

Note that `docker compose up -d` starts PostgreSQL and Redis for local
development only. It does not build or run the API.

## Environment Variables

```env
NODE_ENV=development
PORT=4000
DATABASE_URL=postgresql://earnproof:earnproof@localhost:5432/earnproof
REDIS_URL=redis://localhost:6379
APP_URL=http://localhost:3000
API_URL=http://localhost:4000
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
SESSION_SECRET=replace_me
CREDENTIAL_SIGNING_SECRET=replace_me
PAYMENT_ENCRYPTION_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=
CONTRACT_ANCHORING_ENABLED=false
CONTRACT_ANCHORING_REQUIRED=false
STELLAR_CLI_PATH=stellar
STELLAR_CLI_SOURCE=
PROOF_REGISTRY_CONTRACT_ID=
EARNPROOF_ISSUER_ADDRESS=
EARNPROOF_SCHEMA_VERSION=1
```

Use strong secrets outside local development. Do not commit `.env`.

Contract anchoring stays disabled unless `CONTRACT_ANCHORING_ENABLED=true` and the Stellar CLI source, proof registry contract ID, and issuer address are configured. Set `CONTRACT_ANCHORING_REQUIRED=true` only when proof creation must fail if on-chain registration fails.

## Validation

```bash
npm run prisma:generate
npm run lint
npm run test
npm run build
npm audit --omit=dev
```

Prisma validation:

```bash
$env:DATABASE_URL='postgresql://earnproof:earnproof@localhost:5432/earnproof'
npx prisma validate
```

## Integration Tests

`npm run test` runs against a mocked Prisma client. The integration suite runs
against a real PostgreSQL server: it applies every migration in
`prisma/migrations` to an empty database and then covers proof
creation/revocation, webhook retry persistence, authentication sessions, payment
uniqueness, transaction commit and rollback, constraint violations, and
concurrent writes.

```bash
npm run test:integration
```

It needs PostgreSQL 17 and a role that can create databases. Docker is not
required.

```sql
-- once, as a superuser
CREATE ROLE earnproof WITH LOGIN PASSWORD 'earnproof' CREATEDB;
```

```bash
TEST_DATABASE_URL=postgresql://earnproof:earnproof@localhost:5432/earnproof_test
```

PowerShell:

```powershell
$env:TEST_DATABASE_URL='postgresql://earnproof:earnproof@localhost:5432/earnproof_test'
npm run test:integration
```

The named database is a naming base, not a target: the harness creates
`earnproof_test_template` and one `earnproof_test_w<worker>` per Jest worker, and
drops them again on teardown. `TEST_DATABASE_URL` is kept separate from
`DATABASE_URL`, and refused unless the name contains `test`, so a development
database can never be the target.

[`docs/request-limits.md`](docs/request-limits.md) documents the largest request
the API accepts at each boundary -- transport, structure, and domain -- and why
each limit is set where it is.
[`docs/development.md`](docs/development.md) documents the local database
tooling: seeding a synthetic scenario, resetting a disposable database, and the
guards that refuse to do either against anything else.

[`docs/integration-testing.md`](docs/integration-testing.md) documents the
isolation model, the startup and teardown deadlines, and the redaction that
keeps connection strings, wallet addresses, protected amounts, and signing
material out of test failures.

## Privacy and Security Requirements

- Do not log raw wallet signatures.
- Do not log exact income values.
- Protect stored payment amounts with `PAYMENT_ENCRYPTION_KEY`.
- Do not expose selected source transactions to verifiers.
- Store API keys as hashes only.
- Store webhook secrets as hashes or encrypted values.
- Hash wallet identifiers in public proof payloads.
- Keep credential signing keys out of source control.
- Treat public verification responses as intentionally disclosed data only.
- Keep backend revocation and public verification aligned with contract status when anchoring is enabled.
- Keep Stellar mainnet disabled until contracts and security posture are reviewed.

## Related Repositories

- `earnproof-frontend`: Public app, worker dashboard, issuer UI, verifier UI, and admin UI.
- `earnproof-contracts`: Soroban issuer registry, proof commitment registry, revocation state, and protocol configuration.
- `earnproof-sdk`: Future TypeScript SDK for integrations.
- `earnproof-specification`: Future credential and verification standard.
