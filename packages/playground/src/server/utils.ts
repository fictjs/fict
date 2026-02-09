import { createHash, randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'

export function createSessionId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true })
}

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}

export function normalizeRelativeFilePath(input: string): string {
  const trimmed = input.trim().replace(/^\.\//, '')
  if (!trimmed) {
    throw new Error('File path cannot be empty')
  }

  const normalized = toPosixPath(path.posix.normalize(trimmed))

  if (normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/')) {
    throw new Error('Path traversal is not allowed')
  }

  return normalized
}

export function resolveSessionFilePath(sessionRoot: string, relativePath: string): string {
  const safeRelativePath = normalizeRelativeFilePath(relativePath)
  const absolute = path.resolve(sessionRoot, safeRelativePath)
  const rootWithSep = `${path.resolve(sessionRoot)}${path.sep}`
  if (absolute !== path.resolve(sessionRoot) && !absolute.startsWith(rootWithSep)) {
    throw new Error('File path escapes session root')
  }
  return absolute
}

export async function writeProjectFiles(
  rootDir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = resolveSessionFilePath(rootDir, relativePath)
    await ensureDir(path.dirname(absolutePath))
    await fs.writeFile(absolutePath, content, 'utf8')
  }
}

export async function readProjectFiles(rootDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const absolutePath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      const relativePath = toPosixPath(path.relative(rootDir, absolutePath))
      files[relativePath] = await fs.readFile(absolutePath, 'utf8')
    }
  }

  await walk(rootDir)
  return files
}

export async function listSourceFiles(rootDir: string): Promise<string[]> {
  const files: string[] = []
  const sourceExtensions = new Set(['.tsx', '.jsx', '.ts', '.js'])

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const absolutePath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      if (!sourceExtensions.has(path.extname(entry.name))) continue
      files.push(absolutePath)
    }
  }

  const srcDir = path.join(rootDir, 'src')
  if (existsSync(srcDir)) {
    await walk(srcDir)
  }

  files.sort((a, b) => a.localeCompare(b))
  return files
}

export function relativeToRoot(rootDir: string, absolutePath: string): string {
  return toPosixPath(path.relative(rootDir, absolutePath))
}

export function findWorkspaceRoot(startDir: string): string {
  let currentDir = path.resolve(startDir)

  while (true) {
    if (existsSync(path.join(currentDir, 'pnpm-workspace.yaml'))) {
      return currentDir
    }

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) {
      return path.resolve(startDir)
    }
    currentDir = parentDir
  }
}
