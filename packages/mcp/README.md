# @fictjs/mcp

Fict MCP server for docs retrieval, compiler diagnostics, and Playground link generation.

## Features

- `list-sections`: list all documentation section ids.
- `get-documentation`: fetch docs content by section id (`md` or normalized `llms` format).
- `fict-autofixer`: run aggregated diagnostics on a virtual file map:
  - Compiler diagnostics (`source: "compiler"`)
  - ESLint diagnostics via `@fictjs/eslint-plugin` (`source: "eslint"`)
  - TypeScript diagnostics (syntax-focused) (`source: "typescript"`)
- `playground-link`: generate shareable Fict Playground URLs from template + file overrides.
- `fict-task` prompt: docs-first + autofixer-before-output workflow template.
- `fict://doc/<section-id>` resources for each local docs section.

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
pnpm --filter @fictjs/mcp exec fict-mcp
```

Environment variables:

- `FICT_MCP_DOCS_ROOT`: absolute or relative path to docs root (default: auto-discover `<workspace>/docs`).
- `FICT_PLAYGROUND_ORIGIN`: playground base URL (default: `http://localhost:4173`).

## `fict-autofixer` options

`fict-autofixer` input supports:

- `profile`: `app-default | ci-hard-gate | migration`
- `includeEslint` (default: `true`)
- `includeTypescript` (default: `true`)

## Example MCP client config

```json
{
  "mcpServers": {
    "fict": {
      "command": "pnpm",
      "args": ["--filter", "@fictjs/mcp", "exec", "fict-mcp"],
      "env": {
        "FICT_MCP_DOCS_ROOT": "/absolute/path/to/fict/docs",
        "FICT_PLAYGROUND_ORIGIN": "http://localhost:4173"
      }
    }
  }
}
```
