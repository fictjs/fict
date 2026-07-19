#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = process.cwd()
const capabilityManifest = JSON.parse(
  readFileSync(path.join(root, 'packages/compiler/compiler-capabilities.json'), 'utf8'),
)
const capabilityManifestDigest = `sha256:${createHash('sha256')
  .update(JSON.stringify(capabilityManifest))
  .digest('hex')}`
const nativePath = path.resolve(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(root, 'target', 'release', 'fict_compiler_napi.node'),
)
const cjsFacade = require('../packages/compiler/dist/native-loader.cjs')
const esmFacade = await import(
  pathToFileURL(path.join(root, 'packages/compiler/dist/native-loader.js')).href
)

const request = {
  protocolVersion: 1,
  code: 'export const value: number = 1',
  filename: '/fixtures/value.ts',
  moduleId: '/fixtures/value.ts?worker#client',
  options: { sourcemap: true, explain: true },
}

function metadataAtNamespaceDepth(depth) {
  let metadata = { version: 1, exports: {} }
  for (let level = 0; level < depth; level += 1) {
    metadata = { version: 1, exports: {}, namespaces: { [`level${level}`]: metadata } }
  }
  return metadata
}

function transformWithMetadata(binding, metadata) {
  return binding.transformSync({
    code: 'export const value = 1',
    filename: '/fixtures/metadata-protocol.js',
    metadata: [
      {
        request: './metadata-dependency.js',
        resolvedId: '/fixtures/metadata-dependency.js',
        status: 'resolved',
        metadata,
        fingerprint: 'sha256:metadata-dependency',
      },
    ],
  })
}

function withoutStageTimings(result) {
  return {
    ...result,
    stats: result.stats
      ? {
          ...result.stats,
          stageDurationsNs: {},
        }
      : null,
  }
}

