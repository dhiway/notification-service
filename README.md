# Notification Service

A Fastify notification service for queueing provider-agnostic email, SMS, and
WhatsApp messages. Requests are validated up front, written to Redis, and then
processed asynchronously by a worker.

## What It Does

- Accepts notifications through one `POST /notify` API.
- Supports provider-specific templates and variable schemas.
- Exposes provider metadata with complete request payload examples.
- Uses Redis lists for realtime and lower-priority work.
- Uses a Redis sorted set for delayed retries.
- Deduplicates repeated requests for a short window.
- Sends failed jobs to a dead-letter queue after retry exhaustion.
- Serves Scalar API docs at `/`.

## Project Layout

```text
src/
├─ app.ts                    # Fastify app bootstrap and route registration
├─ server.ts                 # API startup and worker spawn
├─ routes/
│  ├─ docs.ts                # Scalar docs and OpenAPI JSON
│  ├─ metrics.ts             # Queue metrics route
│  ├─ notify.ts              # Notification enqueue route
│  ├─ providers.ts           # Provider discovery routes
│  └─ retry.ts               # Manual failed-job retry route
├─ lib/
│  ├─ queue.ts               # Redis queues, retries, DLQ helpers
│  ├─ worker.ts              # Background job processor
│  ├─ utils/
│  │  ├─ openapi.ts          # OpenAPI document builder
│  │  └─ provider-docs.ts    # Provider payload/schema serialization
│  └─ providers/             # Provider implementations
└─ plugins/
   └─ request-auth.ts        # HMAC request signing guard
```

## Local Requirements

- Node.js 24+
- pnpm
- Redis 6+
- Provider credentials for the providers you enable

## Setup

```bash
pnpm install
cp example.env .env
```

Fill `.env` with the credentials required by the provider implementations.

Start Redis:

```bash
docker compose up redis
```

Start the API and worker:

```bash
pnpm dev
```

The API listens on `SERVER_PORT` or `3000` by default. `src/server.ts` also
spawns one background worker process.

## Mail Transport

`channel=email` picks its transport from the environment, in this order. The
first match wins and nothing else is consulted:

