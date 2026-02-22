import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { DocsStore } from '../store/docsStore'

export function registerDocsResources(server: McpServer, docs: DocsStore): void {
  for (const section of docs.sections) {
    const uri = `fict://doc/${encodeURIComponent(section.id)}`

    server.registerResource(
      `doc:${section.id}`,
      uri,
      {
        title: section.title,
        description: 'Fict documentation section (normalized markdown)',
        mimeType: 'text/markdown',
      },
      async () => {
        const text = await docs.readFormatted(section.id, 'llms')
        return {
          contents: [{ uri, mimeType: 'text/markdown', text }],
        }
      },
    )
  }
}
