import { describe, expect, it } from 'vitest'

import {
  COMPILER_PROTOCOL_VERSION,
  MODULE_REACTIVE_METADATA_VERSION,
  type AnalyzeRequest,
  type CompileRequest,
  type CompileResult,
  type ScanRequest,
  type ScanResult,
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

  it('exposes JSON-safe static module scan request and result shapes', () => {
    const request: ScanRequest = {
      protocolVersion: COMPILER_PROTOCOL_VERSION,
      code: `import './dep'`,
      filename: '/src/module.ts',
      moduleId: '/src/module.ts?worker#client',
      language: 'ts',
      moduleKind: 'module',
    }
    const result: ScanResult = {
      protocolVersion: COMPILER_PROTOCOL_VERSION,
      moduleRequests: [
        {
          source: './dep',
          kind: 'import',
          typeOnly: false,
          span: { start: 7, end: 14 },
        },
      ],
      hasModuleSyntax: true,
      diagnostics: [],
      compilerBuildId: 'fict:test-build',
    }

    expect(JSON.parse(JSON.stringify(request))).toEqual(request)
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })

  it('exposes graph metadata and integration diagnostics to analysis requests', () => {
    const request: AnalyzeRequest = {
      protocolVersion: COMPILER_PROTOCOL_VERSION,
      code: `import { count } from './dep'`,
      filename: '/src/consumer.ts',
      moduleId: '/src/consumer.ts?client',
      metadata: [
        {
          request: './dep',
          resolvedId: '/src/dep.ts',
          status: 'resolved',
          metadata: {
            version: MODULE_REACTIVE_METADATA_VERSION,
            exports: { count: 'signal' },
          },
          fingerprint: 'sha256:dep',
        },
      ],
      integrationDiagnostics: [
        {
          code: 'FICT-R006',
          severity: 'warning',
          message: 'integration warning',
          primarySpan: null,
          secondaryLabels: [],
          help: null,
          notes: [],
          guaranteeClass: 'advisory',
        },
      ],
      options: { compilerOptions: { strictGuarantee: false } },
    }

    expect(JSON.parse(JSON.stringify(request))).toEqual(request)
  })
})
