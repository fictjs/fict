// @vitest-environment node

import { EventEmitter } from 'node:events'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openMock } = vi.hoisted(() => ({
  openMock: vi.fn(async () => {}),
}))

vi.mock('open', () => ({ default: openMock }))

import fictDevTools from '../src/vite/index'
import { serializeComponentNameTransformer } from '../src/vite/component-name-transformer'

interface MockPluginServer {
  config: {
    base: string
    logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
    root: string
    server: { host: string; https: boolean; port: number }
  }
  httpServer: EventEmitter & { address: () => { address: string; family: string; port: number } }
  middlewares: { use: ReturnType<typeof vi.fn> }
}

function getHook(plugin: unknown, name: 'configureServer' | 'closeBundle' | 'load') {
  const hook = (plugin as Record<string, unknown>)[name]
  if (typeof hook !== 'function') throw new Error(`Missing ${name} hook`)
  return hook
}

describe('DevTools Vite public options', () => {
  beforeEach(() => {
    openMock.mockClear()
  })

  it('uses port for the standalone launcher and opens that URL', async () => {
    const httpServer = new EventEmitter() as MockPluginServer['httpServer']
    httpServer.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 5173 })
    const logger = { info: vi.fn(), warn: vi.fn() }
    const server: MockPluginServer = {
      config: {
        base: '/',
        logger,
        root: process.cwd(),
        server: { host: '127.0.0.1', https: false, port: 5173 },
      },
      httpServer,
      middlewares: { use: vi.fn() },
    }
    const plugin = fictDevTools({
      enabled: true,
      liveTrace: false,
      openInBrowser: true,
      port: 0,
    })[0]!

    getHook(plugin, 'configureServer')(server)
    httpServer.emit('listening')

    await vi.waitFor(() => expect(openMock).toHaveBeenCalledOnce())
    const standaloneUrl = openMock.mock.calls[0]?.[0]
    expect(standaloneUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)

    const response = await fetch(standaloneUrl!)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('http://127.0.0.1:5173/__fict-devtools__/')
    expect(logger.warn).not.toHaveBeenCalled()

    await getHook(plugin, 'closeBundle')()
    await expect(fetch(standaloneUrl!)).rejects.toThrow()
  })

  it('serializes the configured component name transformer into the virtual runtime', () => {
    const plugin = fictDevTools({
      enabled: true,
      componentNameTransformer: name => `App/${name}`,
    })[0]!
    const code = getHook(plugin, 'load')('\0virtual:fict-devtools') as string

    expect(code).toContain('setComponentNameTransformer')
    expect(code).toContain('App/')
    expect(code).toMatch(/\(name\)\s*=>/)
  })

  it('supports method syntax and rejects unusable public option values', () => {
    const options = {
      componentNameTransformer(name: string) {
        return `Method/${name}`
      },
    }
    const serialized = serializeComponentNameTransformer(options.componentNameTransformer)
    const transformer = Function(`return ${serialized}`)() as (name: string) => string

    expect(transformer('Counter')).toBe('Method/Counter')
    expect(() => fictDevTools({ port: 1.5 })).toThrow(/integer between 0 and 65535/)
    expect(() => serializeComponentNameTransformer(async name => name)).toThrow(
      /synchronous, self-contained/,
    )
  })
})
