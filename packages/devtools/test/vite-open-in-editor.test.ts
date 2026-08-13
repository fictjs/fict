// @vitest-environment node

import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> }
    child.unref = vi.fn()
    queueMicrotask(() => child.emit('spawn'))
    return child
  }),
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import fictDevTools from '../src/vite/index'
import {
  createEditorInvocation,
  parseEditorLocation,
  resolveEditorLocation,
  resolveEditorRoots,
} from '../src/vite/open-in-editor'

interface MockRequest {
  headers: Record<string, string | undefined>
  method: string
  url: string
}

interface MockResponse {
  body?: string
  headers: Record<string, string>
  statusCode: number
  end(body?: string): void
  setHeader(name: string, value: string): void
}

type Middleware = (
  request: MockRequest,
  response: MockResponse,
  next: ReturnType<typeof vi.fn>,
) => void | Promise<void>

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fict-open-in-editor-'))
  temporaryDirectories.push(directory)
  return directory
}

function configureMiddleware(root: string, openInEditor: false | object = {}) {
  const middlewares = new Map<string, Middleware>()
  const plugin = fictDevTools({ enabled: true, liveTrace: false, openInEditor })[0]!
  const configureServer = plugin.configureServer as (server: unknown) => void
  configureServer({
    config: {
      base: '/',
      logger: { info: vi.fn(), warn: vi.fn() },
      root,
      server: { host: '127.0.0.1', https: false, port: 5173 },
    },
    httpServer: undefined,
    middlewares: {
      use(route: string, middleware: Middleware) {
        middlewares.set(route, middleware)
      },
    },
  })
  return middlewares
}

async function request(
  middleware: Middleware,
  { headers = {}, method = 'GET', url = '/' }: Partial<MockRequest> = {},
): Promise<MockResponse> {
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
  await middleware({ headers, method, url }, response, vi.fn())
  return response
}

afterEach(() => {
  spawnMock.mockClear()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('open-in-editor path handling', () => {
  it('parses Windows drive letters from the right', () => {
    expect(parseEditorLocation('C:\\project\\src\\App.tsx:12:3')).toEqual({
      filePath: 'C:\\project\\src\\App.tsx',
      line: 12,
      column: 3,
    })
  })

  it('canonicalizes targets and rejects files outside all allowed roots', () => {
    const root = temporaryDirectory()
    const outsideRoot = temporaryDirectory()
    const source = join(root, 'source.ts')
    const outside = join(outsideRoot, 'secret.ts')
    writeFileSync(source, 'export {}')
    writeFileSync(outside, 'secret')
    symlinkSync(outside, join(root, 'linked-secret.ts'))
    const roots = resolveEditorRoots(root, [])

    expect(resolveEditorLocation('source.ts:4:2', root, roots)).toEqual({
      filePath: realpathSync(source),
      line: 4,
      column: 2,
    })
    expect(() => resolveEditorLocation(outside, root, roots)).toThrow(/outside the allowed roots/)
    expect(() => resolveEditorLocation('linked-secret.ts', root, roots)).toThrow(
      /outside the allowed roots/,
    )
    expect(
      resolveEditorLocation(outside, root, resolveEditorRoots(root, [outsideRoot])).filePath,
    ).toBe(realpathSync(outside))
  })

  it('keeps the resolved Windows-style location intact in editor arguments', () => {
    expect(
      createEditorInvocation(
        { filePath: 'C:\\project\\src\\App.tsx', line: 12, column: 3 },
        'code',
      ),
    ).toEqual({
      command: 'code',
      args: ['--goto', 'C:\\project\\src\\App.tsx:12:3'],
    })
  })
})

describe('open-in-editor middleware', () => {
  it('requires POST, a same-origin request, and the per-server token', async () => {
    const root = temporaryDirectory()
    const middlewares = configureMiddleware(root)
    const assets = middlewares.get('/__fict-devtools__')!
    const editor = middlewares.get('/__open-in-editor')!
    const html = await request(assets)
    const token = html.body?.match(/name="fict-devtools-token" content="([^"]+)"/)?.[1]

    expect(token).toBeTruthy()
    expect((await request(editor)).statusCode).toBe(405)
    expect((await request(editor, { method: 'POST' })).statusCode).toBe(403)
    expect(
      (
        await request(editor, {
          method: 'POST',
          headers: {
            host: '127.0.0.1:5173',
            origin: 'https://attacker.example',
            'sec-fetch-site': 'cross-site',
            'x-fict-devtools-token': token,
          },
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await request(editor, {
          method: 'POST',
          headers: {
            host: '127.0.0.1:5173',
            origin: 'http://127.0.0.1:5173',
            'sec-fetch-site': 'same-origin',
            'x-fict-devtools-token': token,
          },
        })
      ).statusCode,
    ).toBe(400)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('opens only an allowed existing file', async () => {
    const root = temporaryDirectory()
    const source = join(root, 'source.ts')
    writeFileSync(source, 'export {}')
    const middlewares = configureMiddleware(root)
    const html = await request(middlewares.get('/__fict-devtools__')!)
    const token = html.body?.match(/name="fict-devtools-token" content="([^"]+)"/)?.[1]
    const response = await request(middlewares.get('/__open-in-editor')!, {
      method: 'POST',
      url: `/?file=${encodeURIComponent(`${source}:8:2`)}`,
      headers: {
        host: '127.0.0.1:5173',
        origin: 'http://127.0.0.1:5173',
        'sec-fetch-site': 'same-origin',
        'x-fict-devtools-token': token,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(spawnMock).toHaveBeenCalledWith(
      'code',
      ['--goto', `${realpathSync(source)}:8:2`],
      expect.objectContaining({ detached: true }),
    )
  })

  it('does not register the endpoint when disabled', () => {
    const root = temporaryDirectory()
    expect(configureMiddleware(root, false).has('/__open-in-editor')).toBe(false)
  })
})
