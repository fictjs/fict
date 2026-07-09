import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { get as httpGet, createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const exampleDir = fileURLToPath(new URL('..', import.meta.url))
const startupTimeoutMs = 5_000
const firstByteTimeoutMs = 1_500
const responseTimeoutMs = 4_000

async function findAvailablePort() {
  const probe = createHttpServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const address = probe.address()
  if (!address || typeof address === 'string') {
    probe.close()
    throw new Error('Failed to reserve a production smoke-test port')
  }
  const { port } = address
  probe.close()
  await once(probe, 'close')
  return port
}

function waitForServer(child, expectedLine) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Production server did not start within ${startupTimeoutMs}ms`))
    }, startupTimeoutMs)

    const onData = chunk => {
      output += chunk
      if (output.includes(expectedLine)) {
        cleanup()
        resolve()
      }
    }
    const onExit = (code, signal) => {
      cleanup()
      reject(
        new Error(
          `Production server exited before becoming ready (code=${String(code)}, signal=${String(signal)})`,
        ),
      )
    }
    const onError = error => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }

    child.stdout.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

function requestStreamedPage(port) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now()
    let firstByteAt
    let firstChunk = ''
    let body = ''
    let settled = false

    const request = httpGet(
      {
        host: '127.0.0.1',
        path: '/',
        port,
      },
      response => {
        response.setEncoding('utf8')
        response.on('data', chunk => {
          if (firstByteAt === undefined) {
            firstByteAt = performance.now()
            firstChunk = chunk
            clearTimeout(firstByteTimer)
          }
          body += chunk
        })
        response.once('end', () => {
          if (firstByteAt === undefined) {
            fail(new Error('Production response ended without a body'))
            return
          }
          finish({
            body,
            firstChunk,
            firstByteMs: firstByteAt - startedAt,
            statusCode: response.statusCode,
            totalMs: performance.now() - startedAt,
          })
        })
        response.once('error', fail)
      },
    )

    const firstByteTimer = setTimeout(() => {
      request.destroy(new Error(`Production response sent no bytes within ${firstByteTimeoutMs}ms`))
    }, firstByteTimeoutMs)
    const responseTimer = setTimeout(() => {
      request.destroy(new Error(`Production response did not finish within ${responseTimeoutMs}ms`))
    }, responseTimeoutMs)

    function cleanup() {
      clearTimeout(firstByteTimer)
      clearTimeout(responseTimer)
    }
    function finish(result) {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    function fail(error) {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    request.once('error', fail)
  })
}

function waitForExit(exitPromise, timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    exitPromise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

async function stopServer(child, exitPromise) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  if (await waitForExit(exitPromise, 1_000)) return
  child.kill('SIGKILL')
  await waitForExit(exitPromise, 1_000)
}

async function run() {
  const port = await findAvailablePort()
  const child = spawn(process.execPath, ['server.js'], {
    cwd: exampleDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exitPromise = new Promise(resolve => child.once('exit', resolve))
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdout += chunk
  })
  child.stderr.on('data', chunk => {
    stderr += chunk
  })

  try {
    await waitForServer(child, `http://localhost:${port}`)
    const response = await requestStreamedPage(port)

    assert.equal(response.statusCode, 200)
    assert.ok(
      response.firstByteMs < firstByteTimeoutMs,
      `Expected first byte before ${firstByteTimeoutMs}ms, received it after ${response.firstByteMs.toFixed(1)}ms`,
    )
    assert.match(response.firstChunk, /class="panel skeleton"/)
    assert.match(response.firstChunk, /fict:suspense-start/)
    assert.doesNotMatch(response.firstChunk, /\$612k/)
    assert.match(response.body, /\$612k/)
    assert.match(response.body, /data-fict-suspense/)
    assert.ok(
      response.totalMs < responseTimeoutMs,
      `Expected response before ${responseTimeoutMs}ms, completed after ${response.totalMs.toFixed(1)}ms`,
    )

    console.log(
      `SSR streaming production smoke passed (first byte ${response.firstByteMs.toFixed(1)}ms, complete ${response.totalMs.toFixed(1)}ms)`,
    )
  } catch (error) {
    const serverOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${serverOutput ? `\nServer output:\n${serverOutput}` : ''}`,
      { cause: error },
    )
  } finally {
    await stopServer(child, exitPromise)
  }
}

await run()
