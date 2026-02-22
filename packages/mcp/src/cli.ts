import { startStdioServer } from './server/transports/stdio'
import { startStreamableHttpServer } from './server/transports/streamableHttp'

type TransportKind = 'stdio' | 'http'

interface CliOptions {
  transport: TransportKind
  host: string
  port: number
  path: string
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
  const transport: TransportKind = envTransport === 'http' ? 'http' : 'stdio'
  const options: CliOptions = {
    transport,
    host: process.env.FICT_MCP_HTTP_HOST ?? '127.0.0.1',
    port: readNumberEnv('FICT_MCP_HTTP_PORT', 8788),
    path: process.env.FICT_MCP_HTTP_PATH ?? '/mcp',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg) continue

    if (arg === '--stdio') {
      options.transport = 'stdio'
      continue
    }

    if (arg === '--http') {
      options.transport = 'http'
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
    '',
    'HTTP options:',
    '  --host <host>    Bind host (default: 127.0.0.1)',
    '  --port <port>    Bind port (default: 8788)',
    '  --path <path>    MCP endpoint path (default: /mcp)',
    '',
    'Environment:',
    '  FICT_MCP_TRANSPORT=http|stdio',
    '  FICT_MCP_HTTP_HOST, FICT_MCP_HTTP_PORT, FICT_MCP_HTTP_PATH',
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

  const server = await startStreamableHttpServer({
    host: options.host,
    port: options.port,
    path: options.path,
    docsRoot: process.env.FICT_MCP_DOCS_ROOT,
    playgroundOrigin: process.env.FICT_PLAYGROUND_ORIGIN,
  })

  process.stderr.write(`Fict MCP HTTP server running at ${server.url}\n`)

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
