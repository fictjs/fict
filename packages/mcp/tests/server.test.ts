import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeSessionSnapshot } from '@fictjs/playground'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'

import { createFictMcpServer, startSseHttpServer, startStreamableHttpServer } from '../src/index'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DOCS_ROOT = path.resolve(__dirname, '../../../docs')

interface ConnectedContext {
  client: Client
  close: () => Promise<void>
}

const activeConnections: ConnectedContext[] = []

interface ConnectServerOptions {
  docsRoot?: string
  docsManifestPath?: string
  playgroundOrigin?: string
}

async function connectServer(options: ConnectServerOptions = {}): Promise<ConnectedContext> {
  const { server } = createFictMcpServer({
    docsRoot: options.docsRoot ?? DOCS_ROOT,
    docsManifestPath: options.docsManifestPath,
    playgroundOrigin: options.playgroundOrigin ?? 'http://localhost:4173',
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'mcp-test-client', version: '0.0.0' })

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const context: ConnectedContext = {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }

  activeConnections.push(context)
  return context
}

afterEach(async () => {
  while (activeConnections.length > 0) {
    const context = activeConnections.pop()
    if (!context) continue
    await context.close()
  }
})

describe('fict mcp server', () => {
  it('discovers docs root from deeply nested cwd', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fict-mcp-deep-cwd-'))
    const docsRoot = path.join(tempRoot, 'docs')
    const deepCwd = path.join(tempRoot, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l')
    const previousCwd = process.cwd()

    await fsp.mkdir(docsRoot, { recursive: true })
    await fsp.writeFile(path.join(docsRoot, 'guide.md'), '# Guide\n', 'utf8')
    await fsp.mkdir(deepCwd, { recursive: true })

    try {
      process.chdir(deepCwd)
      const { server, docsRoot: resolvedDocsRoot } = createFictMcpServer()
      const [expectedRealpath, resolvedRealpath] = await Promise.all([
        fsp.realpath(docsRoot),
        fsp.realpath(resolvedDocsRoot),
      ])
      expect(resolvedRealpath).toBe(expectedRealpath)
      await server.close()
    } finally {
      process.chdir(previousCwd)
      await fsp.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('reads section metadata from markdown frontmatter', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fict-mcp-docs-'))
    const docsRoot = path.join(tempRoot, 'docs')

    await fsp.mkdir(docsRoot, { recursive: true })
    await fsp.writeFile(
      path.join(docsRoot, 'custom.md'),
      [
        '---',
        'title: Custom Metadata Guide',
        'tags:',
        '  - mcp',
        '  - docs',
        'use_cases:',
        '  - Validate metadata extraction',
        '---',
        '',
        '# Ignored Title',
        '',
        'Body',
      ].join('\n'),
      'utf8',
    )

    const { client } = await connectServer({ docsRoot })

    try {
      const sectionsResult = await client.callTool({
        name: 'list-sections',
        arguments: {},
      })

      const sections = Array.isArray(
        (sectionsResult.structuredContent as { sections?: unknown })?.sections,
      )
        ? ((
            sectionsResult.structuredContent as {
              sections: Array<{
                id: string
                title: string
                tags?: string[]
                use_cases?: string[]
              }>
            }
          ).sections ?? [])
        : []

      const custom = sections.find(section => section.id === 'custom')
      expect(custom).toBeTruthy()
      expect(custom?.title).toBe('Custom Metadata Guide')
      expect(custom?.tags).toEqual(['mcp', 'docs'])
      expect(custom?.use_cases).toEqual(['Validate metadata extraction'])
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('loads docs sections from manifest when provided', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fict-mcp-manifest-'))
    const docsRoot = path.join(tempRoot, 'docs')
    const manifestPath = path.join(tempRoot, 'docs-manifest.json')

    await fsp.mkdir(docsRoot, { recursive: true })
    await fsp.writeFile(
      path.join(docsRoot, 'manifested.md'),
      ['# Original Title', '', 'Body'].join('\n'),
      'utf8',
    )
    await fsp.writeFile(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          sections: [
            {
              id: 'manifested',
              title: 'Manifest Title',
              path: 'manifested.md',
              tags: ['manifest', 'docs'],
              use_cases: ['test manifest source'],
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    const { client } = await connectServer({
      docsRoot,
      docsManifestPath: manifestPath,
    })

    try {
      const sectionsResult = await client.callTool({
        name: 'list-sections',
        arguments: {},
      })

      const sections = Array.isArray(
        (sectionsResult.structuredContent as { sections?: unknown })?.sections,
      )
        ? ((
            sectionsResult.structuredContent as {
              sections: Array<{
                id: string
                title: string
                tags?: string[]
                use_cases?: string[]
              }>
            }
          ).sections ?? [])
        : []

      const manifested = sections.find(section => section.id === 'manifested')
      expect(manifested).toBeTruthy()
      expect(manifested?.title).toBe('Manifest Title')
      expect(manifested?.tags).toEqual(['manifest', 'docs'])
      expect(manifested?.use_cases).toEqual(['test manifest source'])
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('fails fast when explicit docs manifest is missing', async () => {
    const missingManifest = path.join(os.tmpdir(), `fict-mcp-missing-${Date.now()}.json`)

    expect(() =>
      createFictMcpServer({
        docsRoot: DOCS_ROOT,
        docsManifestPath: missingManifest,
      }),
    ).toThrow('Docs manifest not found')
  })

  it('fails fast when explicit docs manifest is invalid', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fict-mcp-manifest-invalid-'))
    const manifestPath = path.join(tempRoot, 'docs-manifest.json')

    await fsp.writeFile(manifestPath, '{ invalid json', 'utf8')

    try {
      expect(() =>
        createFictMcpServer({
          docsRoot: DOCS_ROOT,
          docsManifestPath: manifestPath,
        }),
      ).toThrow('Invalid docs manifest')
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('exposes docs tools and returns section content', async () => {
    const { client } = await connectServer()

    const tools = await client.listTools()
    const toolNames = tools.tools.map(tool => tool.name)
    expect(toolNames).toContain('list-sections')
    expect(toolNames).toContain('search-sections')
    expect(toolNames).toContain('get-documentation')

    const sectionsResult = await client.callTool({
      name: 'list-sections',
      arguments: {},
    })

    const sections = Array.isArray(
      (sectionsResult.structuredContent as { sections?: unknown })?.sections,
    )
      ? ((sectionsResult.structuredContent as { sections: Array<{ id: string }> }).sections ?? [])
      : []
    expect(sections.length).toBeGreaterThan(0)

    const firstId = sections[0]?.id
    expect(firstId).toBeTruthy()

    const docsResult = await client.callTool({
      name: 'get-documentation',
      arguments: {
        sections: [firstId],
        format: 'llms',
      },
    })

    const docs = Array.isArray((docsResult.structuredContent as { documents?: unknown })?.documents)
      ? ((docsResult.structuredContent as { documents: Array<{ content: string }> }).documents ??
        [])
      : []
    expect(docs[0]?.content?.length ?? 0).toBeGreaterThan(100)

    const truncatedDocsResult = await client.callTool({
      name: 'get-documentation',
      arguments: {
        sections: [firstId],
        format: 'llms',
        maxCharsPerDocument: 200,
      },
    })
    const truncatedDocs = Array.isArray(
      (truncatedDocsResult.structuredContent as { documents?: unknown })?.documents,
    )
      ? ((
          truncatedDocsResult.structuredContent as {
            documents: Array<{ content: string; truncated?: boolean; originalChars?: number }>
          }
        ).documents ?? [])
      : []
    expect(truncatedDocs[0]?.content?.length ?? 0).toBeLessThanOrEqual(200)
    expect(truncatedDocs[0]?.truncated).toBe(true)
    expect((truncatedDocs[0]?.originalChars ?? 0) > (truncatedDocs[0]?.content?.length ?? 0)).toBe(
      true,
    )

    const missingDocResult = await client.callTool({
      name: 'get-documentation',
      arguments: {
        sections: ['__missing_section__'],
      },
    })
    expect(missingDocResult.isError).toBe(true)
    const missingPayload = missingDocResult.structuredContent as {
      error?: string
      missing?: string[]
    }
    expect(missingPayload.error).toContain('Unknown section ids')
    expect(missingPayload.missing).toEqual(['__missing_section__'])

    const searchResult = await client.callTool({
      name: 'search-sections',
      arguments: {
        query: 'reactivity semantics',
      },
    })
    const matches = Array.isArray(
      (searchResult.structuredContent as { matches?: unknown })?.matches,
    )
      ? ((searchResult.structuredContent as { matches: Array<{ id: string }> }).matches ?? [])
      : []
    expect(matches.some(match => match.id === 'reactivity-semantics')).toBe(true)
  })

  it('returns both compiler and eslint issues from fict-autofixer', async () => {
    const { client } = await connectServer()

    const source = `
import { $state } from 'fict'
export function List({ items }) {
  const count = $state(items.length)
  return <ul>{items.map(item => <li>{item.name}</li>)}</ul>
}
`

    const result = await client.callTool({
      name: 'fict-autofixer',
      arguments: {
        files: {
          'src/List.tsx': source,
        },
      },
    })

    const issues = Array.isArray((result.structuredContent as { issues?: unknown })?.issues)
      ? ((result.structuredContent as { issues: Array<{ source: string; code: string }> }).issues ??
        [])
      : []

    const sources = new Set(issues.map(issue => issue.source))
    expect(sources.has('compiler')).toBe(true)
    expect(sources.has('eslint')).toBe(true)
    expect(issues.some(issue => issue.code === 'fict/require-list-key')).toBe(true)
  })

  it('returns input error when fict-autofixer entry is missing', async () => {
    const { client } = await connectServer()

    const result = await client.callTool({
      name: 'fict-autofixer',
      arguments: {
        entry: 'src/Missing.tsx',
        files: {
          'src/App.tsx':
            "import { $state } from 'fict'\\nexport default function App(){let c=$state(0);return <button>{c}</button>}\\n",
        },
      },
    })

    expect(result.isError).toBe(true)
    const issues = Array.isArray((result.structuredContent as { issues?: unknown })?.issues)
      ? ((result.structuredContent as { issues: Array<{ code: string; severity: string }> })
          .issues ?? [])
      : []
    expect(issues.some(issue => issue.code === 'FICT-MCP-ENTRY')).toBe(true)
    expect(issues.some(issue => issue.severity === 'error')).toBe(true)
  })

  it('returns stable severity-first ordering from fict-autofixer', async () => {
    const { client } = await connectServer()

    const result = await client.callTool({
      name: 'fict-autofixer',
      arguments: {
        files: {
          'src/App.tsx': `
import { $state } from 'fict'

export function App({ items }) {
  let count = $state(0)
  return (
    <ul onClick={() => count++}>
      {items.map(item => <li>{item.name}</li>)}
    </ul>
  )
}
`,
        },
      },
    })

    const issues = Array.isArray((result.structuredContent as { issues?: unknown })?.issues)
      ? ((result.structuredContent as { issues: Array<{ severity: string }> }).issues ?? [])
      : []

    const firstWarningIndex = issues.findIndex(issue => issue.severity === 'warning')
    const lastErrorIndex = [...issues].reverse().findIndex(issue => issue.severity === 'error')

    expect(firstWarningIndex).toBeGreaterThanOrEqual(0)
    expect(lastErrorIndex).toBeGreaterThanOrEqual(0)
    const actualLastErrorIndex = issues.length - 1 - lastErrorIndex
    expect(actualLastErrorIndex).toBeLessThan(firstWarningIndex)
  })

  it('creates a valid playground share link', async () => {
    const { client } = await connectServer()

    const templatesResult = await client.callTool({
      name: 'list-playground-templates',
      arguments: {},
    })
    const templates = Array.isArray(
      (templatesResult.structuredContent as { templates?: unknown })?.templates,
    )
      ? ((templatesResult.structuredContent as { templates: Array<{ id: string }> }).templates ??
        [])
      : []
    expect(templates.length).toBeGreaterThan(0)
    expect(templates.some(template => template.id === 'counter')).toBe(true)

    const result = await client.callTool({
      name: 'playground-link',
      arguments: {
        templateId: 'counter',
        files: {
          'src/App.tsx':
            "import { $state } from 'fict'\\nexport default function App(){let c=$state(0);return <button onClick={() => c++}>{c}</button>}\\n",
        },
      },
    })

    const payload = result.structuredContent as {
      url: string
      token: string
      size: { rawBytes: number; tokenChars: number }
    }

    expect(payload.url.startsWith('http://localhost:4173/?share=')).toBe(true)
    expect(payload.size.tokenChars).toBeGreaterThan(10)
    expect(payload.size.rawBytes).toBeGreaterThan(100)

    const snapshot = decodeSessionSnapshot(payload.token)
    expect(snapshot.templateId).toBe('counter')
    expect(snapshot.files['src/App.tsx']).toContain('$state')
  })

  it('returns structured error for unknown playground template', async () => {
    const { client } = await connectServer()

    const result = await client.callTool({
      name: 'playground-link',
      arguments: {
        templateId: '__missing_template__',
      },
    })

    expect(result.isError).toBe(true)

    const payload = result.structuredContent as {
      error?: string
      available?: Array<{ id: string; name: string }>
    }

    expect(payload.error).toContain('Unknown templateId')
    expect(payload.available?.length ?? 0).toBeGreaterThan(0)
    expect(payload.available?.some(template => template.id === 'counter')).toBe(true)
  })

  it('rejects conflicting streamable http paths', async () => {
    await expect(
      startStreamableHttpServer({
        docsRoot: DOCS_ROOT,
        host: '127.0.0.1',
        port: 0,
        path: '/mcp',
        healthPath: '/mcp',
        statsPath: '/stats',
      }),
    ).rejects.toThrow('HTTP paths must be distinct')
  })

  it('rejects conflicting sse http paths', async () => {
    await expect(
      startSseHttpServer({
        docsRoot: DOCS_ROOT,
        host: '127.0.0.1',
        port: 0,
        ssePath: '/sse',
        messagesPath: '/messages',
        healthPath: '/sse',
        statsPath: '/stats',
      }),
    ).rejects.toThrow('SSE HTTP paths must be distinct')
  })

  it('fails fast for invalid docs root in streamable http startup', async () => {
    await expect(
      startStreamableHttpServer({
        docsRoot: path.join(os.tmpdir(), 'fict-mcp-missing-docs-root'),
        host: '127.0.0.1',
        port: 0,
        path: '/mcp',
        healthPath: '/healthz',
        statsPath: '/stats',
      }),
    ).rejects.toThrow('Docs root not found')
  })

  it('supports streamable http transport', async () => {
    const started = await startStreamableHttpServer({
      docsRoot: DOCS_ROOT,
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      healthPath: '/healthz',
      statsPath: '/stats',
    })

    const transport = new StreamableHTTPClientTransport(new URL(started.url))
    const client = new Client({ name: 'mcp-http-test-client', version: '0.0.0' })

    try {
      await client.connect(transport)

      const tools = await client.listTools()
      expect(tools.tools.some(tool => tool.name === 'list-sections')).toBe(true)

      const sections = await client.callTool({
        name: 'list-sections',
        arguments: {},
      })

      const count = Array.isArray((sections.structuredContent as { sections?: unknown })?.sections)
        ? ((sections.structuredContent as { sections: unknown[] }).sections ?? []).length
        : 0
      expect(count).toBeGreaterThan(0)

      const healthRes = await fetch(started.healthUrl)
      expect(healthRes.status).toBe(200)
      const health = (await healthRes.json()) as {
        ok: boolean
        stats: { activeSessions: number }
      }
      expect(health.ok).toBe(true)
      expect(health.stats.activeSessions).toBeGreaterThan(0)

      const statsRes = await fetch(started.statsUrl)
      expect(statsRes.status).toBe(200)
      const stats = (await statsRes.json()) as {
        requestsTotal: number
        sessions: { active: number }
      }
      expect(stats.requestsTotal).toBeGreaterThan(0)
      expect(stats.sessions.active).toBeGreaterThan(0)
    } finally {
      await client.close()
      await started.close()
    }
  })

  it('supports legacy sse transport', async () => {
    const started = await startSseHttpServer({
      docsRoot: DOCS_ROOT,
      host: '127.0.0.1',
      port: 0,
      ssePath: '/sse',
      messagesPath: '/messages',
      healthPath: '/healthz',
      statsPath: '/stats',
    })

    const transport = new SSEClientTransport(new URL(started.url))
    const client = new Client({ name: 'mcp-sse-test-client', version: '0.0.0' })

    try {
      await client.connect(transport)

      const tools = await client.listTools()
      expect(tools.tools.some(tool => tool.name === 'list-sections')).toBe(true)

      const sections = await client.callTool({
        name: 'list-sections',
        arguments: {},
      })

      const count = Array.isArray((sections.structuredContent as { sections?: unknown })?.sections)
        ? ((sections.structuredContent as { sections: unknown[] }).sections ?? []).length
        : 0
      expect(count).toBeGreaterThan(0)

      const healthRes = await fetch(started.healthUrl)
      expect(healthRes.status).toBe(200)

      const statsRes = await fetch(started.statsUrl)
      expect(statsRes.status).toBe(200)
      const stats = (await statsRes.json()) as {
        requestsTotal: number
        sessions: { active: number }
      }
      expect(stats.requestsTotal).toBeGreaterThan(0)
      expect(stats.sessions.active).toBeGreaterThan(0)
    } finally {
      await client.close()
      await started.close()
    }
  })
})
