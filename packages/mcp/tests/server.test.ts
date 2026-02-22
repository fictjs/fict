import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeSessionSnapshot } from '@fictjs/playground'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'

import { createFictMcpServer } from '../src/index'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DOCS_ROOT = path.resolve(__dirname, '../../../docs')

interface ConnectedContext {
  client: Client
  close: () => Promise<void>
}

const activeConnections: ConnectedContext[] = []

async function connectServer(): Promise<ConnectedContext> {
  const { server } = createFictMcpServer({
    docsRoot: DOCS_ROOT,
    playgroundOrigin: 'http://localhost:4173',
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
  it('exposes docs tools and returns section content', async () => {
    const { client } = await connectServer()

    const tools = await client.listTools()
    const toolNames = tools.tools.map(tool => tool.name)
    expect(toolNames).toContain('list-sections')
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

  it('creates a valid playground share link', async () => {
    const { client } = await connectServer()

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
})
