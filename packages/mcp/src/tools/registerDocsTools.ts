import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { DocsStore } from '../store/docsStore'

interface SectionSearchMatch {
  id: string
  title: string
  path: string
  score: number
  reason: string
  use_cases?: string[]
  tags?: string[]
}

function toSearchText(section: {
  id: string
  title: string
  path: string
  use_cases?: string[]
  tags?: string[]
}): string {
  return [
    section.id,
    section.title,
    section.path,
    ...(section.use_cases ?? []),
    ...(section.tags ?? []),
  ]
    .join(' ')
    .toLowerCase()
}

function scoreSection(
  section: {
    id: string
    title: string
    path: string
    use_cases?: string[]
    tags?: string[]
  },
  query: string,
): SectionSearchMatch | null {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return null

  const id = section.id.toLowerCase()
  const title = section.title.toLowerCase()
  const path = section.path.toLowerCase()
  const haystack = toSearchText(section)

  let score = 0
  const reasons: string[] = []

  if (id === normalizedQuery) {
    score += 120
    reasons.push('id-exact')
  } else if (id.startsWith(normalizedQuery)) {
    score += 85
    reasons.push('id-prefix')
  } else if (id.includes(normalizedQuery)) {
    score += 60
    reasons.push('id-contains')
  }

  if (title.includes(normalizedQuery)) {
    score += 55
    reasons.push('title-contains')
  }

  if (path.includes(normalizedQuery)) {
    score += 45
    reasons.push('path-contains')
  }

  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean)
  let matchedTokens = 0
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      matchedTokens += 1
    }
  }
  if (matchedTokens > 0) {
    score += matchedTokens * 10
    reasons.push(`token:${matchedTokens}/${queryTokens.length}`)
  }

  if (score <= 0) return null

  return {
    id: section.id,
    title: section.title,
    path: section.path,
    score,
    reason: reasons.join(','),
    use_cases: section.use_cases,
    tags: section.tags,
  }
}

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
    'search-sections',
    {
      title: 'Search documentation sections',
      description:
        'Search documentation sections by keywords and return the most relevant section ids.',
      inputSchema: {
        query: z.string().min(1).describe('Keyword query, e.g. "reactivity semantics"'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Maximum number of matches to return. Default: 8.'),
      },
      outputSchema: {
        query: z.string(),
        matches: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            path: z.string(),
            score: z.number(),
            reason: z.string(),
            use_cases: z.array(z.string()).optional(),
            tags: z.array(z.string()).optional(),
          }),
        ),
      },
    },
    async ({ query, limit }) => {
      const maxResults = limit ?? 8

      const matches = docs.sections
        .map(section => scoreSection(section, query))
        .filter((item): item is SectionSearchMatch => item !== null)
        .sort((left, right) => right.score - left.score)
        .slice(0, maxResults)

      const output = {
        query,
        matches,
      }

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
        documents: z
          .array(
            z.object({
              id: z.string(),
              title: z.string(),
              format: z.string(),
              content: z.string(),
            }),
          )
          .optional(),
        error: z.string().optional(),
        missing: z.array(z.string()).optional(),
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
