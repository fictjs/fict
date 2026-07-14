import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer, type ViteDevServer } from 'vite'
import { describe, expect, it } from 'vitest'

import createFictVitePlugin, { __fictVitePluginInternals } from '..'

function fict(
  options?: Parameters<typeof createFictVitePlugin>[0],
): ReturnType<typeof createFictVitePlugin> {
  return createFictVitePlugin({ backend: 'legacy', ...options })
}

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

async function linkFixtureRuntime(root: string): Promise<void> {
  const nodeModules = path.join(root, 'node_modules')
  await mkdir(nodeModules, { recursive: true })
  await symlink(
    path.join(workspaceRoot, 'packages', 'fict'),
    path.join(nodeModules, 'fict'),
    'junction',
  )
}

async function createFixtureServer(
  root: string,
  options: {
    allow?: string[]
    base?: string
    functionSplitting?: boolean
    http?: boolean
    include?: string[]
    onHotUpdate?: (file: string) => void
    origin?: string
    port?: number
    preserveSymlinks?: boolean
    resumable?: boolean
  } = {},
): Promise<ViteDevServer> {
  return createServer({
    root,
    base: options.base,
    configFile: false,
    logLevel: 'silent',
    environments: { ssr: {} },
    resolve: { preserveSymlinks: options.preserveSymlinks ?? false },
    server: {
      ...(options.http
        ? {
            host: '127.0.0.1',
            port: options.port,
            strictPort: true,
            ...(options.origin ? { origin: options.origin } : {}),
          }
        : { middlewareMode: true }),
      ...(options.allow ? { fs: { allow: options.allow } } : {}),
    },
    plugins: [
      fict({
        cache: false,
        useTypeScriptProject: false,
        functionSplitting: options.functionSplitting ?? false,
        resumable: options.resumable ?? true,
        ...(options.include ? { include: options.include } : {}),
      }),
      ...(options.onHotUpdate
        ? [
            {
              name: 'fict-dev-resumable-hot-update-probe',
              handleHotUpdate({ file }: { file: string }) {
                options.onHotUpdate?.(file)
              },
            },
          ]
        : []),
    ],
  })
}

async function reservePort(): Promise<number> {
  const server = createTcpServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Failed to reserve a TCP port for the Vite fixture.')
  }
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()))
  })
  return address.port
}

async function fetchModule(url: string): Promise<string> {
  const response = await fetch(url, { headers: { accept: 'text/javascript' } })
  expect(response.status).toBe(200)
  return response.text()
}

async function transformModule(server: ViteDevServer, url: string): Promise<string> {
  const result = await server.environments.client.transformRequest(url)
  expect(result).not.toBeNull()
  return result!.code
}

