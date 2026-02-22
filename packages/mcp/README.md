# @fictjs/mcp

Fict MCP server for docs retrieval, compiler diagnostics, and Playground link generation.

## Features

- `list-sections`: list all documentation section ids.
- `search-sections`: keyword search for relevant section ids.
- `get-documentation`: fetch docs content by section id (`md` or normalized `llms` format).
- `fict-autofixer`: run aggregated diagnostics on a virtual file map:
  - Compiler diagnostics (`source: "compiler"`)
  - ESLint diagnostics via `@fictjs/eslint-plugin` (`source: "eslint"`)
  - TypeScript diagnostics (syntax-focused) (`source: "typescript"`)
- `list-playground-templates`: discover available template ids before generating links.
- `playground-link`: generate shareable Fict Playground URLs from template + file overrides.
- `fict-task` prompt: docs-first + autofixer-before-output workflow template.
- `fict://doc/<section-id>` resources for each local docs section.

## Docs section metadata

`list-sections` / `search-sections` can expose per-section metadata from markdown frontmatter:

```md
---
title: Custom Guide Title
tags: [mcp, docs]
use_cases:
  - Explain migration constraints
  - Provide implementation checklist
---
```

If frontmatter metadata is missing, built-in defaults are still applied for core Fict docs.

## Build

```bash
pnpm --filter @fictjs/mcp build
```

## Test

```bash
pnpm --filter @fictjs/mcp test
```

## Run (stdio transport)

```bash
pnpm --filter @fictjs/mcp build
pnpm --filter @fictjs/mcp start
```

## Run (Streamable HTTP transport)

```bash
pnpm --filter @fictjs/mcp build
pnpm --filter @fictjs/mcp start -- --http --host 127.0.0.1 --port 8788 --path /mcp --health-path /healthz --stats-path /stats --max-sessions 100 --session-ttl-ms 1800000 --docs-root ../../docs --playground-origin http://localhost:4173
```

You can also switch transports via env:

```bash
FICT_MCP_TRANSPORT=http pnpm --filter @fictjs/mcp start
```

Environment variables:

- `FICT_MCP_DOCS_ROOT`: absolute or relative path to docs root (default: auto-discover `<workspace>/docs`).
- `FICT_PLAYGROUND_ORIGIN`: playground base URL (default: `http://localhost:4173`).
- `FICT_MCP_TRANSPORT`: `stdio` or `http` (default: `stdio`).
- `FICT_MCP_HTTP_HOST`: HTTP bind host (default: `127.0.0.1`).
- `FICT_MCP_HTTP_PORT`: HTTP bind port (default: `8788`).
- `FICT_MCP_HTTP_PATH`: HTTP endpoint path (default: `/mcp`).
- `FICT_MCP_HTTP_HEALTH_PATH`: health endpoint path (default: `/healthz`).
- `FICT_MCP_HTTP_STATS_PATH`: stats endpoint path (default: `/stats`).
- `FICT_MCP_HTTP_MAX_SESSIONS`: max active HTTP sessions before LRU eviction (default: `100`).
- `FICT_MCP_HTTP_SESSION_TTL_MS`: idle session TTL in milliseconds (default: `1800000`).

In HTTP mode, invalid `docsRoot` config fails fast at startup instead of deferring the error to the first MCP request.

## HTTP observability endpoints

When running with `--http`, MCP also serves:

- `GET /healthz` (configurable via `--health-path` / `FICT_MCP_HTTP_HEALTH_PATH`)
- `GET /stats` (configurable via `--stats-path` / `FICT_MCP_HTTP_STATS_PATH`)

`/stats` includes request counters, status counters, error count, active session count, and session lifecycle totals (created/reused/expired/evicted/deleted).
`--path`, `--health-path`, and `--stats-path` must be distinct values.

## `fict-autofixer` options

`fict-autofixer` input supports:

- `entry`: optional entry path; if provided it must exist in `files`
- `profile`: `app-default | ci-hard-gate | migration`
- `includeEslint` (default: `true`)
- `includeTypescript` (default: `true`)

`fict-autofixer` issue output includes:

- `source`: `compiler | eslint | typescript`
- `code`: diagnostic/rule code
- `suggestion`: actionable fix hint

## Example MCP client config

```json
{
  "mcpServers": {
    "fict": {
      "command": "pnpm",
      "args": ["--filter", "@fictjs/mcp", "start"],
      "env": {
        "FICT_MCP_DOCS_ROOT": "/absolute/path/to/fict/docs",
        "FICT_PLAYGROUND_ORIGIN": "http://localhost:4173"
      }
    }
  }
}
```
