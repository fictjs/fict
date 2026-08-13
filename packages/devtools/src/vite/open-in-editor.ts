import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface EditorLocation {
  column: number
  filePath: string
  line: number
}

export interface EditorInvocation {
  args: string[]
  command: string
}

export class EditorPathError extends Error {}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`[fict-devtools] Invalid editor position: ${value}`)
  }
  return parsed
}

/**
 * Parse trailing :line:column segments without treating a Windows drive letter
 * as a separator.
 */
export function parseEditorLocation(location: string): EditorLocation {
  let filePath = location
  let lineText: string | undefined
  let columnText: string | undefined

  const trailingNumber = /:(\d+)$/
  const last = trailingNumber.exec(filePath)
  if (last) {
    filePath = filePath.slice(0, last.index)
    const previous = trailingNumber.exec(filePath)
    if (previous) {
      filePath = filePath.slice(0, previous.index)
      lineText = previous[1]
      columnText = last[1]
    } else {
      lineText = last[1]
    }
  }

  if (!filePath || filePath.includes('\0')) {
    throw new EditorPathError('[fict-devtools] Invalid editor file path')
  }

  return {
    filePath,
    line: parsePositiveInteger(lineText, 1),
    column: parsePositiveInteger(columnText, 1),
  }
}

function canonicalDirectory(path: string): string {
  const canonical = realpathSync(path)
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`[fict-devtools] Editor root is not a directory: ${path}`)
  }
  return canonical
}

function isWithinRoot(filePath: string, root: string): boolean {
  const pathFromRoot = relative(root, filePath)
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
  )
}

export function resolveEditorRoots(
  projectRoot: string,
  additionalRoots: readonly string[],
): string[] {
  const resolvedProjectRoot = resolve(projectRoot)
  return [
    ...new Set([resolvedProjectRoot, ...additionalRoots.map(root => resolve(projectRoot, root))]),
  ].map(canonicalDirectory)
}

export function resolveEditorLocation(
  location: string,
  projectRoot: string,
  allowedRoots: readonly string[],
): EditorLocation {
  const parsed = parseEditorLocation(location)
  const requestedPath = isAbsolute(parsed.filePath)
    ? parsed.filePath
    : resolve(projectRoot, parsed.filePath)

  let canonicalPath: string
  try {
    canonicalPath = realpathSync(requestedPath)
  } catch {
    throw new EditorPathError(`[fict-devtools] Editor file does not exist: ${requestedPath}`)
  }

  if (!statSync(canonicalPath).isFile()) {
    throw new EditorPathError(`[fict-devtools] Editor target is not a file: ${requestedPath}`)
  }
  if (!allowedRoots.some(root => isWithinRoot(canonicalPath, root))) {
    throw new EditorPathError('[fict-devtools] Editor file is outside the allowed roots')
  }

  return { ...parsed, filePath: canonicalPath }
}

export function createEditorInvocation(location: EditorLocation, editor: string): EditorInvocation {
  const { filePath, line, column } = location
  switch (editor) {
    case 'code':
    case 'code-insiders':
      return { command: editor, args: ['--goto', `${filePath}:${line}:${column}`] }
    case 'webstorm':
      return {
        command: 'webstorm',
        args: ['--line', String(line), '--column', String(column), filePath],
      }
    case 'atom':
      return { command: 'atom', args: [`${filePath}:${line}:${column}`] }
    default:
      return { command: editor, args: [filePath] }
  }
}

export async function openInEditor(
  location: string,
  editor: string,
  projectRoot: string,
  allowedRoots: readonly string[],
): Promise<void> {
  const invocation = createEditorInvocation(
    resolveEditorLocation(location, projectRoot, allowedRoots),
    editor,
  )

  return new Promise((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: 'ignore',
      detached: true,
    })
    child.once('error', reject)
    child.once('spawn', resolvePromise)
    child.unref()
  })
}
