# @fictjs/playground

Fict playground workbench for compiler/runtime correctness exploration.

The playground is not a fake transpiler sandbox. It runs a real Vite dev server per session with
`@fictjs/vite-plugin`, so behavior matches production Fict transforms more closely.

## Features

- Session-based multi-file editor with template bootstrapping.
- Real preview server per session (`vite` + `@fictjs/vite-plugin`).
- Compiler diagnostics (`@fictjs/compiler`) + TypeScript diagnostics aggregation.
- Artifact panel to inspect transformed output.
- Config profile switching: `app-default`, `ci-hard-gate`, `migration`.
- Share/import via compressed snapshot token.

## Start

```bash
pnpm --filter @fictjs/playground build
pnpm --filter @fictjs/playground start
# or
pnpm --filter @fictjs/playground start -- --open --port 4173
```

CLI flags:

- `--host <host>` bind host (default `127.0.0.1`)
- `--port <port>` bind port (default `4173`)
- `--open` open browser after start
- `--no-open` disable browser auto-open

## Programmatic API

```ts
import { createPlaygroundServer } from '@fictjs/playground'

const server = await createPlaygroundServer({
  port: 4173,
  auth: {
    allowAnonymous: false,
    tokens: {
      dev_a: { tenantId: 'tenant-a', userId: 'alice', role: 'developer' },
      admin_ops: { tenantId: 'ops', userId: 'root', role: 'admin' },
    },
  },
  quotas: {
    defaultTenant: {
      maxSessions: 6,
      maxRequestsPerMinute: 240,
      maxVerificationsPerHour: 90,
    },
  },
  limits: {
    maxConcurrentVerifications: 2,
    verifyTimeoutMs: 30_000,
  },
})
console.log(server.url)

// ...
await server.stop()
```

## HTTP API

- `GET /api/health`
- `GET /api/templates`
- `GET /api/system/me`
- `GET /api/system/metrics`
- `GET /api/system/audit`
- `GET /api/system/tenants/:id/usage`
- `POST /api/sessions`
- `GET /api/sessions/:id`
- `DELETE /api/sessions/:id`
- `POST|PUT /api/sessions/:id/files`
- `DELETE /api/sessions/:id/files`
- `POST /api/sessions/:id/config`
- `POST /api/sessions/:id/diagnostics`
- `POST /api/sessions/:id/verify`
- `POST /api/sessions/:id/share`
- `POST /api/import`

## Notes

- Use `Authorization: Bearer <token>` for authenticated multi-tenant deployments.
- Roles: `viewer` (read), `developer` (session mutations + verify), `admin` (system metrics/audit).
- Sessions are tenant-scoped; cross-tenant access is denied.
- Per-tenant quota controls include active sessions, request rate, and verify frequency.
- Verify execution is serialized per session, globally concurrency-limited, and timeout-guarded.
- `resumable` and `functionSplitting` are available as live config toggles.
- Session files are stored under `.fict-playground/sessions` and auto-cleaned after idle timeout.
- `verify` runs diagnostics plus a real `vite build` check and returns consolidated pass/fail status.
- Share/import payloads are size-limited and schema-validated to avoid unsafe snapshots.
- API returns `400` for invalid request payloads and `404` for unknown session ids.
- The package keeps runtime correctness paths isolated; no runtime package code is modified.
