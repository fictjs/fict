import { spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import path from 'node:path'
import process from 'node:process'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const host = '127.0.0.1'
const safePortStart = 20_000
const safePortEnd = 29_999

export const REAL_APP_PORT_ENV_NAMES = [
  'FICT_REAL_APP_OPERATIONS_PORT',
  'FICT_REAL_APP_RESUMABLE_SSR_PORT',
  'FICT_REAL_APP_STREAMING_SSR_PORT',
]

function requestedPort(env, name) {
  const raw = env[name]
  if (raw === undefined) return undefined

  const port = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || String(port) !== raw) {
    throw new Error(
      `${name} must be an integer between 1 and 65535; received ${JSON.stringify(raw)}`,
    )
  }
  return port
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    const onError = error => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      server.unref()
      resolve(server)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ exclusive: true, host, port })
  })
}

async function reserveRandomPort() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = randomInt(safePortStart, safePortEnd + 1)
    try {
      return { port, server: await listen(port) }
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error(`Unable to reserve a real-app E2E port in ${safePortStart}-${safePortEnd}`)
}

export async function reserveRealAppPorts(env = process.env) {
  const reservations = []
  try {
    for (const name of REAL_APP_PORT_ENV_NAMES) {
      const port = requestedPort(env, name)
      try {
        reservations.push({
          name,
          ...(port === undefined
            ? await reserveRandomPort()
            : { port, server: await listen(port) }),
        })
      } catch (error) {
        if (port !== undefined && error?.code === 'EADDRINUSE') {
          throw new Error(`${name} requested unavailable port ${port}`, { cause: error })
        }
        throw error
      }
    }
    return reservations
  } catch (error) {
    await releasePortReservations(reservations)
    throw error
  }
}

export async function releasePortReservations(reservations) {
  await Promise.all(
    reservations.map(
      ({ server }) =>
        new Promise((resolve, reject) => {
          server.close(error => (error ? reject(error) : resolve()))
        }),
    ),
  )
}

function appendLoopbackToNoProxy(value) {
  return [...new Set([...(value ?? '').split(',').filter(Boolean), 'localhost', '127.0.0.1'])].join(
    ',',
  )
}

export function realAppE2eEnvironment(reservations, baseEnv = process.env) {
  const env = { ...baseEnv }
  delete env.FICT_STRICT_GUARANTEE
  env.NO_PROXY = appendLoopbackToNoProxy(env.NO_PROXY)
  env.no_proxy = appendLoopbackToNoProxy(env.no_proxy)
  for (const { name, port } of reservations) env[name] = String(port)
  return env
}

function runPlaywright(args, env) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const child = spawn(
    command,
    ['exec', 'playwright', 'test', '--config', 'examples/real-apps/playwright.config.ts', ...args],
    {
      cwd: repositoryRoot,
      env,
      stdio: 'inherit',
    },
  )

  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

export async function runRealAppE2e(args = process.argv.slice(2), baseEnv = process.env) {
  const reservations = await reserveRealAppPorts(baseEnv)
  const env = realAppE2eEnvironment(reservations, baseEnv)
  const summary = reservations.map(({ name, port }) => `${name}=${port}`).join(' ')
  process.stdout.write(`[real-app-e2e] Reserved loopback ports: ${summary}\n`)
  await releasePortReservations(reservations)
  return runPlaywright(args, env)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  runRealAppE2e()
    .then(({ code, signal }) => {
      if (signal) {
        process.kill(process.pid, signal)
        return
      }
      process.exitCode = code ?? 1
    })
    .catch(error => {
      console.error(error)
      process.exitCode = 1
    })
}
