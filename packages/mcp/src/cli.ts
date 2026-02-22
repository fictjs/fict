import { startStdioServer } from './server/transports/stdio'
import { startSseHttpServer } from './server/transports/sse'
import { startStreamableHttpServer } from './server/transports/streamableHttp'

type TransportKind = 'stdio' | 'http' | 'sse'
const ENABLE_SSE_ENV = 'FICT_MCP_ENABLE_SSE'

interface CliOptions {
  transport: TransportKind
  host: string
  port: number
  path: string
  ssePath: string
  messagesPath: string
  healthPath: string
  statsPath: string
  maxSessions: number
  sessionTtlMs: number
  docsRoot?: string
  docsManifestPath?: string
  playgroundOrigin?: string
}

function parsePositiveInt(raw: string): number | undefined {
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined
  return parsed
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = parsePositiveInt(raw)
  if (parsed === undefined) return fallback
  return parsed
}

function readArgValue(argv: string[], index: number, flagName: string): string {
  const next = argv[index + 1]
  if (!next) throw new Error(`${flagName} requires a value`)
  return next
}

function readPositiveIntArg(argv: string[], index: number, flagName: string): number {
  const raw = readArgValue(argv, index, flagName)
  const parsed = parsePositiveInt(raw)
  if (parsed === undefined) {
    throw new Error(`${flagName} requires a positive integer`)
  }
  return parsed
}

