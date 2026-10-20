# Docker Build Verification Guide

This document provides step-by-step instructions to verify the production Dockerfile meets all requirements for Issue #90.

## Prerequisites

- Docker Engine (any recent version with multi-stage build support)
- PostgreSQL running locally or accessible (for runtime health checks)
- Redis running locally or accessible (for runtime configuration validation)
- Node 20.11.1 (optional, for verifying `.nvmrc` alignment)

## Verification Steps

### 1. Build the Image

```bash
docker build -t earnproof-api:test .
```

**Expected output:**
- Three distinct stages execute in sequence: `build`, `production-deps`, `runtime`
- No errors during build
- Prisma client generates successfully in build stage
- TypeScript compiles without errors
- Production dependencies installed with `npm ci --omit=dev`

**Verification:**
- Command completes with exit code 0
- Final image is named `earnproof-api:test`

### 2. Verify Image Contents

```bash
# Check that node_modules exists but is production-only
docker run --rm earnproof-api:test ls -la /app/node_modules | head -20

# Verify dist/ exists (compiled application)
docker run --rm earnproof-api:test ls -la /app/dist | head -20

# Verify prisma schema is present
docker run --rm earnproof-api:test ls -la /app/prisma/

# Verify package.json exists (required by Node and Prisma)
docker run --rm earnproof-api:test cat /app/package.json | head -10

# Verify application is non-root
docker run --rm earnproof-api:test id
# Expected: uid=1000(node) gid=1000(node) groups=1000(node)
```

### 3. Verify Image Size

```bash
docker images earnproof-api:test --format "{{.Repository}}:{{.Tag}} → {{.Size}}"
```

**Expected:** Image should be minimal (typically 200-400MB depending on dependencies):
- Production dependencies only (no TypeScript, Jest, ESLint, etc.)
- No source code (only compiled `dist/`)
- Only one native dependency installed: `openssl`

### 4. Run Container Against Local Services

Prerequisite: Start local services:
```bash
docker compose up -d postgres redis
```

Then run the image:
```bash
docker run --rm -p 4000:4000 \
  -e NODE_ENV=development \
  -e DATABASE_URL='postgresql://earnproof:earnproof@host.docker.internal:5432/earnproof' \
  -e REDIS_URL='redis://host.docker.internal:6379' \
  -e SESSION_SECRET='test_secret_12345' \
  -e CREDENTIAL_SIGNING_SECRET='test_secret_12345' \
  -e PAYMENT_ENCRYPTION_KEY='MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=' \
  earnproof-api:test
```

On Linux, replace `host.docker.internal` with `host-gateway` in `--add-host`:
```bash
docker run --rm -p 4000:4000 \
  --add-host=host.docker.internal:host-gateway \
  ... (rest of env vars as above)
```

**Expected behavior:**
- Container starts without errors
- Logs show configuration validation succeeded
- Application listens on port 4000
- Database connection succeeds (or gracefully reports connection error if DB is down)

### 5. Verify Health Check Endpoint

In another terminal, while the container is running:

```bash
curl http://localhost:4000/api/v1/health
```

**Expected response (200 OK):**
```json
{
  "status": "ok",
  "service": "earnproof-api",
  "database": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

If database is unavailable:
```bash
curl -i http://localhost:4000/api/v1/health
# Expected: HTTP/1.1 503 Service Unavailable
```

### 6. Verify Docker HEALTHCHECK

While the container is running, in another terminal:

```bash
# Poll the container's health status
docker inspect --format='{{.State.Health.Status}}' <container-id>

# For detailed health status
docker inspect <container-id> | grep -A 15 '"Health"'
```

**Expected:**
- Status transitions from `starting` → `healthy` within 20 seconds
- After 3 minutes, status should stabilize as `healthy`
- If database becomes unreachable, status should transition to `unhealthy` after 3 consecutive failures (3 × 30s = ~90 seconds)

### 7. Verify Graceful Shutdown

While container is running:

```bash
docker stop <container-id>
```

**Expected behavior:**
- Container receives SIGTERM
- Application logs show graceful shutdown beginning
- Readiness flips to "not_ready" (new requests rejected)
- In-flight requests drain
- Container exits cleanly within ~10 seconds (shorter than termination grace period)

### 8. Verify Non-Root User

```bash
docker run --rm earnproof-api:test whoami
# Expected: node

docker run --rm earnproof-api:test id
# Expected: uid=1000(node) gid=1000(node) groups=1000(node)
```

### 9. Verify Minimal Attack Surface

```bash
# Verify no shell is present
docker run --rm earnproof-api:test /bin/sh 2>&1
# Expected: /bin/sh: not found (or similar)

