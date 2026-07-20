import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import path from 'node:path'

import { defineConfig } from 'vitest/config'

const legacyRoot = process.env.FICT_LEGACY_CAPTURE_ROOT
const capturePath = process.env.FICT_LEGACY_CAPTURE_PATH

assert.ok(legacyRoot, 'FICT_LEGACY_CAPTURE_ROOT is required')
assert.ok(capturePath, 'FICT_LEGACY_CAPTURE_PATH is required')

const compilerRoot = path.join(legacyRoot, 'packages/compiler')
const compilerIndex = path.join(compilerRoot, 'src/index.ts')
const runtimeInternal = path.join(legacyRoot, 'packages/runtime/src/internal.ts')
const runtimeInternalList = path.join(legacyRoot, 'packages/runtime/src/internal/list.ts')
const runtimeIndex = path.join(legacyRoot, 'packages/runtime/src/index.ts')
const runtimeJsx = path.join(legacyRoot, 'packages/runtime/src/jsx-runtime.ts')
const expectedCompilerIndexSha256 =
  '4b8e5c1345538098acba95e00f4dee09d0e4f65feb7e3dd61cccb7bc3e98794f'

const importNeedle = "import traverseModule from '@babel/traverse'"
const visitorNeedle = `    return {
      name: 'fict-compiler-hir',
      visitor: createHIREntrypointVisitor(t, normalizedOptions),
    }`
const metadataNeedle = `            const meta = resolveModuleMetadata(
              importPath.node.source.value,
              fileName,
              optionsWithWarnings,
            )`

const captureHelpers = `
let __fictLegacyCaptureSequence = 0
let __fictLegacyCaptureInvocationId: string | undefined
const __fictLegacyCaptureIdsByProgram = new WeakMap<object, string>()

function __fictLegacyCaptureEncode(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === undefined) return null
  if (typeof value === 'function') {
    return { __fictCaptureType: 'Function', name: value.name || null }
  }
  if (typeof value !== 'object' || value === null) return value
  if (seen.has(value)) return { __fictCaptureType: 'Circular' }
  seen.add(value)
  try {
    if (value instanceof Map) {
      return {
        __fictCaptureType: 'Map',
        entries: Array.from(value.entries(), ([key, entry]) => [
          __fictLegacyCaptureEncode(key, seen),
          __fictLegacyCaptureEncode(entry, seen),
        ]),
      }
    }
    if (value instanceof Set) {
      return {
        __fictCaptureType: 'Set',
        values: Array.from(value, entry => __fictLegacyCaptureEncode(entry, seen)),
      }
    }
    if (Array.isArray(value)) {
      return value.map(entry => __fictLegacyCaptureEncode(entry, seen))
    }
    return Object.fromEntries(
      Object.keys(value)
        .filter(key => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map(key => [
          key,
          __fictLegacyCaptureEncode((value as Record<string, unknown>)[key], seen),
        ]),
    )
  } finally {
    seen.delete(value)
  }
}

function __fictLegacyCaptureAppend(entry: Record<string, unknown>): void {
  const output = process.env.FICT_LEGACY_CAPTURE_PATH
  if (!output) return
  __fictCaptureAppendFileSync(
    output,
    \`\${JSON.stringify(__fictLegacyCaptureEncode(entry))}\\n\`,
  )
}

`

