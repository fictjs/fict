import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { DocsStore } from '../store/docsStore'

export function registerDocsResources(server: McpServer, docs: DocsStore): void {
  const template = new ResourceTemplate('fict://doc/{sectionId}', {
    list: async () => ({
      resources: docs.sections.map(section => ({
        name: `doc:${section.id}`,
        uri: `fict://doc/${encodeURIComponent(section.id)}`,
        title: section.title,
        description: 'Fict documentation section (normalized markdown)',
        mimeType: 'text/markdown',
      })),
    }),
    complete: {
      sectionId: value =>
        docs.sections
          .map(section => section.id)
          .filter(id => id.startsWith(value))
          .slice(0, 50),
    },
  })

  server.registerResource(
    'doc-section',
    template,
    {
      title: 'Fict Documentation Section',
      description: 'Read one section from the local docs corpus',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const rawSectionId = variables.sectionId
      const sectionId = Array.isArray(rawSectionId) ? rawSectionId[0] : rawSectionId
      const decodedSectionId = sectionId ? decodeURIComponent(sectionId) : undefined

      if (!decodedSectionId) {
        throw new Error('Missing required variable: sectionId')
      }

      const section = docs.get(decodedSectionId)
      if (!section) {
        throw new Error(`Unknown documentation section: ${decodedSectionId}`)
      }

      const text = await docs.readFormatted(decodedSectionId, 'llms')

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'text/markdown',
            text,
          },
        ],
      }
    },
  )
}
