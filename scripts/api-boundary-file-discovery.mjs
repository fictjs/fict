import { execFileSync } from 'node:child_process'
import { readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'

const ignoredDirectories = new Set([
  '.cache',
  '.git',
  '.hg',
  '.next',
  '.pnpm-store',
  '.svn',
  '.turbo',
  '.vitepress',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'tmp',
  'vendor',
])

function gitTrackedFiles(root) {
  try {
    const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (realpathSync(repositoryRoot) !== realpathSync(root)) return null

    const output = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const files = output.split('\0').filter(Boolean)
    return files.length > 0 ? files.sort() : null
  } catch {
    return null
  }
}

function filesystemFiles(root) {
  const files = []

  function walk(directory, relativeDirectory = '') {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue

      const absolutePath = path.join(directory, entry.name)
      const relativePath = path.join(relativeDirectory, entry.name)
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath)
      } else if (entry.isFile()) {
        files.push(relativePath.split(path.sep).join('/'))
      }
    }
  }

  walk(root)
  return files
}

export function discoverRepositoryFiles(root) {
  const trackedFiles = gitTrackedFiles(root)
  if (trackedFiles) {
    return { files: trackedFiles, source: 'git' }
  }

  let files
  try {
    files = filesystemFiles(root)
  } catch (error) {
    throw new Error(
      `could not enumerate source files without Git: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  if (files.length === 0) {
    throw new Error('could not enumerate source files without Git: repository is empty')
  }
  return { files, source: 'filesystem' }
}
