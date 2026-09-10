# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a **Fastify notification service** that queues and asynchronously processes multi-channel notifications (email, SMS, WhatsApp). The API validates requests up front, writes them to Redis, and a background worker processes them with retry logic and deduplication.

## Quick Commands

**Development:**
- `pnpm install` — Install dependencies
- `pnpm dev` — Start API and worker with hot-reload (tsx watch)
- `docker compose up redis` — Start Redis (required)

**Build & Run:**
- `pnpm build` — Compile TypeScript to `dist/`
- `pnpm start` — Run compiled server from `dist/server.js`

**Testing:**
- `pnpm test` — vitest, single run. No Docker or Redis needed: Redis is faked in-process
  (`src/lib/__tests__/redis-fake.ts`)
- `pnpm test:watch` — vitest in watch mode
- `pnpm test:integration` — needs a **real** Redis. Locally:
  `redis-server --port 6399 --daemonize yes` then
  `REDIS_PORT=6399 pnpm test:integration`. In CI, the `redis` service container

## Architecture

### High-Level Flow

1. **API Server** (`src/server.ts`) — Listens on `SERVER_PORT` (default 3000)
   - Registers routes from `src/routes/`
   - Loads secrets for HMAC auth
   - Spawns one background worker process

2. **Request Pipeline** (e.g., `POST /notify`)
   - HMAC signature validation (`src/plugins/request-auth.ts`)
   - Payload validation via Zod schemas
   - Enqueue to Redis

3. **Background Worker** (`src/lib/worker.ts`)
   - Runs in a separate process spawned by server
   - Processes jobs from Redis queues in priority order:
     1. Realtime queue (high priority, short block)
     2. Due retry jobs from retry sorted set
     3. Other queue (normal priority)
   - Retries failed sends with exponential backoff
   - Moves exhausted retries to dead-letter queue

### Redis Queues

Four Redis structures drive the queue model:

```
queue:realtime  → List of high-priority jobs
queue:other     → List of normal-priority jobs
queue:retry     → Sorted set for delayed retries (score = Date.now() + delay, epoch MS)
queue:dlq       → List of dead-letter jobs (max retries exhausted)
```

The worker checks `queue:realtime` first but only blocks briefly, preventing starvation of `queue:other` and due retries.

