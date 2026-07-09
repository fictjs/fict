import { beforeEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(() => true),
  readFileSyncMock: vi.fn((path: string) => Buffer.from(`asset:${path}`)),
}))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: existsSyncMock,
      readFileSync: readFileSyncMock,
    },
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
  }
})

import fictDevTools from '../src/vite/index'

interface MockResponse {
  body?: Buffer | string
  headers: Record<string, string>
  statusCode: number
  end(body?: Buffer | string): void
  setHeader(name: string, value: string): void
}

type DevToolsMiddleware = (req: { url?: string }, res: MockResponse, next: () => void) => void

function createStaticAssetMiddleware(): DevToolsMiddleware {
  const middlewares = new Map<string, DevToolsMiddleware>()
  const plugin = fictDevTools({ enabled: true })[0]!
  const configureServer = plugin.configureServer as (server: unknown) => void

  configureServer({
    config: {
      base: '/',
      logger: { info: vi.fn() },
      server: { host: 'localhost', port: 5173 },
    },
    httpServer: undefined,
    middlewares: {
      use(route: string, middleware: DevToolsMiddleware) {
        middlewares.set(route, middleware)
      },
    },
  })

  return middlewares.get('/__fict-devtools__')!
}

function requestAsset(middleware: DevToolsMiddleware, url: string) {
  const next = vi.fn()
  const response: MockResponse = {
    headers: {},
    statusCode: 200,
    end(body) {
      this.body = body
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
  }

  middleware({ url }, response, next)
  return { next, response }
}

describe('DevTools Vite static assets', () => {
  beforeEach(() => {
    existsSyncMock.mockClear()
    readFileSyncMock.mockClear()
  })

  it.each([
    '/../../../../etc/hosts',
    '/%2e%2e/%2e%2e/etc/hosts',
    '/..%2f..%2fetc/hosts',
    '/..%5c..%5cWindows/win.ini',
    '/%252e%252e/%252e%252e/etc/hosts',
  ])('rejects traversal path %s before touching the filesystem', url => {
    const { next, response } = requestAsset(createStaticAssetMiddleware(), url)

    expect(response.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
    expect(existsSyncMock).not.toHaveBeenCalled()
    expect(readFileSyncMock).not.toHaveBeenCalled()
  })

  it.each(['/%00/etc/passwd', '/%E0%A4%A'])('rejects malformed path %s', url => {
    const { next, response } = requestAsset(createStaticAssetMiddleware(), url)

    expect(response.statusCode).toBe(400)
    expect(next).not.toHaveBeenCalled()
    expect(existsSyncMock).not.toHaveBeenCalled()
    expect(readFileSyncMock).not.toHaveBeenCalled()
  })

  it('serves the index script while ignoring its query string', () => {
    const { next, response } = requestAsset(
      createStaticAssetMiddleware(),
      '/index.js?v=123&source=../../etc/passwd',
    )

    expect(response.statusCode).toBe(200)
    expect(response.headers['Content-Type']).toBe('application/javascript')
    expect(String(response.body)).toContain('panel.js')
    expect(next).not.toHaveBeenCalled()
    expect(readFileSyncMock).toHaveBeenCalledOnce()
  })

  it('serves the stylesheet alias while ignoring its query string', () => {
    const { next, response } = requestAsset(createStaticAssetMiddleware(), '/styles.css?theme=dark')

    expect(response.statusCode).toBe(200)
    expect(response.headers['Content-Type']).toBe('text/css')
    expect(String(response.body)).toContain('assets/panel.css')
    expect(next).not.toHaveBeenCalled()
    expect(readFileSyncMock).toHaveBeenCalledOnce()
  })
})
