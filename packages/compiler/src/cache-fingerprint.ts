import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function createCompilerCacheFingerprint(fallbackParts: readonly string[]): string {
  const artifact = readLoadedCompilerArtifact()
  if (artifact) {
    return hashCompilerFingerprint(['fict-compiler-cache-v2', artifact].join('|'))
  }

  return hashCompilerFingerprint(
    ['fict-compiler-cache-v2', 'artifact-unavailable', ...fallbackParts].join('|'),
  )
}

export function readLoadedCompilerArtifact(stack = new Error().stack): string | null {
  const modulePath = getLoadedModulePathFromStack(stack)
  if (!modulePath) return null

  const remappedArtifact = readSourceMapRemappedDistArtifacts(modulePath)
  if (remappedArtifact) return remappedArtifact

  return readText(modulePath)
}

function readText(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

function readSourceMapRemappedDistArtifacts(modulePath: string): string | null {
  const normalized = modulePath.replace(/\\/g, '/')
  const srcMarker = '/src/'
  const srcIndex = normalized.lastIndexOf(srcMarker)
  if (srcIndex === -1) return null

  const sourceFile = normalized.slice(srcIndex + srcMarker.length)
  if (!/\.(?:d\.)?tsx?$/.test(sourceFile)) return null

  const packageRoot = modulePath.slice(0, srcIndex)
  const sourceRoot = path.join(packageRoot, 'src')
  const sourceArtifacts = collectCompilerSourceFiles(sourceRoot).map(filePath =>
    readArtifactWithRelativePath(packageRoot, filePath),
  )
  const distArtifacts = [
    path.join(packageRoot, 'dist', 'index.js'),
    path.join(packageRoot, 'dist', 'index.cjs'),
  ]
    .map(filePath => readArtifactWithRelativePath(packageRoot, filePath))
    .filter((content): content is string => content !== null)
  const artifacts = [...sourceArtifacts, ...distArtifacts]

  return artifacts.length > 0 ? artifacts.join('\n') : null
}

function readArtifactWithRelativePath(packageRoot: string, filePath: string): string | null {
  const content = readText(filePath)
  if (content === null) return null
  const relativePath = path.relative(packageRoot, filePath).replace(/\\/g, '/')
  return `${relativePath}\n${content}`
}

function collectCompilerSourceFiles(sourceRoot: string): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(entryPath)
      } else if (entry.isFile() && /\.(?:d\.)?tsx?$/.test(entry.name)) {
        files.push(entryPath)
      }
    }
  }
  visit(sourceRoot)
  return files.sort((a, b) => a.localeCompare(b))
}

export function getLoadedModulePathFromStack(stack: string | undefined): string | null {
  if (!stack) return null

  for (const line of stack.split('\n')) {
    const candidate = extractStackPath(line)
    if (!candidate || candidate.startsWith('node:')) continue

    try {
      return candidate.startsWith('file://') ? fileURLToPath(candidate) : candidate
    } catch {
      return null
    }
  }

  return null
}

export function hashCompilerFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function extractStackPath(line: string): string | null {
  const patterns = [
    /(?:\(|\s)(file:\/\/\/.+?):\d+:\d+(?:\)|$)/,
    /(?:\(|\s)([A-Za-z]:[\\/].+?):\d+:\d+(?:\)|$)/,
    /(?:\(|\s)(\/.+?):\d+:\d+(?:\)|$)/,
  ]

  for (const pattern of patterns) {
    const match = line.match(pattern)
    if (match?.[1]) return match[1]
  }

  return null
}