The retry score is epoch **milliseconds**. `getQueueMetrics()` exposes `retry_oldest` as that
raw epoch-ms timestamp, and `retry_eta_seconds` converted to **seconds** — it previously
returned the raw millisecond difference despite its name, so a 30-second retry read as
`30000` (fixed in #50, with a regression test).

### Request Signing (Authentication)

All API routes require HMAC-SHA256 signed requests with headers:
- `X-NS-Key` — Client identifier
- `X-NS-Timestamp` — Unix timestamp
- `X-NS-Nonce` — Random string (prevents replay)
- `X-NS-Signature` — `v1=<hmac_sha256>` of signed base string

**Signed base string:**
```
METHOD\nPATH\nTIMESTAMP\nNONCE
```

Implementation: `src/lib/auth/secrets.ts` (loads the JSON file named by `INTERNAL_SECRETS_JSON`), `src/plugins/request-auth.ts` (validates).

### Provider System

Providers are extensible implementations for different notification channels (email, SMS, WhatsApp). Each provider exports a `ProviderDefinition` from `src/lib/providers/<name>/index.ts`:

```ts
export const emailProvider: ProviderDefinition = {
  name: 'email',                     // Channel name used in /notify requests
  templates: { welcome: '...' },     // Public template keys → provider IDs
  allowRawTemplateId: false,         // optional; see below
  schema: z.object({ ... }),         // Zod schema for variables
  async send({ to, template_id, variables }) { ... }
};
```

Providers are auto-discovered and registered by `src/lib/providers/index.ts`. To add a provider, create a folder and export the definition (see README for full example).

**`allowRawTemplateId` (raw template-id pass-through).** By default a `template_id`
must name a key in the provider's `templates` map or `/notify` rejects it with a
400. When `allowRawTemplateId: true`, an unknown `template_id` is passed through to
the provider verbatim — treated as a raw provider-side id the caller owns. SMS uses
this (#532/#535): signalstack sends DLT-approved MSG91 flow ids directly, so only
the legacy `login_otp` flow is named in its `templates` map. Email keeps the default
(strict allowlist).

**SMS variables schema.** SMS switched its `schema` to `z.record(z.string(),
z.string())` — an open map of named string variables (the DLT template's
placeholders), rather than a fixed `z.object`. This carries the multi-variable
flow (`name`, `link`, …) through to MSG91 as per-recipient vars.

### Request Deduplication

`/notify` deduplicates by a Redis `SET NX` key with a per-mode TTL (windows are
**not** configurable). Two modes (`src/lib/dedupe_key.ts`, `src/routes/notify.ts`):

- **Explicit `dedupe_id`** — the caller promising "send this once". Used verbatim
  as the key, **1 hour** window. A suppressed repeat is a success with a reason:
  `200 {"enqueued": false, "reason": "duplicate"}`.
- **No `dedupe_id`** — fallback key `channel:to:template_id:<sha256 of the rendered
  payload>` (the `channel:to:template_id` prefix stays in the clear so the key is
  greppable; the digest carries message identity), **5 second** window. A suppressed
  repeat is nobody's intent — a dropped message — so it answers
  `409 {"enqueued": false, "reason": "duplicate-fallback"}` (#88).

Hashing the whole payload is what makes the fallback message-identifying: it used
to key on `channel:to:template_id` alone, which for a generic template like
`basic_email` collapsed to one email per recipient per window regardless of content.
See README for the full request/response contract.

## Key Files

**Routes** (`src/routes/`):
- `docs.ts` — Scalar API reference and OpenAPI JSON
- `notify.ts` — Enqueue notification endpoint
- `providers.ts` — Provider discovery endpoints
- `metrics.ts` — Queue metrics endpoint
- `retry.ts` — Manual DLQ retry endpoint

**Library** (`src/lib/`):
- `queue.ts` — Redis queue and retry helpers
- `worker.ts` — Background job processor loop
- `auth/secrets.ts` — Load signing secrets from the JSON file at `INTERNAL_SECRETS_JSON`
- `providers/` — Provider implementations (auto-loaded)
- `utils/openapi.ts` — OpenAPI document builder
- `utils/provider-docs.ts` — Provider schema/payload serialization

**Other**:
- `types/index.ts` — `NotifyRequest` and `Job`
- `types/provider.ts` — `ProviderDefinition` interface

**Tests** (`src/**/__tests__/`):
- `lib/__tests__/redis-fake.ts` — in-memory ioredis stand-in shared by the suites
- `lib/__tests__/queue.test.ts`, `lib/__tests__/dedupe.test.ts`, `plugins/__tests__/request-auth.test.ts`

## Environment Setup

Create `.env` from `example.env` and fill with provider credentials:

```bash
cp example.env .env
# Edit .env with API keys for providers you enable
```

Required for API operation:
- `SERVER_PORT` (optional, defaults to 3000)
- `INTERNAL_SECRETS_JSON` — **path to a JSON file**, not an inline secret. `loadSecrets()`
  reads it at boot and throws if the variable is unset. Shape:
  `{"jobstack": {"secret": "ns_jobstack_secret-key"}}`

Required for providers (varies by implementation):
- Email transport — **one** of `SMTP_AWS_SES=true` (+ AWS SESv2 credentials),
  `SMTP_HOST` (+ `SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS`), or
  `SMTP_GMAIL=true` (+ `GMAIL_USER`/`GMAIL_PASS`), checked in that order.
  `SMTP_HOST` was added in #112 — before it the only non-SES option was Gmail,
  hardcoded to `smtp.gmail.com:465`. `SMTP_GMAIL` is now a shorthand for exactly
  those settings, and `GMAIL_USER`/`GMAIL_PASS` are honoured as fallbacks for
  `SMTP_USER`/`SMTP_PASS` on every transport so existing values files keep
  working. Resolution lives in `src/lib/providers/email/sendMailCore.ts`; the
  README table is the operator-facing version.
- `MSG91_AUTH_KEY` for SMS (MSG91 Flow API)
- `SMS_LOGIN_OTP_TEMPLATE_ID` — MSG91 flow id for the legacy `login_otp` template.
  Read in `src/lib/providers/sms/msg91.ts`; optional, with a back-compat default of
  the previously-hardcoded id. Per-event DLT flow ids are sent raw and need no env
  (see `allowRawTemplateId`). Note: `MSG91_TEMPLATE_ID` in `example.env` is unused —
  the code never reads it; use `SMS_LOGIN_OTP_TEMPLATE_ID` instead.
- Twilio credentials for WhatsApp
- etc.

## TypeScript Configuration

TypeScript **7**, which removed `moduleResolution: node10`, `baseUrl`, and non-relative
`paths` values — the old config used all three, so `pnpm build` failed outright until it
was fixed (#46).

- **Target:** ES2020. **`module`/`moduleResolution`: `Node16`** — emitted output is still
  CommonJS, because `package.json` has no `"type": "module"`.
- **Why `Node16` matters:** it models the CommonJS/ESM boundary, so importing an ESM-only
  package from this CommonJS code is a **compile error** (`TS1479`) rather than a runtime
  `ERR_REQUIRE_ESM`. That is how the `uuid` bug was caught — `uuid@14` is ESM-only with no
  `require` condition, and `job_id` generation now uses `randomUUID` from `node:crypto`
  instead. Keep this setting; do not "simplify" it back to `moduleResolution: Node`.
- **Path alias:** `src/*` → `./src/*`, declared without `baseUrl` (removed in TS 7). The
  alias is load-bearing — `lib/worker.ts`, `lib/queue.ts` and `lib/providers/sms/gupshup.ts`
  import through it.
- **Type roots:** `./node_modules/@types` only. There is no `src/types/fastify.d.ts` in this
  repo; `typeRoots` takes directories, and the old entry pointed at a file that never existed.
- **Tests are excluded from the build** (`**/*.test.ts`, `src/**/__tests__/**`). They sit
  beside the code under `src/`, so without that they compile into `dist/` and ship in the
  image. `pnpm test` is what checks them.
- **Linting:** `noUnusedLocals` and `noUnusedParameters` enabled (must fix before build)

## Testing Notes

vitest 3, 33 tests across `queue` (17), `request-auth` (11) and `dedupe` (5). The whole suite
runs in ~200ms because Redis is a **fake**, not a container.

`src/lib/__tests__/redis-fake.ts` implements only the commands this service uses, with
ioredis's exact return shapes — the ones easy to get wrong: `set(..., 'NX')` → `'OK' | null`,
`brpop` → `[key, value] | null`, `multi().exec()` → `[err, result]` pairs. Inject it with
`vi.mock('../redis', ...)`; the module under test and the test share one instance, so
assertions can read the state the code wrote.

**ioredis 6 `zrange` typing.** ioredis 6 types `zrange`'s `stop` as `string | Buffer` (not
`number`), so `getQueueMetrics` passes **string** indices (`zrange(key, '0', '0', 'WITHSCORES')`)
and the fake coerces its index args with `Number()`. If you add a `zrange`/`zrangebyscore`
call, pass string indices to satisfy the v6 overloads.

`worker.test.ts` covers `processJob`: provider/template routing, attempt counting, the full
backoff ladder (5s → 10 → 20 → 40) and DLQ-on-exhaustion. It mocks `../queue` (these tests are
about which queue call is made, not Redis behaviour) and must mock `../providers`, which
auto-discovers by `require`-ing each `index.js` and so is not importable from source.

`queue.integration.test.ts` runs against a **real** Redis via `pnpm test:integration`, covering
the one thing a fake cannot: that `popScheduledRetries` claims atomically. Against the old
two-round-trip implementation, eight concurrent claimers returned **400 claims for 50 jobs** —
every retry sent eight times.

**Deliberately not covered yet:**
- `mainLoop`'s priority ordering (realtime → due retries → other) — it is an infinite loop.
- Provider implementations (real SES/Twilio calls).

## Known Issues

Two design problems found while writing the tests, both filed rather than fixed:

- **#51 — `popScheduledRetries` is not atomic.** It does `zrangebyscore` then
  `zremrangebyscore` in two round trips, deleting by *score range* rather than by the members
  read, despite a comment claiming atomicity. A retry written between the two calls is deleted
  without being returned (silent job loss, no concurrency required), and two workers can both
  return the same jobs.
- **#52 — the nonce is claimed before the signature is verified.** A client with a bad
  signature gets `Invalid signature` first and `Replay detected` on every retry with the same
  nonce, and anyone who knows a key id (it is not secret) can write nonce keys unauthenticated.

## CI

Two workflows:

- **`ci.yaml`** — `pull_request` and `push` on `main`/`develop`/`feature`: frozen install,
  `pnpm build` (which is `tsc`, so it is the type-check too), then `pnpm test`. Added in #46;
  before that this repo had **no CI at all**, which is how a tsconfig incompatible with
  TypeScript 7 reached `main` and broke image publishing for a week.
- **`notification-image-build.yaml`** — builds and pushes the GHCR image on push to `main`,
  push to `feature`, and tags; **builds without pushing** on PRs that touch the image inputs.
  Note the branch list says `feature`, not `'feature/**'`: the glob needs a slash, so it never
  matched the integration branch.

**Two Docker gotchas**, both of which broke the image build in ways CI did not see:

1. The Dockerfile must `COPY pnpm-workspace.yaml` alongside `package.json` and
   `pnpm-lock.yaml`. That file holds the pnpm `overrides` (pnpm 10 no longer reads them from
   `package.json`), and `--frozen-lockfile` compares that config against the lockfile — omit
   it and the build fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`.
2. The global pnpm must be installed at the **exact** version in `packageManager`, which the
   Dockerfile reads out of `package.json` with `sed` so the two cannot drift. A bare
   `npm install -g pnpm` takes whatever is latest: once pnpm 11 shipped, that newer pnpm
   honoured `packageManager: pnpm@10.x`, tried to self-provision it, and failed with
   `Cannot verify the identity of the @pnpm/exe.linux-x64 native binary: it is missing from
   pnpm-lock.yaml` — a build break with no change on our side.

## Common Patterns

**Adding a route:**
1. Create handler in `src/routes/myroute.ts`
2. Export a Fastify plugin function
3. Register in `src/app.ts` with `app.register(myRoutes)`

**Adding a provider:**
1. Create `src/lib/providers/<name>/` folder
2. Export `ProviderDefinition` from `index.ts`
3. Auto-discovered on startup

**Queue operations:**
Import helpers from `src/lib/queue.ts`:
- `enqueueNotification()` — Push to queue
- `processJob()` — Dequeue and send
- `retryJob()` — Move to retry sorted set
- `moveToDeadLetter()` — Move to DLQ

## Deployment Notes

- **Worker process:** One worker is spawned alongside the API server in the same Node process. For scale, spawn separate worker processes pointing to the same Redis instance.
- **Redis requirement:** Redis 6+ (uses sorted sets for retries, lists for queues).
- **Stateless API:** The server itself is stateless; all state is in Redis. Multiple API instances can run behind a load balancer.
- **Docker:** `Dockerfile` and `docker-compose.yaml` included. Compose also starts Redis service.
- **Node 24** — `dhi.io/node:24-alpine-dev` for the build/prod-deps stages and
  `dhi.io/node:24-alpine` for the runtime (three stages, not two — the runtime has
  no shell, so the production install happens in `prod-deps` and is copied in),
  `node-version: 24` in CI, and
  `engines.node: ">=24"` in `package.json`. Keep all three in step; `@types/node` is pinned to
  the matching major (`^24`) on purpose, since types ahead of the runtime let code compile
  against APIs that do not exist where it runs.
- **Dependency overrides** live in `pnpm-workspace.yaml`, not the `pnpm` field of
  `package.json` (pnpm 10 stopped reading that and only warns). The file is present solely as
  pnpm's settings home — this is not a workspace.