# Verify curl/wget are not present
docker run --rm earnproof-api:test which curl
# Expected: not found

docker run --rm earnproof-api:test which wget
# Expected: not found

# Verify no build tools present
docker run --rm earnproof-api:test which gcc
# Expected: not found

docker run --rm earnproof-api:test which python
# Expected: not found
```

### 10. Verify Entry Point

```bash
docker inspect earnproof-api:test | grep -A 5 '"Cmd"'
# Expected: "Cmd": ["node", "dist/main.js"]

docker inspect earnproof-api:test | grep -A 5 '"Entrypoint"'
# Expected: null or empty (uses CMD only)
```

The exec form `CMD ["node", "dist/main.js"]` ensures Node runs as PID 1 and receives signals directly.

### 11. Test Read-Only Filesystem

```bash
docker run --rm --read-only --tmpfs /tmp \
  -e NODE_ENV=development \
  -e DATABASE_URL='postgresql://earnproof:earnproof@host.docker.internal:5432/earnproof' \
  -e REDIS_URL='redis://host.docker.internal:6379' \
  -e SESSION_SECRET='test_secret_12345' \
  -e CREDENTIAL_SIGNING_SECRET='test_secret_12345' \
  -e PAYMENT_ENCRYPTION_KEY='MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=' \
  earnproof-api:test
```

**Expected:** Container starts and functions normally with read-only filesystem (application writes only to `/tmp` if needed).

## Security Checklist

- [ ] Image runs as non-root user (`node:node`)
- [ ] Only `openssl` native dependency installed (no build tools)
- [ ] No source code in image (only compiled `dist/`)
- [ ] No dev dependencies in image (`npm ci --omit=dev`)
- [ ] `.env` files excluded from build context (`.dockerignore`)
- [ ] Base image pinned to specific version (`node:20.11.1-alpine3.19`)
- [ ] HEALTHCHECK configured with appropriate intervals and timeouts
- [ ] No shell or standard utilities (curl, wget, gcc, python)
- [ ] Entry point is exec form (ensures PID 1 for signal handling)
- [ ] Can run with `--read-only --tmpfs /tmp`

## Size Optimization Checklist

- [ ] `npm ci --omit=dev` removes ~2/3 of node_modules
- [ ] TypeScript source excluded (only `dist/` compiled code)
- [ ] Test files excluded (`.dockerignore`)
- [ ] Documentation excluded (`.dockerignore`)
- [ ] Only essential files copied: `dist/`, `node_modules/`, `prisma/`, `package.json`
- [ ] Cache layers optimized: manifests copied first, source code later

## Expected Test Results

**Build test:**
- ✓ `docker build .` completes without errors
- ✓ Image successfully tagged as `earnproof-api:test`
- ✓ All three stages complete: build, production-deps, runtime

**Runtime test:**
- ✓ Container starts with required environment variables
- ✓ Application listens on configured PORT (default 4000)
- ✓ Health check endpoint responds with `200 OK` when database is available
- ✓ Health check endpoint responds with `503 Service Unavailable` when database is unavailable
- ✓ Docker HEALTHCHECK transitions to `healthy` within start-period
- ✓ Application shuts down gracefully on SIGTERM
- ✓ Container health status becomes `unhealthy` if dependencies become unreachable

**Security test:**
- ✓ Application runs as non-root user
- ✓ No build tools or shells present in image
- ✓ No source code or test files present
- ✓ Filesytem can be read-only (except /tmp)

## Troubleshooting

### Build fails: "prisma generate" fails
**Cause:** Missing `openssl` in build stage
**Solution:** Already included in Dockerfile; ensure `apk add --no-cache openssl` runs in build stage

### Build fails: "nest build" fails
**Cause:** TypeScript compilation errors
**Solution:** Verify `npm run build` passes locally: `npm run build`

### Container fails to start: Configuration validation fails
**Cause:** Missing or invalid environment variable
**Solution:** Check logs with `docker logs <container-id>`, verify all required vars are set

### Health check fails
**Cause:** Database unreachable
**Solution:** Verify database connection string is correct and database is running

### Container is very large (>500MB)
**Cause:** Dev dependencies not stripped
**Solution:** Verify production-deps stage uses `npm ci --omit=dev`

## Related Documentation

- [`Dockerfile`](./Dockerfile) — Multi-stage build definition
- [`docs/deployment.md`](./docs/deployment.md) — Full deployment guide
- [`docs/health-checks.md`](./docs/health-checks.md) — Health probe documentation
- [`docs/shutdown.md`](./docs/shutdown.md) — Graceful shutdown runbook
- [`.dockerignore`](./.dockerignore) — Build context exclusions