| Set this | Transport |
| --- | --- |
| `SMTP_AWS_SES=true` | AWS SESv2 API (`AWS_REGION` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`) |
| `SMTP_HOST=<host>` | That SMTP server — Zoho, Mailgun, a self-hosted relay, an SES SMTP endpoint |
| `SMTP_GMAIL=true` | Legacy shorthand for `SMTP_HOST=smtp.gmail.com SMTP_PORT=465 SMTP_SECURE=true` |

Nothing set is a startup-time misconfiguration that only surfaces on the first
send, so the error names all three.

SMTP connection variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `SMTP_HOST` | — | Selects the generic transport. Overrides `SMTP_GMAIL`. |
| `SMTP_PORT` | `587` | `465` under the `SMTP_GMAIL` shorthand. |
| `SMTP_SECURE` | `true` on port 465, else `false` | Implicit TLS from the first byte. On 587 the session opens plaintext and nodemailer upgrades it with STARTTLS, so `false` there is correct, not insecure. |
| `SMTP_USER` | falls back to `GMAIL_USER` | |
| `SMTP_PASS` | falls back to `GMAIL_PASS` | Omitted entirely when either half is missing, for an unauthenticated relay. |
| `SMTP_FROM` | — | Fixed envelope sender; see below. |

**Which address mail is sent from.** Normally the caller's `variables.fromEmail`
is used as-is. Two exceptions:

- `SMTP_FROM`, when set, replaces it for every message. Use this with a relay
  that only accepts one sender identity.
- Gmail replaces it with the authenticated account, because Gmail rewrites or
  rejects a `From` that is not the mailbox that authenticated. Other providers
  do not have that constraint, and their SMTP username is frequently not a
  mailbox at all (`postmaster@mg.example`, an SES `AKIA…` key id) — putting it
  in the `From` header would be wrong, so they keep the caller's address.

**Legacy names.** `SMTP_GMAIL`, `GMAIL_USER` and `GMAIL_PASS` are what this
service read before `SMTP_HOST` existed. They still work — `GMAIL_USER` /
`GMAIL_PASS` are honoured as a fallback on *any* transport, not just Gmail — so
a deployment that ships only those keeps authenticating unchanged. Don't set
them in a new one: use `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`,
`SMTP_SECURE=true` and the `SMTP_USER` / `SMTP_PASS` pair instead.

## Testing

```bash
pnpm test              # unit suite (vitest) — no Docker/Redis; Redis is faked in-process
pnpm test:integration  # integration suite — needs a real Redis
                       # e.g. redis-server --port 6399 --daemonize yes; REDIS_PORT=6399 pnpm test:integration
```

CI (`ci.yaml`) runs a frozen install, `pnpm build` (which is `tsc`, so also the
type-check), then `pnpm test` on every PR/push; the GHCR image build + Trivy scan
run on `main`/`feature`/tags. See `CLAUDE.md` for the in-memory fake's contract
and what each suite covers.

## API Docs

Open the Scalar reference:

```text
GET /
```

The OpenAPI document used by Scalar is available at:

```text
GET /openapi.json
```

## Endpoint Summary

Every endpoint below requires signed auth headers.

```text
GET  /                    # Scalar API reference HTML
GET  /openapi.json        # OpenAPI document
POST /notify              # Enqueue a notification
GET  /providers           # List providers and complete payload examples
GET  /providers/:name     # Find one provider by name
GET  /metrics/queue       # Queue depths and retry/DLQ metrics
POST /failed/retry        # Requeue jobs from the DLQ
```

## Queue Model

The service uses four Redis structures:

```text
queue:realtime  # high-priority jobs
queue:other     # normal/lower-priority jobs
queue:retry     # delayed retry sorted set
queue:dlq       # dead-letter queue
```

Workers check `queue:realtime` first, but only block for a short window. That
prevents `queue:other` and due retries from being starved when no realtime jobs
are arriving.

Processing order inside the worker loop:

1. Try one realtime job.
2. Process any due retry jobs.
3. Try one normal `other` job.
4. Sleep briefly when no work is available.

Failed sends are retried with exponential backoff. After the maximum retry
count, the job is written to `queue:dlq`.

## Authentication

All API routes are protected by request signing. The request must include:

```text
X-NS-Key
X-NS-Timestamp
X-NS-Nonce
X-NS-Signature
```

The signature format is:

```text
v1=<hmac_sha256>
```

The signed base string is:

```text
METHOD
PATH
TIMESTAMP
NONCE
```

`PATH` must match the request URL path exactly as sent to Fastify. Include the
query string if the request has one.

Example secret configuration:

```json
{
  "jobstack": {
    "secret": "ns_jobstack_secret-key"
  }
}
```

## Queue A Notification

```text
POST /notify
```

Request body:

```json
{
  "channel": "email",
  "template_id": "basic_email",
  "to": "user@example.com",
  "priority": "realtime",
  "variables": {
    "fromName": "Notification Service",
    "fromEmail": "no-reply@example.com",
    "subject": "Welcome",
    "html": "<h1>Hello</h1>",
    "replyTo": "support@example.com"
  },
  "dedupe_id": "optional-client-id"
}
```

Fields:

- `channel`: provider name, such as `email`, `sms`, or `whatsapp`.
- `template_id`: a public template key from the provider metadata, or — for
  providers that accept raw provider-side ids (SMS; see "SMS Templates &
  Variables" below) — a provider template id passed through verbatim.
- `to`: recipient address or phone number.
- `priority`: optional, either `realtime` or `other`; defaults to `other`.
- `variables`: provider-specific variables validated by that provider schema.
- `dedupe_id`: optional dedupe key, and the recommended one. Supplying it means
  "send this message once": it is used verbatim, with a **1 hour** window, and a
  suppressed repeat answers `200` with `reason: duplicate`. Without it the service
  falls back to `channel:to:template_id:<sha256 of the rendered payload>` with a
  **5 second** window, and a suppressed repeat answers `409`. The hash covers
  `variables`, so the fallback only ever collapses a byte-identical resend — it
  used to key on `channel:to:template_id` alone, which for a generic template such
  as `basic_email` meant one email per recipient per window regardless of content.

Response:

```json
{
  "job_id": "uuid",
  "enqueued": true
}
```

### Email Attachments

`channel=email` accepts an optional `variables.attachments` array:

```json
{
  "variables": {
    "fromName": "Signals Support",
    "fromEmail": "no-reply@example.com",
    "subject": "Complaint from Asha",
    "html": "<p>details</p>",
    "attachments": [
      { "filename": "evidence.png", "contentType": "image/png", "data": "<base64>" }
    ]
  }
}
```

`data` is base64 with no `data:` prefix. Two limits apply, both env-configurable:
`NOTIFY_ATTACHMENT_MAX_FILES` (default 3) and
`NOTIFY_ATTACHMENT_MAX_TOTAL_BYTES` (default 5 MB, decoded). Over either bound
the request is rejected with a 400 rather than enqueued. The HTTP `bodyLimit` on
**this route only** (every other route keeps Fastify's 1 MB default) is derived
from the byte budget (base64 inflates payloads by 4/3, plus envelope
headroom), so raising the cap does not need a second config change;
`NOTIFY_BODY_LIMIT_BYTES` overrides it if you need to.

Operational notes:

- The relay does **not** restrict content types — that is the calling product's
  policy. It enforces only count and size, which are its own resource limits.
- **This is an outbound-content capability, not just a size change.** Any caller
  holding a valid internal key can now emit arbitrary file bytes from the
  organisation's sending identity (SES domain or Gmail account), under whatever
  filename it chooses. Nothing here inspects those bytes. Two consequences worth
  planning for: a caller's own type policy is the only filter, so treat internal
  keys as capable of sending attachments on the org's behalf; and recipient
  mailboxes must have attachment scanning enabled, since a mislabelled file
  reaches them intact.
- An attachment-bearing job is JSON-serialised into the Redis queue like any
  other, so a 5 MB attachment occupies roughly 6.7 MB of Redis (base64) from
  enqueue until delivery — and stays there in the retry ZSET or DLQ if delivery
  keeps failing. Size Redis accordingly if attachment traffic is expected to be
  heavy.
- `MAIL_LOG=true` logs attachment filenames, content types and encoded sizes,
  never the content itself.
- Transport ceilings still apply on top of these limits: SES caps a message at
  10 MB **after** base64 inflation, so ~7 MB of original file is the practical
  maximum regardless of configuration.

If the request is a duplicate inside the dedupe window, **nothing is sent** — and
the two cases are answered differently, because only one of them is intentional:

```text
POST /notify  with dedupe_id  ->  200  {"job_id":"uuid","enqueued":false,"reason":"duplicate"}
POST /notify  without         ->  409  {"job_id":"uuid","enqueued":false,"reason":"duplicate-fallback"}
```

The caller asked for suppression in the first case, so it is not an error. In the
second nobody did, so it is a dropped message and the status code says so — a
client that checks only `res.ok` would otherwise read it as a delivery. Either way
the service logs a warning carrying the dedupe key.

## Provider Discovery

List all providers:

```text
GET /providers
```

This route requires signed auth headers.

Find one provider by name:

```text
GET /providers/email
GET /providers/sms
GET /providers/whatsapp
```

These routes require signed auth headers.

Provider responses include:

- `name`: provider channel name used in `/notify`.
- `templates`: public template keys mapped to provider template identifiers.
- `template_payloads`: complete `/notify` payload examples per template.
- `variables_schema`: JSON Schema for the `variables` object.
- `notify_payload`: generic complete `/notify` payload shape for the provider.

Example shape:

```json
{
  "name": "sms",
  "templates": {
    "login_otp": "6896c26d6eb66c66340e1242"
  },
  "template_payloads": [
    {
      "template_id": "login_otp",
      "provider_template_id": "6896c26d6eb66c66340e1242",
      "payload": {
        "channel": "sms",
        "template_id": "login_otp",
        "to": "+918888888888",
        "priority": "other",
        "variables": {
          "message": "string"
        }
      }
    }
  ],
  "variables_schema": {
    "type": "object"
  },
  "notify_payload": {
    "channel": "sms",
    "template_id": "<template_id>",
    "to": "+918888888888",
    "priority": "other",
    "variables": {
      "message": "string"
    }
  }
}
```

## Request Examples

Email:

```json
{
  "channel": "email",
  "template_id": "basic_email",
  "to": "user@example.com",
  "priority": "realtime",
  "variables": {
    "fromName": "Notification Service",
    "fromEmail": "no-reply@example.com",
    "subject": "Welcome",
    "html": "<h1>Hello</h1>",
    "replyTo": "support@example.com"
  }
}
```

SMS:

```json
{
  "channel": "sms",
  "template_id": "login_otp",
  "to": "+918888888888",
  "variables": {
    "message": "Your OTP is 987654"
  }
}
```

### SMS Templates & Variables

SMS is delivered through the MSG91 Flow API and accepts **raw provider-side
template ids** (#86/#532/#535). Two ways to pass `template_id`:

- **Named template** — `login_otp` is the one key in the SMS provider metadata. Its
  MSG91 flow id comes from `SMS_LOGIN_OTP_TEMPLATE_ID` (a built-in default applies
  if unset), so it is deployment-specific per MSG91 account.
- **Raw DLT flow id** — any other `template_id` is passed through verbatim to MSG91
  (the SMS provider sets `allowRawTemplateId`). Signalstack sends its per-event
  DLT-approved flow ids directly this way; they need no entry in the templates map.

`variables` is an open map of named string values
(`z.record(z.string(), z.string())`) — the DLT template's placeholders. Each key is
spread as an MSG91 recipient variable, so a multi-variable flow is sent as, e.g.,
`{ "name": "Asha", "link": "https://…" }`. Two rules:

- **Legacy back-compat:** a lone `{ "message": "…" }` is mapped to MSG91's `##var##`
  placeholder, so existing single-variable OTP callers are byte-for-byte unchanged.
- A caller variable named `mobiles` can never override the resolved recipient phone.

WhatsApp:

```json
{
  "channel": "whatsapp",
  "template_id": "dialflow",
  "to": "+918888888888",
  "variables": {
    "contentSid": null,
    "contentVariables": {}
  }
}
```

## Queue Metrics

```text
GET /metrics/queue
```

This route requires signed auth headers.

Example response:

```json
{
  "status": "ok",
  "timestamp": 1765363200000,
  "queues": {
    "realtime": 0,
    "other": 0,
    "retry_count": 0,
    "retry_oldest": null,
    "retry_eta_seconds": null,
    "dlq": 0
  }
}
```

## Manually Retry Failed Jobs

Failed jobs in `queue:dlq` can be requeued manually:

```text
POST /failed/retry
```

This route requires signed auth headers.

Retry one failed job by `job_id`:

```json
{
  "job_id": "uuid",
  "priority": "other"
}
```

Retry a batch of failed jobs:

```json
{
  "limit": 10,
  "priority": "realtime"
}
```

Fields:

- `job_id`: optional. When present, only that DLQ job is retried.
- `limit`: optional batch size when `job_id` is omitted. Defaults to `1`, max
  `100`.
- `priority`: optional destination queue, either `realtime` or `other`. Defaults
  to `other`.

Manual retry resets the job attempt count to `0` and moves the job from
`queue:dlq` back into the selected queue.

When `job_id` is provided and the job is not present in `queue:dlq`, the API
returns `404`. When retrying a batch, malformed DLQ entries are counted as
`skipped`.

Response:

```json
{
  "retried": ["uuid"],
  "retried_count": 1,
  "skipped": 0,
  "not_found": []
}
```

## Signed cURL Example

```bash
KEY_ID="jobstack"
SECRET="ns_jobstack_secret-key"

METHOD="POST"
PATH="/notify"
TIMESTAMP=$(date +%s)
NONCE=$(openssl rand -hex 16)

BASE_STRING="$METHOD
$PATH
$TIMESTAMP
$NONCE"

SIGNATURE="v1=$(printf "%s" "$BASE_STRING" | \
  openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

curl -X POST http://localhost:3000/notify \
  -H "Content-Type: application/json" \
  -H "X-NS-Key: $KEY_ID" \
  -H "X-NS-Timestamp: $TIMESTAMP" \
  -H "X-NS-Nonce: $NONCE" \
  -H "X-NS-Signature: $SIGNATURE" \
  -d '{
    "channel": "email",
    "to": "test@example.com",
    "template_id": "basic_email",
    "priority": "realtime",
    "variables": {
      "fromName": "Notification Service",
      "fromEmail": "no-reply@example.com",
      "subject": "Hello",
      "html": "<h1>Hello World</h1>"
    }
  }'
```

For signed GET requests, use the same signing process with the target method and
path. Example for provider discovery:

```bash
METHOD="GET"
PATH="/providers"
TIMESTAMP=$(date +%s)
NONCE=$(openssl rand -hex 16)

BASE_STRING="$METHOD
$PATH
$TIMESTAMP
$NONCE"

SIGNATURE="v1=$(printf "%s" "$BASE_STRING" | \
  openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

curl http://localhost:3000/providers \
  -H "X-NS-Key: $KEY_ID" \
  -H "X-NS-Timestamp: $TIMESTAMP" \
  -H "X-NS-Nonce: $NONCE" \
  -H "X-NS-Signature: $SIGNATURE"
```

## Adding A Provider

Create a provider folder:

```text
src/lib/providers/push/
```

Add an index file:

```ts
export { pushProvider } from './push';
```

Implement the provider:

```ts
import { z } from 'zod';
import { ProviderDefinition } from '../../../types/provider';

export const pushProvider: ProviderDefinition = {
  name: 'push',

  templates: {
    welcome: 'PUSH_TEMPLATE_1',
  },

  schema: z.object({
    title: z.string(),
    message: z.string(),
  }),

  async send({ to, template_id, variables }) {
    console.log(to, template_id, variables);
    return { ok: true };
  },
};
```

Provider folders are auto-loaded by `src/lib/providers/index.ts`. The provider
name becomes the `channel` value for `/notify`.