function parseArgs(argv: string[]): CliOptions {
  const envTransport = process.env.FICT_MCP_TRANSPORT
  const transport: TransportKind =
    envTransport === 'http' || envTransport === 'sse' ? envTransport : 'stdio'
  const options: CliOptions = {
    transport,
    host: process.env.FICT_MCP_HTTP_HOST ?? '127.0.0.1',
    port: readPositiveIntEnv('FICT_MCP_HTTP_PORT', 8788),
    path: process.env.FICT_MCP_HTTP_PATH ?? '/mcp',
    ssePath: process.env.FICT_MCP_SSE_PATH ?? '/sse',
    messagesPath: process.env.FICT_MCP_SSE_MESSAGES_PATH ?? '/messages',
    healthPath: process.env.FICT_MCP_HTTP_HEALTH_PATH ?? '/healthz',
    statsPath: process.env.FICT_MCP_HTTP_STATS_PATH ?? '/stats',
    maxSessions: readPositiveIntEnv('FICT_MCP_HTTP_MAX_SESSIONS', 100),
    sessionTtlMs: readPositiveIntEnv('FICT_MCP_HTTP_SESSION_TTL_MS', 30 * 60 * 1000),
    docsRoot: process.env.FICT_MCP_DOCS_ROOT,
    docsManifestPath: process.env.FICT_MCP_DOCS_MANIFEST,
    playgroundOrigin: process.env.FICT_PLAYGROUND_ORIGIN,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg) continue
    if (arg === '--') continue

    if (arg === '--stdio') {
      options.transport = 'stdio'
      continue
    }

    if (arg === '--http') {
      options.transport = 'http'
      continue
    }

    if (arg === '--sse') {
      options.transport = 'sse'
      continue
    }

    if (arg === '--host') {
      options.host = readArgValue(argv, index, '--host')
      index += 1
      continue
    }

    if (arg === '--port') {
      options.port = readPositiveIntArg(argv, index, '--port')
      index += 1
      continue
    }

    if (arg === '--path') {
      options.path = readArgValue(argv, index, '--path')
      index += 1
      continue
    }

    if (arg === '--sse-path') {
      options.ssePath = readArgValue(argv, index, '--sse-path')
      index += 1
      continue
    }

    if (arg === '--messages-path') {
      options.messagesPath = readArgValue(argv, index, '--messages-path')
      index += 1
      continue
    }

    if (arg === '--health-path') {
      options.healthPath = readArgValue(argv, index, '--health-path')
      index += 1
      continue
    }

    if (arg === '--stats-path') {
      options.statsPath = readArgValue(argv, index, '--stats-path')
      index += 1
      continue
    }

    if (arg === '--max-sessions') {
      options.maxSessions = readPositiveIntArg(argv, index, '--max-sessions')
      index += 1
      continue
    }

    if (arg === '--session-ttl-ms') {
      options.sessionTtlMs = readPositiveIntArg(argv, index, '--session-ttl-ms')
      index += 1
      continue
    }

    if (arg === '--docs-root') {
      options.docsRoot = readArgValue(argv, index, '--docs-root')
      index += 1
      continue
    }

    if (arg === '--docs-manifest') {
      options.docsManifestPath = readArgValue(argv, index, '--docs-manifest')
      index += 1
      continue
    }

    if (arg === '--playground-origin') {
      options.playgroundOrigin = readArgValue(argv, index, '--playground-origin')
      index += 1
      continue
    }

    if (arg === '-h' || arg === '--help') {
      printHelp()
      process.exit(0)
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (options.transport === 'sse' && process.env[ENABLE_SSE_ENV] !== '1') {
    throw new Error(
      `SSE transport is deprecated and disabled by default. Set ${ENABLE_SSE_ENV}=1 to enable --sse or FICT_MCP_TRANSPORT=sse.`,
    )
  }

  return options
}

function printHelp(): void {
  const message = [
    'Usage: fict-mcp [options]',
    '',
    'Transports:',
    '  --stdio          Run MCP over stdio (default)',
    '  --http           Run MCP over Streamable HTTP',
    '  --sse            Run MCP over deprecated HTTP+SSE transport (requires FICT_MCP_ENABLE_SSE=1)',
    '',
    'HTTP options:',
    '  --host <host>    Bind host (default: 127.0.0.1)',
    '  --port <port>    Bind port (default: 8788)',
    '  --path <path>    MCP endpoint path (default: /mcp)',
    '  --sse-path <path>       SSE stream path (default: /sse)',
    '  --messages-path <path>  SSE messages POST path (default: /messages)',
    '  --health-path <path>    Health endpoint path (default: /healthz)',
    '  --stats-path <path>     Stats endpoint path (default: /stats)',
    '  --max-sessions <n>     Max concurrent sessions (default: 100)',
    '  --session-ttl-ms <ms>  Session idle TTL in milliseconds (default: 1800000)',
    '  --docs-root <path>     Docs root path (default: auto-discover / env)',
    '  --docs-manifest <path> Docs manifest path override',
    '  --playground-origin <url>  Playground base URL (default: env / localhost)',
    '',
    'Environment:',
    '  FICT_MCP_TRANSPORT=http|sse|stdio',
    '  FICT_MCP_ENABLE_SSE=1  Enable deprecated --sse transport',
    '  FICT_MCP_HTTP_HOST, FICT_MCP_HTTP_PORT, FICT_MCP_HTTP_PATH',
    '  FICT_MCP_SSE_PATH, FICT_MCP_SSE_MESSAGES_PATH',
    '  FICT_MCP_HTTP_HEALTH_PATH, FICT_MCP_HTTP_STATS_PATH',
    '  FICT_MCP_HTTP_MAX_SESSIONS, FICT_MCP_HTTP_SESSION_TTL_MS',
    '  FICT_MCP_DOCS_MANIFEST',
    '  FICT_MCP_DOCS_ROOT, FICT_PLAYGROUND_ORIGIN',
  ].join('\n')

  process.stdout.write(`${message}\n`)
}

function printStartupLines(lines: string[]): void {
  for (const line of lines) {
    process.stderr.write(`${line}\n`)
  }
}

function registerShutdown(close: () => Promise<void>): void {
  let closing = false

  const shutdown = async (): Promise<void> => {
    if (closing) return
    closing = true
    await close()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)

  if (options.transport === 'stdio') {
    await startStdioServer({
      docsRoot: options.docsRoot,
      docsManifestPath: options.docsManifestPath,
      playgroundOrigin: options.playgroundOrigin,
    })
    return
  }

  if (options.transport === 'sse') {
    const server = await startSseHttpServer({
      host: options.host,
      port: options.port,
      ssePath: options.ssePath,
      messagesPath: options.messagesPath,
      healthPath: options.healthPath,
      statsPath: options.statsPath,
      maxSessions: options.maxSessions,
      sessionTtlMs: options.sessionTtlMs,
      docsRoot: options.docsRoot,
      docsManifestPath: options.docsManifestPath,
      playgroundOrigin: options.playgroundOrigin,
    })

    printStartupLines([
      `Fict MCP SSE server running at ${server.url}`,
      `Messages: ${server.messagesUrl}`,
      `Health: ${server.healthUrl}`,
      `Stats: ${server.statsUrl}`,
    ])
    registerShutdown(() => server.close())
    return
  }

  const server = await startStreamableHttpServer({
    host: options.host,
    port: options.port,
    path: options.path,
    healthPath: options.healthPath,
    statsPath: options.statsPath,
    maxSessions: options.maxSessions,
    sessionTtlMs: options.sessionTtlMs,
    docsRoot: options.docsRoot,
    docsManifestPath: options.docsManifestPath,
    playgroundOrigin: options.playgroundOrigin,
  })

  printStartupLines([
    `Fict MCP HTTP server running at ${server.url}`,
    `Health: ${server.healthUrl}`,
    `Stats: ${server.statsUrl}`,
  ])
  registerShutdown(() => server.close())
}
