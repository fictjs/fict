import { startStdioServer } from './server/transports/stdio'
import { startSseHttpServer } from './server/transports/sse'
import { startStreamableHttpServer } from './server/transports/streamableHttp'

type TransportKind = 'stdio' | 'http' | 'sse'

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
  playgroundOrigin?: string
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

function parseArgs(argv: string[]): CliOptions {
  const envTransport = process.env.FICT_MCP_TRANSPORT
  const transport: TransportKind =
    envTransport === 'http' || envTransport === 'sse' ? envTransport : 'stdio'
  const options: CliOptions = {
    transport,
    host: process.env.FICT_MCP_HTTP_HOST ?? '127.0.0.1',
    port: readNumberEnv('FICT_MCP_HTTP_PORT', 8788),
    path: process.env.FICT_MCP_HTTP_PATH ?? '/mcp',
    ssePath: process.env.FICT_MCP_SSE_PATH ?? '/sse',
    messagesPath: process.env.FICT_MCP_SSE_MESSAGES_PATH ?? '/messages',
    healthPath: process.env.FICT_MCP_HTTP_HEALTH_PATH ?? '/healthz',
    statsPath: process.env.FICT_MCP_HTTP_STATS_PATH ?? '/stats',
    maxSessions: readNumberEnv('FICT_MCP_HTTP_MAX_SESSIONS', 100),
    sessionTtlMs: readNumberEnv('FICT_MCP_HTTP_SESSION_TTL_MS', 30 * 60 * 1000),
    docsRoot: process.env.FICT_MCP_DOCS_ROOT,
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
      const next = argv[index + 1]
      if (!next) throw new Error('--host requires a value')
      options.host = next
      index += 1
      continue
    }

    if (arg === '--port') {
      const next = argv[index + 1]
      if (!next) throw new Error('--port requires a numeric value')
      const parsed = Number(next)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--port requires a numeric value')
      }
      options.port = parsed
      index += 1
      continue
    }

    if (arg === '--path') {
      const next = argv[index + 1]
      if (!next) throw new Error('--path requires a value')
      options.path = next
      index += 1
      continue
    }

    if (arg === '--sse-path') {
      const next = argv[index + 1]
      if (!next) throw new Error('--sse-path requires a value')
      options.ssePath = next
      index += 1
      continue
    }

    if (arg === '--messages-path') {
      const next = argv[index + 1]
      if (!next) throw new Error('--messages-path requires a value')
      options.messagesPath = next
      index += 1
      continue
    }

    if (arg === '--health-path') {
      const next = argv[index + 1]
      if (!next) throw new Error('--health-path requires a value')
      options.healthPath = next
      index += 1
      continue
    }

    if (arg === '--stats-path') {
      const next = argv[index + 1]
      if (!next) throw new Error('--stats-path requires a value')
      options.statsPath = next
      index += 1
      continue
    }

    if (arg === '--max-sessions') {
      const next = argv[index + 1]
      if (!next) throw new Error('--max-sessions requires a numeric value')
      const parsed = Number(next)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--max-sessions requires a positive number')
      }
      options.maxSessions = parsed
      index += 1
      continue
    }

    if (arg === '--session-ttl-ms') {
      const next = argv[index + 1]
      if (!next) throw new Error('--session-ttl-ms requires a numeric value')
      const parsed = Number(next)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--session-ttl-ms requires a positive number')
      }
      options.sessionTtlMs = parsed
      index += 1
      continue
    }

    if (arg === '--docs-root') {
      const next = argv[index + 1]
      if (!next) throw new Error('--docs-root requires a value')
      options.docsRoot = next
      index += 1
      continue
    }

    if (arg === '--playground-origin') {
      const next = argv[index + 1]
      if (!next) throw new Error('--playground-origin requires a value')
      options.playgroundOrigin = next
      index += 1
      continue
    }

    if (arg === '-h' || arg === '--help') {
      printHelp()
      process.exit(0)
    }

    throw new Error(`Unknown argument: ${arg}`)
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
    '  --sse            Run MCP over deprecated HTTP+SSE transport',
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
    '  --playground-origin <url>  Playground base URL (default: env / localhost)',
    '',
    'Environment:',
    '  FICT_MCP_TRANSPORT=http|sse|stdio',
    '  FICT_MCP_HTTP_HOST, FICT_MCP_HTTP_PORT, FICT_MCP_HTTP_PATH',
    '  FICT_MCP_SSE_PATH, FICT_MCP_SSE_MESSAGES_PATH',
    '  FICT_MCP_HTTP_HEALTH_PATH, FICT_MCP_HTTP_STATS_PATH',
    '  FICT_MCP_HTTP_MAX_SESSIONS, FICT_MCP_HTTP_SESSION_TTL_MS',
    '  FICT_MCP_DOCS_ROOT, FICT_PLAYGROUND_ORIGIN',
  ].join('\n')

  process.stdout.write(`${message}\n`)
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)

  if (options.transport === 'stdio') {
    await startStdioServer()
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
      playgroundOrigin: options.playgroundOrigin,
    })

    process.stderr.write(`Fict MCP SSE server running at ${server.url}\n`)
    process.stderr.write(`Messages: ${server.messagesUrl}\n`)
    process.stderr.write(`Health: ${server.healthUrl}\n`)
    process.stderr.write(`Stats: ${server.statsUrl}\n`)

    const shutdown = async (): Promise<void> => {
      await server.close()
      process.exit(0)
    }

    process.on('SIGINT', () => {
      void shutdown()
    })
    process.on('SIGTERM', () => {
      void shutdown()
    })
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
    playgroundOrigin: options.playgroundOrigin,
  })

  process.stderr.write(`Fict MCP HTTP server running at ${server.url}\n`)
  process.stderr.write(`Health: ${server.healthUrl}\n`)
  process.stderr.write(`Stats: ${server.statsUrl}\n`)

  const shutdown = async (): Promise<void> => {
    await server.close()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })
}
