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

const USE_CASES_BY_SLUG: Record<string, string[]> = {
  fict: ['Framework overview and mental model'],
  architecture: ['Architecture and compiler/runtime flow'],
  'compiler-spec': ['Compiler semantics for $state/$effect and transforms'],
  'diagnostic-codes': ['Diagnostic code reference and remediation'],
  'eslint-rules': ['Lint rule expectations and examples'],
  'config-profiles': ['Strictness profile selection'],
  'ssr-deployment': ['SSR deployment and constraints'],
  'reactivity-semantics': ['Reactivity guarantees and caveats'],
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
      const title = extractTitle(markdown, path.basename(relativeNoExt))
      const slug = path.basename(relativeNoExt)

      const entry: DocSection = {
        id: deriveSectionId(relativeNoExt),
        title,
        path: relativePath,
      }

      const useCases = USE_CASES_BY_SLUG[slug]
      if (useCases) {
        entry.use_cases = useCases
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
