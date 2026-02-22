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

const sections = walk(docsRoot)
  .filter(filePath => filePath.toLowerCase().endsWith('.md'))
  .sort((left, right) => left.localeCompare(right))
  .map(filePath => {
    const relativePath = toPosix(path.relative(docsRoot, filePath))
    const relativeNoExt = relativePath.replace(/\.md$/i, '')
    const markdown = fs.readFileSync(filePath, 'utf8')
    const title = extractTitle(markdown, path.basename(relativeNoExt))

    return {
      id: deriveSectionId(relativeNoExt),
      title,
      relPath: relativePath,
    }
  })

const availableDocsBlockLines = sections.map(section => `- ${section.id} — ${section.title}`)
const availableDocsBlock = `<available-docs>\n${availableDocsBlockLines.join('\n')}\n</available-docs>`

const outFile = path.join(packageRoot, 'src', 'prompts', 'available-docs.generated.ts')
fs.mkdirSync(path.dirname(outFile), { recursive: true })

const header = `/* eslint-disable */
/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 *
 * Regenerate with: pnpm --filter @fictjs/mcp build:assets
 */
`

const body = `${header}

export const AVAILABLE_DOCS = ${JSON.stringify(sections, null, 2)} as const

export const AVAILABLE_DOCS_BLOCK = ${JSON.stringify(availableDocsBlock)}
`

fs.writeFileSync(outFile, body)

process.stdout.write(
  `Generated: ${path.relative(workspaceRoot, outFile)} (docs: ${sections.length})\n`,
)
