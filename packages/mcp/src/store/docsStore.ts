import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { toLlmsMarkdown } from './llms'

export interface DocSection {
  id: string
  title: string
  path: string
  use_cases?: string[]
  tags?: string[]
}

export interface DocsStore {
  root: string
  sections: DocSection[]
  get(id: string): DocSection | undefined
  read(sectionId: string): Promise<string>
  readFormatted(sectionId: string, format: 'md' | 'llms'): Promise<string>
}

interface CreateDocsStoreOptions {
  docsRoot: string
}

interface DocFrontmatterMetadata {
  title?: string
  tags?: string[]
  use_cases?: string[]
}

interface DocDefaultMetadata {
  tags?: string[]
  use_cases?: string[]
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const results: string[] = []

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...walk(full))
      continue
    }
    results.push(full)
  }

  return results
}

function deriveSectionId(relativeNoExt: string): string {
  return relativeNoExt.replace(/\//g, '__')
}

function extractTitle(markdown: string, fallback: string): string {
  const lines = markdown.split(/\r?\n/)
  for (const line of lines.slice(0, 40)) {
    const match = line.match(/^#\s+(.+)$/)
    const title = match?.[1]
    if (title) return title.trim()
  }
  return fallback
}

const DEFAULT_METADATA_BY_SLUG: Record<string, DocDefaultMetadata> = {
  fict: {
    use_cases: ['Framework overview and mental model'],
    tags: ['framework', 'overview'],
  },
  architecture: {
    use_cases: ['Architecture and compiler/runtime flow'],
    tags: ['architecture', 'compiler', 'runtime'],
  },
  'compiler-spec': {
    use_cases: ['Compiler semantics for $state/$effect and transforms'],
    tags: ['compiler', 'spec'],
  },
  'diagnostic-codes': {
    use_cases: ['Diagnostic code reference and remediation'],
    tags: ['diagnostics', 'compiler'],
  },
  'eslint-rules': {
    use_cases: ['Lint rule expectations and examples'],
    tags: ['eslint', 'lint'],
  },
  'config-profiles': {
    use_cases: ['Strictness profile selection'],
    tags: ['config', 'profiles'],
  },
  'ssr-deployment': {
    use_cases: ['SSR deployment and constraints'],
    tags: ['ssr', 'deployment'],
  },
  'reactivity-semantics': {
    use_cases: ['Reactivity guarantees and caveats'],
    tags: ['reactivity', 'compiler'],
  },
}

function stripWrappedQuotes(text: string): string {
  const trimmed = text.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function parseInlineList(rawValue: string): string[] {
  const trimmed = rawValue.trim()
  if (!trimmed) return []

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1)
    return inner
      .split(',')
      .map(item => stripWrappedQuotes(item))
      .filter(Boolean)
  }

  if (trimmed.includes(',')) {
    return trimmed
      .split(',')
      .map(item => stripWrappedQuotes(item))
      .filter(Boolean)
  }

  return [stripWrappedQuotes(trimmed)]
}

function parseFrontmatterMetadata(frontmatter: string): DocFrontmatterMetadata {
  const metadata: DocFrontmatterMetadata = {}
  const lines = frontmatter.split(/\r?\n/)
  let activeListKey: 'tags' | 'use_cases' | null = null

  for (const line of lines) {
    const listItemMatch = line.match(/^\s*-\s+(.+)$/)
    if (listItemMatch && activeListKey) {
      const value = stripWrappedQuotes(listItemMatch[1])
      if (!value) continue
      const nextList = metadata[activeListKey] ?? []
      nextList.push(value)
      metadata[activeListKey] = nextList
      continue
    }

    const keyValueMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!keyValueMatch) {
      activeListKey = null
      continue
    }

    const key = keyValueMatch[1]
    const rawValue = keyValueMatch[2].trim()

    if (key === 'title') {
      if (rawValue) {
        metadata.title = stripWrappedQuotes(rawValue)
      }
      activeListKey = null
      continue
    }

    if (key === 'tags' || key === 'use_cases') {
      if (!rawValue) {
        metadata[key] = metadata[key] ?? []
        activeListKey = key
      } else {
        const values = parseInlineList(rawValue)
        if (values.length > 0) {
          metadata[key] = values
        }
        activeListKey = null
      }
      continue
    }

    activeListKey = null
  }

  return metadata
}

function splitFrontmatter(markdown: string): { body: string; metadata: DocFrontmatterMetadata } {
  if (!markdown.startsWith('---')) {
    return {
      body: markdown,
      metadata: {},
    }
  }

  const lines = markdown.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    return {
      body: markdown,
      metadata: {},
    }
  }

  let endIndex = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === '---') {
      endIndex = i
      break
    }
  }

  if (endIndex === -1) {
    return {
      body: markdown,
      metadata: {},
    }
  }

  const frontmatter = lines.slice(1, endIndex).join('\n')
  const body = lines.slice(endIndex + 1).join('\n')

  return {
    body,
    metadata: parseFrontmatterMetadata(frontmatter),
  }
}

export function createDocsStore(options: CreateDocsStoreOptions): DocsStore {
  const root = path.resolve(options.docsRoot)
  if (!fs.existsSync(root)) {
    throw new Error(`Docs root not found: ${root}`)
  }

  const sections = walk(root)
    .filter(filePath => filePath.toLowerCase().endsWith('.md'))
    .sort((left, right) => left.localeCompare(right))
    .map(filePath => {
      const relativePath = toPosix(path.relative(root, filePath))
      const relativeNoExt = relativePath.replace(/\.md$/i, '')
      const markdown = fs.readFileSync(filePath, 'utf8')
      const { body, metadata: frontmatterMetadata } = splitFrontmatter(markdown)
      const title = frontmatterMetadata.title ?? extractTitle(body, path.basename(relativeNoExt))
      const slug = path.basename(relativeNoExt)
      const defaultMetadata = DEFAULT_METADATA_BY_SLUG[slug]

      const entry: DocSection = {
        id: deriveSectionId(relativeNoExt),
        title,
        path: relativePath,
      }

      const useCases = frontmatterMetadata.use_cases?.length
        ? frontmatterMetadata.use_cases
        : defaultMetadata?.use_cases
      if (useCases) {
        entry.use_cases = useCases
      }

      const tags = frontmatterMetadata.tags?.length
        ? frontmatterMetadata.tags
        : defaultMetadata?.tags
      if (tags) {
        entry.tags = tags
      }

      return entry
    })

  const sectionMap = new Map(sections.map(section => [section.id, section] as const))

  async function read(sectionId: string): Promise<string> {
    const section = sectionMap.get(sectionId)
    if (!section) {
      throw new Error(`Unknown documentation section: ${sectionId}`)
    }
    return fsp.readFile(path.join(root, section.path), 'utf8')
  }

  async function readFormatted(sectionId: string, format: 'md' | 'llms'): Promise<string> {
    const markdown = await read(sectionId)
    return format === 'llms' ? toLlmsMarkdown(markdown) : markdown
  }

  return {
    root,
    sections,
    get: (id: string) => sectionMap.get(id),
    read,
    readFormatted,
  }
}
