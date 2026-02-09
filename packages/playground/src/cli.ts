import { spawn } from 'node:child_process'

import { createPlaygroundServer } from './server/http-server'
import type { PlaygroundServerOptions } from './server/types'

interface CliOptions {
  host: string
  port?: number
  open: boolean
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)

  const server = await createPlaygroundServer(options)

  process.stdout.write(`Fict Playground running at ${server.url}\n`)

  if (options.open) {
    openUrl(server.url)
  }

  const shutdown = async (): Promise<void> => {
    await server.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    host: '127.0.0.1',
    open: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg) continue

    if (arg === '--open') {
      options.open = true
      continue
    }

    if (arg === '--no-open') {
      options.open = false
      continue
    }

    if (arg === '--host') {
      const next = argv[index + 1]
      if (!next) {
        throw new Error('--host requires a value')
      }
      options.host = next
      index += 1
      continue
    }

    if (arg === '--port') {
      const next = argv[index + 1]
      if (!next) {
        throw new Error('--port requires a numeric value')
      }
      const parsed = Number(next)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--port requires a numeric value')
      }
      options.port = parsed
      index += 1
      continue
    }

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

function printHelp(): void {
  const message = [
    'Usage: fict-playground [options]',
    '',
    'Options:',
    '  --host <host>   Bind host (default: 127.0.0.1)',
    '  --port <port>   Bind port (default: 4173)',
    '  --open          Open browser after start',
    '  --no-open       Disable browser auto-open',
    '  -h, --help      Show this message',
  ].join('\n')

  process.stdout.write(`${message}\n`)
}

function openUrl(url: string): void {
  const platform = process.platform

  if (platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    return
  }

  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
    return
  }

  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
}

export type { PlaygroundServerOptions }