let expectedBuildId
for (const [format, facade] of [
  ['cjs', cjsFacade],
  ['esm', esmFacade],
]) {
  const binding = facade.loadNativeCompilerBinding({ nativePath })
  const info = binding.nativeCompilerInfo()
  assert.equal(info.backend, 'rust')
  assert.equal(typeof info.nativeTarget, 'string')
  assert.ok(info.nativeTarget.length > 0)
  assert.equal(info.oxcVersion, '0.139.0')
  assert.equal(info.nodeApiVersion, 10)
  assert.equal(info.compilerProtocolVersion, 1)
  assert.equal(info.metadataSchemaVersion, 1)
  assert.equal(info.compilerCapabilityManifestVersion, capabilityManifest.schemaVersion)
  assert.equal(info.compilerCapabilityManifestDigest, capabilityManifestDigest)
  assert.equal(info.compilerCapabilityPackageVersion, capabilityManifest.packageVersion)
  assert.match(info.compilerBuildId, /^fict-rust-p1-oxc0\.139\.0-m1-[0-9a-f]{64}$/)
  assert.ok(
    info.compilerBuildRevision === null || /^[0-9a-f]{40}$/.test(info.compilerBuildRevision),
  )
  expectedBuildId ??= info.compilerBuildId
  assert.equal(info.compilerBuildId, expectedBuildId)

  const syncResult = binding.transformSync(request)
  const asyncResult = await binding.transform(request)
  assert.deepEqual(withoutStageTimings(asyncResult), withoutStageTimings(syncResult))
  assert.equal(syncResult.protocolVersion, 1)
  assert.equal(syncResult.compilerBuildId, info.compilerBuildId)
  assert.equal(syncResult.diagnostics.length, 0)
  assert.match(syncResult.code, /export const value = 1/)
  assert.doesNotMatch(syncResult.code, /: number/)
  assert.deepEqual(syncResult.map?.sources, ['/fixtures/value.ts'])
  assert.equal(syncResult.explain?.fileName, '/fixtures/value.ts')

  const composedMapResult = binding.transformSync({
    code: 'export const value: number = 1',
    filename: '/fixtures/intermediate.ts',
    inputSourceMap: {
      version: 3,
      file: '/fixtures/intermediate.ts',
      sourceRoot: '/sources',
      sources: ['original.fict'],
      sourcesContent: ['export const value = 1'],
      names: [],
      mappings: 'AAAA',
      x_google_ignoreList: [0],
    },
    options: { sourcemap: true },
  })
  assert.deepEqual(composedMapResult.diagnostics, [])
  assert.equal(composedMapResult.map?.sourceRoot, '/sources')
  assert.deepEqual(composedMapResult.map?.sources, ['original.fict'])
  assert.deepEqual(composedMapResult.map?.sourcesContent, ['export const value = 1'])
  assert.deepEqual(composedMapResult.map?.x_google_ignoreList, [0])

  const sourceExplain = binding.transformSync({
    code: `
      import { $effect, $memo, $state } from 'fict'
      export function Counter() {
        const count = $state(0)
        const doubled = $memo(() => count * 2)
        $effect(() => { doubled })
        if (count) return <button>{doubled}</button>
        return <span>zero</span>
      }
    `,
    filename: '/fixtures/explain.tsx',
    options: { explain: true, strictGuarantee: false },
  })
  assert.deepEqual(sourceExplain.diagnostics, [])
  const sourceEvents = sourceExplain.explain?.events.filter(event =>
    event.kind.startsWith('source-'),
  )
  assert.ok(sourceEvents)
  for (const kind of [
    'source-signal',
    'source-memo',
    'source-effect',
    'source-jsx',
    'source-control-flow',
  ]) {
    assert.ok(
      sourceEvents.some(event => event.kind === kind),
      `missing ${kind}`,
    )
  }
  assert.ok(sourceEvents.every(event => event.span))
  assert.ok(
    sourceEvents.every(
      (event, index) => index === 0 || sourceEvents[index - 1].span.start <= event.span.start,
    ),
  )

  const empty = binding.transformSync({ code: '', filename: 'empty.js' })
  assert.equal(empty.code, '')
  assert.deepEqual(empty.diagnostics, [])

  const parserError = binding.transformSync({
    code: 'export const =',
    filename: 'broken.ts',
  })
  assert.equal(parserError.code, '')
  assert.equal(parserError.diagnostics[0]?.code, 'FICT-PARSE')
  assert.ok(parserError.diagnostics[0]?.primarySpan)

  const malformed = binding.transformSync({ code: 42, filename: 'malformed.ts' })
  assert.equal(malformed.code, '')
  assert.equal(malformed.diagnostics[0]?.code, 'FICT-REQUEST')

  for (const depth of [31, 32]) {
    const result = transformWithMetadata(binding, metadataAtNamespaceDepth(depth))
    assert.deepEqual(result.diagnostics, [], `${format}: depth ${depth} must be accepted`)
  }
  for (const depth of [33, 63, 64, 65]) {
    const result = transformWithMetadata(binding, metadataAtNamespaceDepth(depth))
    assert.equal(
      result.diagnostics[0]?.code,
      'FICT-REQUEST',
      `${format}: depth ${depth} must be rejected`,
    )
  }
  for (const [name, metadata] of [
    ['unversioned', { exports: {} }],
    ['null version', { version: null, exports: {} }],
    ['unknown version', { version: 2, exports: {} }],
    ['unknown field', { version: 1, exports: {}, legacy: true }],
  ]) {
    const result = transformWithMetadata(binding, metadata)
    assert.equal(result.diagnostics[0]?.code, 'FICT-REQUEST', `${format}: ${name} must be rejected`)
  }

  const scanRequest = {
    code: `
      import './setup'
      export * from './dep'
      import legacy = require('./legacy')
      import('./dynamic')
    `,
    filename: '/fixtures/module.ts',
    moduleId: '/@id/module.ts?worker#client',
  }
  const syncScan = binding.scanSync(scanRequest)
  const asyncScan = await binding.scan(scanRequest)
  assert.deepEqual(asyncScan, syncScan)
  assert.equal(syncScan.protocolVersion, 1)
  assert.equal(syncScan.compilerBuildId, info.compilerBuildId)
  assert.equal(syncScan.hasModuleSyntax, true)
  assert.deepEqual(
    syncScan.moduleRequests.map(({ source, kind, typeOnly }) => ({ source, kind, typeOnly })),
    [
      { source: './setup', kind: 'import', typeOnly: false },
      { source: './dep', kind: 'reExport', typeOnly: false },
      { source: './legacy', kind: 'importEquals', typeOnly: false },
    ],
  )
  assert.equal(syncScan.diagnostics.length, 0)

  const malformedScan = binding.scanSync({ code: 42, filename: 'malformed.ts' })
  assert.equal(malformedScan.moduleRequests.length, 0)
  assert.equal(malformedScan.diagnostics[0]?.code, 'FICT-REQUEST')

  const analyzeRequest = {
    code: `
      import { $effect, $state } from 'fict'
      export function Counter() {
        const count = $state(0)
        $effect(() => { count })
        return <button>{count}</button>
      }
    `,
    filename: '/fixtures/counter.tsx',
    moduleId: '/@id/counter.tsx?worker#client',
    options: { includeRegions: true, includeDiagnostics: true, verbosity: 'verbose' },
  }
  const syncAnalysis = binding.analyzeSync(analyzeRequest)
  const asyncAnalysis = await binding.analyze(analyzeRequest)
  assert.deepEqual(asyncAnalysis, syncAnalysis)
  assert.equal(syncAnalysis.fileName, '/fixtures/counter.tsx')
  assert.deepEqual(syncAnalysis.diagnostics, [])
  const counter = syncAnalysis.components.find(component => component.name === 'Counter')
  assert.ok(counter)
  assert.ok(counter.regions.length > 0)
  assert.ok(counter.trace.some(line => line.markers.some(marker => marker.kind === 'effect')))

  const malformedAnalysis = binding.analyzeSync({ code: 42, filename: 'malformed.ts' })
  assert.equal(malformedAnalysis.components.length, 0)
  assert.equal(malformedAnalysis.diagnostics[0]?.code, 'FICT-REQUEST')

  console.log(
    JSON.stringify({
      format,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      compilerBuildId: info.compilerBuildId,
    }),
  )
}
