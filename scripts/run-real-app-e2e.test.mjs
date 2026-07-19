import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'

import {
  REAL_APP_PORT_ENV_NAMES,
  realAppE2eEnvironment,
  releasePortReservations,
  reserveRealAppPorts,
} from './run-real-app-e2e.mjs'

function bind(port) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ exclusive: true, host: '127.0.0.1', port }, () => resolve(server))
  })
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()))
  })
}

test('real-app E2E reserves three unique loopback ports until Playwright is ready', async () => {
  const reservations = await reserveRealAppPorts({})
  try {
    assert.equal(reservations.length, REAL_APP_PORT_ENV_NAMES.length)
    assert.deepEqual(
      reservations.map(({ name }) => name),
      REAL_APP_PORT_ENV_NAMES,
    )
    assert.equal(new Set(reservations.map(({ port }) => port)).size, reservations.length)
    for (const { port } of reservations) {
      assert.ok(port >= 20_000 && port <= 29_999)
      await assert.rejects(bind(port), { code: 'EADDRINUSE' })
    }
  } finally {
    await releasePortReservations(reservations)
  }

  const rebound = await Promise.all(reservations.map(({ port }) => bind(port)))
  await Promise.all(rebound.map(close))
})

test('real-app E2E passes reserved ports and local proxy exclusions to Playwright', async () => {
  const reservations = REAL_APP_PORT_ENV_NAMES.map((name, index) => ({
    name,
    port: 24_000 + index,
  }))
  const env = realAppE2eEnvironment(reservations, {
    FICT_STRICT_GUARANTEE: '1',
    NO_PROXY: 'example.com',
    no_proxy: 'internal.test',
  })

  assert.equal(env.FICT_STRICT_GUARANTEE, undefined)
  assert.equal(env.NO_PROXY, 'example.com,localhost,127.0.0.1')
  assert.equal(env.no_proxy, 'internal.test,localhost,127.0.0.1')
  for (const { name, port } of reservations) assert.equal(env[name], String(port))
})

test('real-app E2E rejects an explicitly requested port that is already occupied', async () => {
  const occupied = await bind(0)
  const address = occupied.address()
  assert.ok(address && typeof address === 'object')
  try {
    await assert.rejects(
      reserveRealAppPorts({ [REAL_APP_PORT_ENV_NAMES[0]]: String(address.port) }),
      new RegExp(`${REAL_APP_PORT_ENV_NAMES[0]} requested unavailable port ${address.port}`),
    )
  } finally {
    await close(occupied)
  }
})
