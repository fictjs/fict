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
  enableCors: boolean
  corsOrigin?: string | undefined
  authToken?: string | undefined
  maxSessions: number
  sessionTtlMs: number
  docsRoot?: string | undefined
  docsManifestPath?: string | undefined
  playgroundOrigin?: string | undefined
}

type CliStringFlag =
  | '--host'
  | '--path'
  | '--sse-path'
  | '--messages-path'
  | '--health-path'
  | '--stats-path'
  | '--cors-origin'
  | '--auth-token'
  | '--docs-root'
  | '--docs-manifest'
  | '--playground-origin'

type CliPositiveIntFlag = '--port' | '--max-sessions' | '--session-ttl-ms'

const TRANSPORT_FLAGS: Record<string, TransportKind> = {
  '--stdio': 'stdio',
  '--http': 'http',
  '--sse': 'sse',
}

const STRING_FLAG_SETTERS: Record<CliStringFlag, (options: CliOptions, value: string) => void> = {
  '--host': (options, value) => {
    options.host = value
  },
  '--path': (options, value) => {
    options.path = value
  },
  '--sse-path': (options, value) => {
    options.ssePath = value
  },
  '--messages-path': (options, value) => {
    options.messagesPath = value
  },
  '--health-path': (options, value) => {
    options.healthPath = value
  },
  '--stats-path': (options, value) => {
    options.statsPath = value
  },
  '--cors-origin': (options, value) => {
    options.corsOrigin = value
  },
  '--auth-token': (options, value) => {
    options.authToken = value
  },
  '--docs-root': (options, value) => {
    options.docsRoot = value
  },
  '--docs-manifest': (options, value) => {
    options.docsManifestPath = value
  },
  '--playground-origin': (options, value) => {
    options.playgroundOrigin = value
  },
}

const POSITIVE_INT_FLAG_SETTERS: Record<
  CliPositiveIntFlag,
  (options: CliOptions, value: number) => void
> = {
  '--port': (options, value) => {
    options.port = value
  },
  '--max-sessions': (options, value) => {
    options.maxSessions = value
  },
  '--session-ttl-ms': (options, value) => {
    options.sessionTtlMs = value
  },
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

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (!raw) return fallback
  const normalized = raw.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false
  return fallback
}

function readArgValue(argv: string[], index: number, flagName: string): string {
  const next = argv[index + 1]
  if (!next || next === '--' || next.startsWith('--')) {
    throw new Error(`${flagName} requires a value`)
  }
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
    enableCors: readBooleanEnv('FICT_MCP_HTTP_ENABLE_CORS', false),
    corsOrigin: process.env.FICT_MCP_HTTP_CORS_ORIGIN,
    authToken: process.env.FICT_MCP_AUTH_TOKEN,
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

    const transport = TRANSPORT_FLAGS[arg]
    if (transport) {
      options.transport = transport
      continue
    }

    if (arg === '-h' || arg === '--help') {
      printHelp()
      process.exit(0)
    }

    if (arg === '--enable-cors') {
      options.enableCors = true
      continue
    }

    const stringSetter = (
      STRING_FLAG_SETTERS as Record<
        string,
        ((options: CliOptions, value: string) => void) | undefined
      >
    )[arg]
    if (stringSetter) {
      stringSetter(options, readArgValue(argv, index, arg))
      index += 1
      continue
    }

    const positiveIntSetter = (
      POSITIVE_INT_FLAG_SETTERS as Record<
        string,
        ((options: CliOptions, value: number) => void) | undefined
      >
    )[arg]
    if (positiveIntSetter) {
      positiveIntSetter(options, readPositiveIntArg(argv, index, arg))
      index += 1
      continue
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
    '  --enable-cors           Enable CORS response headers (default: disabled)',
    '  --cors-origin <origin>  CORS Access-Control-Allow-Origin value (default: *)',
    '  --auth-token <token>    Require Authorization: Bearer <token> on all requests',
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
    '  FICT_MCP_AUTH_TOKEN',
    '  FICT_MCP_HTTP_ENABLE_CORS, FICT_MCP_HTTP_CORS_ORIGIN',
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
      enableCors: options.enableCors,
      corsOrigin: options.corsOrigin,
      authToken: options.authToken,
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
    enableCors: options.enableCors,
    corsOrigin: options.corsOrigin,
    authToken: options.authToken,
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
