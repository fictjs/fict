import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function createVitePluginCacheFingerprint(fallbackParts: readonly string[]): string {
  const artifact = readLoadedPluginArtifact()
  if (artifact) {
    return hashCacheFingerprint(['fict-vite-plugin-cache-v1', artifact].join('|'))
  }

  return hashCacheFingerprint(
    ['fict-vite-plugin-cache-v1', 'artifact-unavailable', ...fallbackParts].join('|'),
  )
}

export function readLoadedPluginArtifact(stack = new Error().stack): string | null {
  const modulePath = getLoadedModulePathFromStack(stack)
  if (!modulePath) return null

  const remappedArtifact = readSourceMapRemappedDistArtifacts(modulePath)
  if (remappedArtifact) return remappedArtifact

  return readText(modulePath)
}

export function hashCacheFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
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
  if (sourceFile !== 'cache-fingerprint.ts' && sourceFile !== 'index.ts') return null

  const packageRoot = modulePath.slice(0, srcIndex)
  const artifacts = [
    path.join(packageRoot, 'src', 'index.ts'),
    path.join(packageRoot, 'src', 'cache-fingerprint.ts'),
    path.join(packageRoot, 'dist', 'index.js'),
    path.join(packageRoot, 'dist', 'index.cjs'),
  ]
    .map(filePath => {
      const content = readText(filePath)
      return content ? `${path.basename(filePath)}\n${content}` : null
    })
    .filter((content): content is string => content !== null)

  return artifacts.length > 0 ? artifacts.join('\n') : null
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