const instrumentedVisitor = `    const visitor = createHIREntrypointVisitor(t, normalizedOptions)
    if (process.env.FICT_LEGACY_CAPTURE_PATH) {
      const programVisitor = visitor.Program as {
        enter?: (path: BabelCore.NodePath<BabelCore.types.Program>) => void
        exit?: (path: BabelCore.NodePath<BabelCore.types.Program>) => void
      }
      const originalEnter = programVisitor.enter
      const originalExit = programVisitor.exit
      const originalOnWarn = normalizedOptions.onWarn
      if (originalOnWarn) {
        normalizedOptions.onWarn = warning => {
          __fictLegacyCaptureAppend({
            kind: 'warning',
            invocationId: __fictLegacyCaptureInvocationId,
            warning,
          })
          originalOnWarn(warning)
        }
      }
      programVisitor.enter = path => {
        const invocationId = \`\${process.pid}:\${++__fictLegacyCaptureSequence}\`
        __fictLegacyCaptureInvocationId = invocationId
        __fictLegacyCaptureIdsByProgram.set(path.node, invocationId)
        const hub = path.hub as unknown as {
          file?: BabelCore.BabelFile & { code?: string; opts?: { filename?: string } }
        }
        __fictLegacyCaptureAppend({
          kind: 'enter',
          invocationId,
          source: hub.file?.code,
          filename: hub.file?.opts?.filename,
          options: normalizedOptions,
          stack: new Error('legacy compiler capture').stack,
        })
        try {
          originalEnter?.(path)
        } catch (error) {
          __fictLegacyCaptureAppend({
            kind: 'outcome',
            invocationId,
            status: 'error',
            phase: 'enter',
            errorName: error instanceof Error ? error.name : null,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
          throw error
        }
      }
      programVisitor.exit = path => {
        const invocationId =
          __fictLegacyCaptureIdsByProgram.get(path.node) ?? __fictLegacyCaptureInvocationId
        __fictLegacyCaptureInvocationId = invocationId
        try {
          originalExit?.(path)
          __fictLegacyCaptureAppend({
            kind: 'outcome',
            invocationId,
            status: 'ok',
            phase: 'exit',
          })
        } catch (error) {
          __fictLegacyCaptureAppend({
            kind: 'outcome',
            invocationId,
            status: 'error',
            phase: 'exit',
            errorName: error instanceof Error ? error.name : null,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
          throw error
        }
      }
    }

    return {
      name: 'fict-compiler-hir',
      visitor,
    }`

const instrumentedMetadata = `${metadataNeedle}
            const __fictCaptureProgramPath = importPath.findParent(parent => parent.isProgram())
            __fictLegacyCaptureAppend({
              kind: 'metadata',
              invocationId:
                (__fictCaptureProgramPath &&
                  __fictLegacyCaptureIdsByProgram.get(__fictCaptureProgramPath.node)) ??
                __fictLegacyCaptureInvocationId,
              request: importPath.node.source.value,
              importer: fileName,
              resolved: meta !== undefined,
              metadata: meta ?? null,
            })`

function replaceExactlyOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle)
  assert.notEqual(first, -1, `missing ${label} injection marker`)
  assert.equal(source.indexOf(needle, first + needle.length), -1, `duplicate ${label} marker`)
  return `${source.slice(0, first)}${replacement}${source.slice(first + needle.length)}`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export default defineConfig({
  root: compilerRoot,
  plugins: [
    {
      name: 'fict-legacy-unrepresented-callsite-capture',
      enforce: 'pre',
      transform(source, id) {
        if (path.resolve(id.split('?')[0]) !== compilerIndex) return null
        assert.equal(sha256(source), expectedCompilerIndexSha256, 'legacy compiler entry digest')
        let code = replaceExactlyOnce(
          source,
          importNeedle,
          `${importNeedle}\nimport { appendFileSync as __fictCaptureAppendFileSync } from 'node:fs'`,
          'capture import',
        )
        code = replaceExactlyOnce(
          code,
          'export const createFictPlugin = declare(',
          `${captureHelpers}export const createFictPlugin = declare(`,
          'capture helper',
        )
        code = replaceExactlyOnce(code, visitorNeedle, instrumentedVisitor, 'Program visitor')
        code = replaceExactlyOnce(code, metadataNeedle, instrumentedMetadata, 'metadata')
        return { code, map: null }
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^@fictjs\/compiler$/, replacement: compilerIndex },
      { find: '@fictjs/runtime/jsx-runtime', replacement: runtimeJsx },
      { find: /^@fictjs\/runtime\/internal\/list$/, replacement: runtimeInternalList },
      { find: /^@fictjs\/runtime\/internal$/, replacement: runtimeInternal },
      { find: /^@fictjs\/runtime$/, replacement: runtimeIndex },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
})
