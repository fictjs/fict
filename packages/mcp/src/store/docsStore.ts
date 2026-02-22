import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { splitFrontmatter } from './frontmatter'
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
  manifestPath?: string
}

interface DocDefaultMetadata {
  tags?: string[]
  use_cases?: string[]
}

interface DocsManifest {
  version: number
  sections: unknown
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

function buildSectionFromMarkdown(root: string, filePath: string): DocSection {
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

  const tags = frontmatterMetadata.tags?.length ? frontmatterMetadata.tags : defaultMetadata?.tags
  if (tags) {
    entry.tags = tags
  }

  return entry
}

function scanSections(root: string): DocSection[] {
  return walk(root)
    .filter(filePath => filePath.toLowerCase().endsWith('.md'))
    .sort((left, right) => left.localeCompare(right))
    .map(filePath => buildSectionFromMarkdown(root, filePath))
}

function toDocSection(entry: unknown): DocSection | null {
  if (!entry || typeof entry !== 'object') return null
  const raw = entry as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.path !== 'string') {
    return null
  }

  const section: DocSection = {
    id: raw.id,
    title: raw.title,
    path: raw.path,
  }

  if (Array.isArray(raw.use_cases)) {
    const useCases = raw.use_cases.filter(item => typeof item === 'string')
    if (useCases.length > 0) section.use_cases = useCases
  }

  if (Array.isArray(raw.tags)) {
    const tags = raw.tags.filter(item => typeof item === 'string')
    if (tags.length > 0) section.tags = tags
  }

  return section
}

function loadSectionsFromManifest(root: string, manifestPath: string): DocSection[] | null {
  if (!fs.existsSync(manifestPath)) return null

  let manifestJson: unknown
  try {
    manifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }

  if (!manifestJson || typeof manifestJson !== 'object') return null
  const manifest = manifestJson as DocsManifest
  if (!Array.isArray(manifest.sections)) return null

  const sections = manifest.sections
    .map(section => toDocSection(section))
    .filter((section): section is DocSection => section !== null)
    .sort((left, right) => left.path.localeCompare(right.path))

  if (sections.length === 0) return null

  const allFilesExist = sections.every(section => fs.existsSync(path.join(root, section.path)))
  if (!allFilesExist) return null

  return sections
}

export function createDocsStore(options: CreateDocsStoreOptions): DocsStore {
  const root = path.resolve(options.docsRoot)
  if (!fs.existsSync(root)) {
    throw new Error(`Docs root not found: ${root}`)
  }

  const manifestPath = options.manifestPath ? path.resolve(options.manifestPath) : undefined
  const manifestSections = manifestPath ? loadSectionsFromManifest(root, manifestPath) : null
  const sections = manifestSections ?? scanSections(root)

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
