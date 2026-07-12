import { describe, expect, it } from 'vitest'

import {
  COMPILER_PROTOCOL_VERSION,
  MODULE_REACTIVE_METADATA_VERSION,
  type CompileRequest,
  type CompileResult,
} from '../src/index'

describe('native compile protocol', () => {
  it('keeps physical and query-bearing module identities separate', () => {
    const request: CompileRequest = {
      protocolVersion: COMPILER_PROTOCOL_VERSION,
      code: 'export const view: JSX.Element = <div />',
      filename: '/src/view.tsx',
      moduleId: '/src/view.tsx?worker#client',
      language: 'tsx',
      moduleKind: 'module',
      options: {
        strictGuarantee: true,
        optimizeLevel: 'safe',
        typescript: { allowNamespaces: true, rewriteImportExtensions: true },
      },
      metadata: [],
      integrationDiagnostics: [],
    }

    expect(request.filename).toBe('/src/view.tsx')
    expect(request.moduleId).toBe('/src/view.tsx?worker#client')
    expect(request.options?.typescript?.rewriteImportExtensions).toBe(true)
  })

  it('exposes a JSON-safe complete result shape', () => {
    const result: CompileResult = {
      protocolVersion: COMPILER_PROTOCOL_VERSION,
      code: '',
      map: null,
      diagnostics: [],
      moduleMetadata: { version: MODULE_REACTIVE_METADATA_VERSION, exports: {} },
      metadataDependencies: [],
      unresolvedMetadataRequests: [],
      metadataIncomplete: false,
      explain: null,
      artifacts: [],
      stats: null,
      compilerBuildId: 'fict:test-build',
    }

    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })
})
