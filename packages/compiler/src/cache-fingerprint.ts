import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
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

  try {
    return readFileSync(modulePath, 'utf8')
  } catch {
    return null
  }
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
