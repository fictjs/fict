import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { DocsStore } from '../store/docsStore'

export function registerDocsTools(server: McpServer, docs: DocsStore): void {
  server.registerTool(
    'list-sections',
    {
      title: 'List documentation sections',
      description:
        'List all available Fict documentation sections. Use this tool to discover doc ids before reading sections.',
      outputSchema: {
        sections: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            path: z.string(),
            use_cases: z.array(z.string()).optional(),
            tags: z.array(z.string()).optional(),
          }),
        ),
      },
    },
    async () => {
      const output = { sections: docs.sections }
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      }
    },
  )

  server.registerTool(
    'get-documentation',
    {
      title: 'Get documentation sections',
      description:
        'Read one or more documentation sections by id. Prefer requesting only sections relevant to the current task.',
      inputSchema: {
        sections: z.array(z.string()).min(1).describe('Section ids returned by list-sections'),
        format: z
          .enum(['md', 'llms'])
          .optional()
          .describe('md = raw markdown, llms = normalized markdown. Default: llms.'),
      },
      outputSchema: {
        documents: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            format: z.string(),
            content: z.string(),
          }),
        ),
      },
    },
    async ({ sections, format }) => {
      const mode: 'md' | 'llms' = format ?? 'llms'
      const missing = sections.filter(id => !docs.get(id))

      if (missing.length > 0) {
        const output = {
          error: `Unknown section ids: ${missing.join(', ')}`,
          missing,
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
          isError: true,
        }
      }

      const documents = await Promise.all(
        sections.map(async id => {
          const section = docs.get(id)
          if (!section) {
            throw new Error(`Unknown section: ${id}`)
          }

          return {
            id,
            title: section.title,
            format: mode,
            content: await docs.readFormatted(id, mode),
          }
        }),
      )

      const output = { documents }
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      }
    },
  )
}