async function importServedDefault(qrl: string): Promise<unknown> {
  const moduleUrl = qrl.slice(0, qrl.lastIndexOf('#'))
  const code = await fetchModule(moduleUrl)
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  const imported = (await import(/* @vite-ignore */ dataUrl)) as { default?: unknown }
  return imported.default
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 3_000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function readEventModuleId(code: string): string {
  const match = code.match(/["']([^"']+)["']\s*,\s*["']__fict_e0["']/)
  expect(match).not.toBeNull()
  return match![1]!
}

function readSplitHandlerQrl(code: string): string {
  const match = code.match(/handlerUrl\s*=\s*["']([^"']+)["']/)
  expect(match).not.toBeNull()
  return match![1]!
}

const counterSource = `
  import { $state } from 'fict'

  export function Counter() {
    let count = $state(0)
    return <button onClick$={() => count++}>{count}</button>
  }
`

const splitHandlerSource = (label: string) => `
  import { __fictQrl } from 'fict/internal'

  export const __fict_e0 = () => ${JSON.stringify(label)}
  export const handlerUrl = __fictQrl(import.meta.url, '__fict_e0')
`

async function createAliasedDelimiterRoot(delimiter: string): Promise<{
  aliasRoot: string
  logicalModule: string
  physicalRoot: string
  workspace: string
}> {
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-dev-root-alias-')))
  const physicalRoot = path.join(workspace, `project${delimiter}root`)
  const aliasRoot = path.join(workspace, 'project')
  const physicalModule = path.join(physicalRoot, 'src', 'App.tsx')

  await mkdir(path.dirname(physicalModule), { recursive: true })
  await linkFixtureRuntime(physicalRoot)
  await Promise.all([
    writeFile(
      path.join(physicalRoot, 'package.json'),
      JSON.stringify({ name: 'dev-root-alias-fixture', type: 'module' }),
    ),
    writeFile(physicalModule, counterSource),
  ])
  await symlink(physicalRoot, aliasRoot, 'junction')

  return {
    aliasRoot,
    logicalModule: path.join(aliasRoot, 'src', 'App.tsx'),
    physicalRoot,
    workspace,
  }
}

describe('Vite dev resumable module identities', () => {
  it('serves query-preserving logical URLs for symlink modules under an aliased root', async () => {
    const realRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-dev-root-real-')))
    const aliasParent = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-dev-root-alias-')))
    const aliasRoot = path.join(aliasParent, 'project')
    let server: ViteDevServer | undefined

    try {
      await Promise.all([
        mkdir(path.join(realRoot, 'shared'), { recursive: true }),
        mkdir(path.join(realRoot, 'src', 'a'), { recursive: true }),
        mkdir(path.join(realRoot, 'src', 'b'), { recursive: true }),
      ])
      await linkFixtureRuntime(realRoot)
      await Promise.all([
        writeFile(
          path.join(realRoot, 'package.json'),
          JSON.stringify({ name: 'dev-root-alias-fixture', type: 'module' }),
        ),
        writeFile(path.join(realRoot, 'shared', 'Counter.tsx'), counterSource),
        symlink('../../shared/Counter.tsx', path.join(realRoot, 'src', 'a', 'Counter.tsx')),
        symlink('../../shared/Counter.tsx', path.join(realRoot, 'src', 'b', 'Counter.tsx')),
      ])
      await symlink(realRoot, aliasRoot, 'junction')

      const query = '?import&t=123'
      server = await createFixtureServer(aliasRoot, { preserveSymlinks: true })
      const firstCode = await transformModule(server, `/src/a/Counter.tsx${query}`)
      const secondCode = await transformModule(server, `/src/b/Counter.tsx${query}`)
      const ssrCode = (await server.environments.ssr.transformRequest(
        `/src/a/Counter.tsx${query}`,
      ))!.code
      const firstId = readEventModuleId(firstCode)
      const secondId = readEventModuleId(secondCode)

      expect(firstId).toBe(`/src/a/Counter.tsx${query}`)
      expect(secondId).toBe(`/src/b/Counter.tsx${query}`)
      expect(readEventModuleId(ssrCode)).toBe(firstId)
      expect(firstId).not.toBe(secondId)
      await expect(server.environments.client.transformRequest(firstId)).resolves.not.toBeNull()
      await expect(server.environments.client.transformRequest(secondId)).resolves.not.toBeNull()

      const realModule = path.join(realRoot, 'src', 'a', 'Counter.tsx')
      const aliasModule = path.join(aliasRoot, 'src', 'a', 'Counter.tsx')
      expect(
        __fictVitePluginInternals.createDevPublicModuleId(`${aliasModule}${query}`, aliasRoot, {
          preserveSymlinks: true,
        }),
      ).toBe(
        __fictVitePluginInternals.createDevPublicModuleId(`${realModule}${query}`, realRoot, {
          preserveSymlinks: true,
        }),
      )
      expect(
        __fictVitePluginInternals.createDevPublicModuleId(`${aliasModule}${query}`, aliasRoot),
      ).toBe(__fictVitePluginInternals.createDevPublicModuleId(`${realModule}${query}`, realRoot))
      expect(
        __fictVitePluginInternals.createDevPublicModuleId(`${realModule}${query}`, aliasRoot, {
          preserveSymlinks: true,
        }),
      ).toBe(`/src/a/Counter.tsx${query}`)
    } finally {
      await server?.close()
      await Promise.all([
        rm(aliasParent, { recursive: true, force: true }),
        rm(realRoot, { recursive: true, force: true }),
      ])
    }
  })

  it.each([
    { base: '/', basePrefix: '', configuredOrigin: false, label: 'root base' },
    { base: './', basePrefix: '', configuredOrigin: false, label: 'relative base' },
    {
      base: '/q%3Fx/',
      basePrefix: '/q%3Fx',
      configuredOrigin: false,
      label: 'reserved escaped base',
    },
    {
      base: '/%41/',
      basePrefix: '/%41',
      configuredOrigin: false,
      label: 'escaped ASCII base',
    },
    {
      base: '/q%3fx/',
      basePrefix: '/q%3fx',
      configuredOrigin: false,
      label: 'lowercase escaped base',
    },
    {
      base: '/app/',
      basePrefix: '/app',
      configuredOrigin: true,
      label: 'nested base and configured origin',
    },
    {
      base: 'https://assets.example.test/app/',
      basePrefix: '/app',
      configuredOrigin: true,
      label: 'full URL base and configured origin',
    },
  ])(
    'serves root and /@fs/ identities over HTTP with $label',
    async ({ base, basePrefix, configuredOrigin }) => {
      const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-dev-http-')))
      const root = path.join(workspace, 'app')
      const outside = path.join(workspace, 'outside source')
      const insideModule = path.join(root, 'src', 'Inside App-ä%literal.tsx')
      const outsideModule = path.join(outside, 'Outside.tsx')
      const port = await reservePort()
      const actualOrigin = `http://127.0.0.1:${port}`
      const identityOrigin = configuredOrigin ? actualOrigin : ''
      let server: ViteDevServer | undefined

      try {
        await Promise.all([
          mkdir(path.join(root, 'src'), { recursive: true }),
          mkdir(outside, { recursive: true }),
        ])
        await linkFixtureRuntime(root)
        await Promise.all([
          writeFile(
            path.join(root, 'package.json'),
            JSON.stringify({ name: 'dev-http-fixture', type: 'module' }),
          ),
          writeFile(insideModule, counterSource),
          writeFile(outsideModule, counterSource),
        ])

        server = await createFixtureServer(root, {
          allow: [workspace, workspaceRoot],
          base,
          http: true,
          include: [`${root}/**/*`, `${outside}/**/*`],
          ...(configuredOrigin ? { origin: actualOrigin } : {}),
          port,
        })
        await server.listen()

        const insidePath = `${basePrefix}/src/Inside%20App-%C3%A4%25literal.tsx`
        const insideCode = await fetchModule(`${actualOrigin}${insidePath}?import&t=4`)
        expect(insideCode).not.toContain('/@id/__x00__fict-handler:')
        const insidePublicId = readEventModuleId(insideCode)
        expect(insidePublicId).toBe(`${identityOrigin}${insidePath}?t=4`)

        const normalizedOutside = outsideModule.split(path.sep).join('/')
        const fsPath = normalizedOutside.startsWith('/')
          ? normalizedOutside
          : `/${normalizedOutside}`
        const outsidePath = `${basePrefix}/@fs${encodeURI(fsPath)}`
        const outsideCode = await fetchModule(`${actualOrigin}${outsidePath}?import&v=7`)
        const outsidePublicId = readEventModuleId(outsideCode)
        expect(outsidePublicId).toBe(`${identityOrigin}${outsidePath}?v=7`)

        const documentBase = configuredOrigin
          ? 'http://document.example.test/page'
          : `${actualOrigin}/page`
        await fetchModule(new URL(insidePublicId, documentBase).href)
        await fetchModule(new URL(outsidePublicId, documentBase).href)
        if (configuredOrigin) {
          expect(new URL(insidePublicId, documentBase).origin).toBe(actualOrigin)
          expect(new URL(outsidePublicId, documentBase).origin).toBe(actualOrigin)
        }
      } finally {
        await server?.close()
        await rm(workspace, { recursive: true, force: true })
      }
    },
  )

  it('serves split handlers as importable Vite URLs across query and HMR generations', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-dev-split-handler-')))
    const module = path.join(root, 'src', 'Handler.ts')
    const port = await reservePort()
    const origin = `http://127.0.0.1:${port}`
    let resolveHotUpdate!: () => void
    const hotUpdateSeen = new Promise<void>(resolve => {
      resolveHotUpdate = resolve
    })
    let server: ViteDevServer | undefined

    try {
      await mkdir(path.dirname(module), { recursive: true })
      await linkFixtureRuntime(root)
      await Promise.all([
        writeFile(
          path.join(root, 'package.json'),
          JSON.stringify({ name: 'dev-split-handler-fixture', type: 'module' }),
        ),
        writeFile(module, splitHandlerSource('first')),
      ])

      server = await createFixtureServer(root, {
        base: '/app/',
        functionSplitting: true,
        http: true,
        onHotUpdate: file => {
          if (path.normalize(file) === path.normalize(module)) resolveHotUpdate()
        },
        origin,
        port,
      })
      await server.listen()

      const firstCode = await fetchModule(`${origin}/app/src/Handler.ts?import&t=41`)
      const firstQrl = readSplitHandlerQrl(firstCode)
      expect(firstQrl).toMatch(
        new RegExp(
          `^${origin}/app/@id/__x00__fict-handler-dev:g[0-9a-z]+:e[0-9a-z]+:h[a-f0-9]{32}\\$\\$__fict_e0#default$`,
        ),
      )
      const firstHandler = await importServedDefault(firstQrl)
      expect(firstHandler).toBeTypeOf('function')
      expect((firstHandler as () => unknown)()).toBe('first')

      await server.watcher.unwatch(module)
      await writeFile(module, splitHandlerSource('second'))
      server.watcher.emit('change', module)
      await withTimeout(hotUpdateSeen, 'split handler HMR invalidation')

      const secondCode = await fetchModule(`${origin}/app/src/Handler.ts?import&t=42`)
      const secondQrl = readSplitHandlerQrl(secondCode)
      expect(secondQrl).not.toBe(firstQrl)
      expect(secondQrl).toMatch(
        new RegExp(
          `^${origin}/app/@id/__x00__fict-handler-dev:g[0-9a-z]+:e[0-9a-z]+:h[a-f0-9]{32}\\$\\$__fict_e0#default$`,
        ),
      )
      const secondHandler = await importServedDefault(secondQrl)
      expect(secondHandler).toBeTypeOf('function')
      expect((secondHandler as () => unknown)()).toBe('second')
    } finally {
      await server?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serves environment-scoped split handlers without crossing HMR generations', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-dev-shared-handler-')))
    const module = path.join(root, 'src', 'Handler.ts')
    const port = await reservePort()
    const origin = `http://127.0.0.1:${port}`
    let resolveHotUpdate!: () => void
    const hotUpdateSeen = new Promise<void>(resolve => {
      resolveHotUpdate = resolve
    })
    let server: ViteDevServer | undefined

    try {
      await mkdir(path.dirname(module), { recursive: true })
      await linkFixtureRuntime(root)
      await Promise.all([
        writeFile(
          path.join(root, 'package.json'),
          JSON.stringify({ name: 'dev-shared-handler-fixture', type: 'module' }),
        ),
        writeFile(module, splitHandlerSource('old')),
      ])

      server = await createFixtureServer(root, {
        base: '/ssr/',
        functionSplitting: true,
        http: true,
        onHotUpdate: file => {
          if (path.normalize(file) === path.normalize(module)) resolveHotUpdate()
        },
        origin,
        port,
      })
      await server.listen()

      const oldResult = await server.environments.ssr.transformRequest('/src/Handler.ts?t=41')
      expect(oldResult).not.toBeNull()
      const oldQrl = readSplitHandlerQrl(oldResult!.code)
      expect(server.environments.client.moduleGraph.getModuleById(module)).toBeUndefined()
      expect(server.environments.client.moduleGraph.getModuleById(`${module}?t=41`)).toBeUndefined()
      const oldHandler = await importServedDefault(oldQrl)
      expect(oldHandler).toBeTypeOf('function')
      expect((oldHandler as () => unknown)()).toBe('old')
      expect(server.environments.client.moduleGraph.getModuleById(module)).toBeUndefined()

      await server.watcher.unwatch(module)
      await writeFile(module, splitHandlerSource('new'))
      server.watcher.emit('change', module)
      await withTimeout(hotUpdateSeen, 'shared handler HMR invalidation')

      const oldModuleUrl = oldQrl.slice(0, oldQrl.lastIndexOf('#'))
      const staleResponse = await fetch(oldModuleUrl, {
        headers: { accept: 'text/javascript' },
      })
      expect(staleResponse.status).not.toBe(200)

      const [newSsrResult, newClientResult] = await Promise.all([
        server.environments.ssr.transformRequest('/src/Handler.ts?t=42'),
        server.environments.client.transformRequest('/src/Handler.ts?t=42'),
      ])
      expect(newSsrResult).not.toBeNull()
      expect(newClientResult).not.toBeNull()
      const newSsrQrl = readSplitHandlerQrl(newSsrResult!.code)
      const newClientQrl = readSplitHandlerQrl(newClientResult!.code)
      expect(newSsrQrl).not.toBe(newClientQrl)
      expect(newSsrQrl).not.toBe(oldQrl)
      const [newSsrHandler, newClientHandler] = await Promise.all([
        importServedDefault(newSsrQrl),
        importServedDefault(newClientQrl),
      ])
      expect(newSsrHandler).toBeTypeOf('function')
      expect(newClientHandler).toBeTypeOf('function')
      expect((newSsrHandler as () => unknown)()).toBe('new')
      expect((newClientHandler as () => unknown)()).toBe('new')
    } finally {
      await server?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { delimiter: '?', resumable: true },
    { delimiter: '#', resumable: true },
    { delimiter: '?', resumable: false },
    { delimiter: '#', resumable: false },
  ])(
    'rejects dev when the Vite root contains $delimiter with resumable=$resumable',
    async ({ delimiter, resumable }) => {
      const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-dev-root-path-')))
      const root = path.join(workspace, `project${delimiter}root`)
      const module = path.join(root, 'src', 'App.tsx')

      try {
        await mkdir(path.dirname(module), { recursive: true })
        await Promise.all([
          writeFile(
            path.join(root, 'package.json'),
            JSON.stringify({ name: 'dev-root-path-fixture', type: 'module' }),
          ),
          writeFile(module, counterSource),
        ])

        expect(__fictVitePluginInternals.createDevPublicModuleId(module, root)).toBe('/src/App.tsx')
        await expect(createFixtureServer(root, { resumable })).rejects.toThrow(
          /Vite cannot serve project roots containing a literal "\?" or "#" in dev mode/,
        )
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    },
  )

  it.each(['?', '#'])(
    'rejects a safe root alias to a physical root containing %s by default',
    async delimiter => {
      const { aliasRoot, physicalRoot, workspace } = await createAliasedDelimiterRoot(delimiter)

      try {
        const creation = createFixtureServer(aliasRoot)
        await expect(creation).rejects.toThrow(
          /Vite cannot serve project roots containing a literal "\?" or "#" in dev mode/,
        )
        await expect(creation).rejects.toThrow(physicalRoot)
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    },
  )

  it.each(['?', '#'])(
    'transforms a safe root alias to a physical root containing %s when preserving symlinks',
    async delimiter => {
      const { aliasRoot, logicalModule, workspace } = await createAliasedDelimiterRoot(delimiter)
      let server: ViteDevServer | undefined

      try {
        expect(
          __fictVitePluginInternals.createDevPublicModuleId(logicalModule, aliasRoot, {
            preserveSymlinks: true,
          }),
        ).toBe('/src/App.tsx')
        server = await createFixtureServer(aliasRoot, { preserveSymlinks: true })
        const code = await transformModule(server, '/src/App.tsx?import')
        expect(readEventModuleId(code)).toBe('/src/App.tsx?import')
      } finally {
        await server?.close()
        await rm(workspace, { recursive: true, force: true })
      }
    },
  )

  it('keeps a safe logical symlink URL when only the physical target has a delimiter', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-dev-link-delimiter-')))
    const target = path.join(root, 'shared', 'Target?physical.tsx')
    const alias = path.join(root, 'src', 'Alias.tsx')
    let server: ViteDevServer | undefined

    try {
      await Promise.all([
        mkdir(path.dirname(target), { recursive: true }),
        mkdir(path.dirname(alias), { recursive: true }),
      ])
      await linkFixtureRuntime(root)
      await Promise.all([
        writeFile(
          path.join(root, 'package.json'),
          JSON.stringify({ name: 'dev-link-delimiter-fixture', type: 'module' }),
        ),
        writeFile(target, counterSource),
        symlink('../shared/Target?physical.tsx', alias),
      ])

      expect(
        __fictVitePluginInternals.createDevPublicModuleId(alias, root, {
          preserveSymlinks: true,
        }),
      ).toBe('/src/Alias.tsx')
      expect(() => __fictVitePluginInternals.createDevPublicModuleId(alias, root)).toThrow(
        /Vite cannot serve source paths containing a literal "\?" or "#"/,
      )

      server = await createFixtureServer(root, { preserveSymlinks: true })
      const code = await transformModule(server, '/src/Alias.tsx?import')
      expect(readEventModuleId(code)).toBe('/src/Alias.tsx?import')
    } finally {
      await server?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['?', '#'])('fails closed for a real source path containing %s', async delimiter => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fict-dev-delimiter-')))
    const module = path.join(root, 'src', `App${delimiter}physical.tsx`)
    let server: ViteDevServer | undefined

    try {
      await mkdir(path.dirname(module), { recursive: true })
      await linkFixtureRuntime(root)
      await Promise.all([
        writeFile(
          path.join(root, 'package.json'),
          JSON.stringify({ name: 'dev-delimiter-fixture', type: 'module' }),
        ),
        writeFile(module, counterSource),
      ])

      expect(() =>
        __fictVitePluginInternals.createDevPublicModuleId(`${module}?import`, root),
      ).toThrow(/Vite cannot serve source paths containing a literal "\?" or "#"/)
      server = await createFixtureServer(root)
      await expect(
        server.environments.client.pluginContainer.transform(counterSource, module),
      ).rejects.toThrow(/Vite cannot serve source paths containing a literal "\?" or "#"/)
    } finally {
      await server?.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
