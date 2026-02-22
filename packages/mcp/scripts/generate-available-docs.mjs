import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const packageRoot = path.resolve(__dirname, '..')
const workspaceRoot = path.resolve(packageRoot, '../..')
const docsRoot = process.env.FICT_MCP_DOCS_ROOT
  ? path.resolve(process.env.FICT_MCP_DOCS_ROOT)
  : path.join(workspaceRoot, 'docs')

if (!fs.existsSync(docsRoot)) {
  throw new Error(`Docs root not found: ${docsRoot}`)
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const results = []

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...walk(full))
    } else {
      results.push(full)
    }
  }

  return results
}

function toPosix(filePath) {
  return filePath.split(path.sep).join('/')
}

function deriveSectionId(relativeNoExt) {
  return relativeNoExt.replace(/\//g, '__')
}

function extractTitle(markdown, fallback) {
  const lines = markdown.split(/\r?\n/)

  for (const line of lines.slice(0, 40)) {
    const match = line.match(/^#\s+(.+)$/)
    if (match) return match[1].trim()
  }

  return fallback
}

const DEFAULT_METADATA_BY_SLUG = {
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

function stripWrappedQuotes(text) {
  const trimmed = text.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function parseInlineList(rawValue) {
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

function parseFrontmatterMetadata(frontmatter) {
  const metadata = {}
  const lines = frontmatter.split(/\r?\n/)
  let activeListKey = null

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

function splitFrontmatter(markdown) {
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

const sections = walk(docsRoot)
  .filter(filePath => filePath.toLowerCase().endsWith('.md'))
  .sort((left, right) => left.localeCompare(right))
  .map(filePath => {
    const relativePath = toPosix(path.relative(docsRoot, filePath))
    const relativeNoExt = relativePath.replace(/\.md$/i, '')
    const slug = path.basename(relativeNoExt)
    const markdown = fs.readFileSync(filePath, 'utf8')
    const { body, metadata: frontmatterMetadata } = splitFrontmatter(markdown)
    const defaults = DEFAULT_METADATA_BY_SLUG[slug]
    const title = frontmatterMetadata.title ?? extractTitle(body, path.basename(relativeNoExt))
    const useCases = frontmatterMetadata.use_cases?.length
      ? frontmatterMetadata.use_cases
      : defaults?.use_cases
    const tags = frontmatterMetadata.tags?.length ? frontmatterMetadata.tags : defaults?.tags

    return {
      id: deriveSectionId(relativeNoExt),
      title,
      relPath: relativePath,
      ...(useCases?.length ? { use_cases: useCases } : {}),
      ...(tags?.length ? { tags } : {}),
    }
  })

const availableDocsBlockLines = sections.map(section => `- ${section.id} — ${section.title}`)
const availableDocsBlock = `<available-docs>\n${availableDocsBlockLines.join('\n')}\n</available-docs>`

const outFile = path.join(packageRoot, 'src', 'prompts', 'available-docs.generated.ts')
fs.mkdirSync(path.dirname(outFile), { recursive: true })

const header = `/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 *
 * Regenerate with: pnpm --filter @fictjs/mcp build:assets
 */
`

const promptDocs = sections.map(section => ({
  id: section.id,
  title: section.title,
  relPath: section.relPath,
}))

const body = `${header}

export const AVAILABLE_DOCS = ${JSON.stringify(promptDocs, null, 2)} as const

export const AVAILABLE_DOCS_BLOCK = ${JSON.stringify(availableDocsBlock)}
`

fs.writeFileSync(outFile, body)

const manifestFile = path.join(packageRoot, 'assets', 'docs-manifest.json')
fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
const manifest = {
  version: 1,
  sections: sections.map(section => ({
    id: section.id,
    title: section.title,
    path: section.relPath,
    ...(section.use_cases ? { use_cases: section.use_cases } : {}),
    ...(section.tags ? { tags: section.tags } : {}),
  })),
}
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

process.stdout.write(
  `Generated: ${path.relative(workspaceRoot, outFile)} (docs: ${sections.length})\n`,
)
process.stdout.write(`Generated: ${path.relative(workspaceRoot, manifestFile)}\n`)
