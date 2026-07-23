import assert from 'node:assert/strict'

import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function encodeVlq(value) {
  let encoded = ''
  let remaining = value < 0 ? ((-value << 1) | 1) >>> 0 : (value << 1) >>> 0
  do {
    let digit = remaining & 31
    remaining >>>= 5
    if (remaining > 0) digit |= 32
    encoded += BASE64[digit]
  } while (remaining > 0)
  return encoded
}

function encodeMappedLine(text, sourceIndex, originalLine, state) {
  let previousGeneratedColumn = 0
  const segments = []
  for (let column = 0; column <= text.length; column += 1) {
    segments.push(
      encodeVlq(column - previousGeneratedColumn) +
        encodeVlq(sourceIndex - state.sourceIndex) +
        encodeVlq(originalLine - state.originalLine) +
        encodeVlq(column - state.originalColumn),
    )
    previousGeneratedColumn = column
    state.sourceIndex = sourceIndex
    state.originalLine = originalLine
    state.originalColumn = column
  }
  return segments.join(',')
}

export function materializeSourceMapFixture(fixture) {
  if (fixture.inputComposition === undefined) return fixture
  assert.equal(fixture.source, undefined, `${fixture.id}: composed source must be generated`)
  const composition = fixture.inputComposition
  assert.equal(typeof composition.sourceRoot, 'string', `${fixture.id}: source root`)
  assert.ok(Array.isArray(composition.sources), `${fixture.id}: composed sources`)
  assert.ok(composition.sources.length > 1, `${fixture.id}: multi-source composition`)
  const prefix = composition.generatedPrefix ?? ''
  assert.equal(typeof prefix, 'string', `${fixture.id}: generated prefix`)
  assert.ok(prefix === '' || prefix.endsWith('\n'), `${fixture.id}: prefix must end with newline`)

  const mappingLines = prefix === '' ? [] : Array(prefix.slice(0, -1).split('\n').length).fill('')
  const state = { sourceIndex: 0, originalLine: 0, originalColumn: 0 }
  const sourceBodies = []
  for (const [sourceIndex, source] of composition.sources.entries()) {
    assert.equal(typeof source.name, 'string', `${fixture.id}: source ${sourceIndex} name`)
    assert.equal(typeof source.content, 'string', `${fixture.id}: source ${sourceIndex} content`)
    assert.equal(source.content.endsWith('\n'), false, `${fixture.id}: source trailing newline`)
    sourceBodies.push(source.content)
    for (const [line, text] of source.content.split('\n').entries()) {
      mappingLines.push(encodeMappedLine(text, sourceIndex, line, state))
    }
  }

  const source = `${prefix}${sourceBodies.join('\n')}`
  const inputSourceMap = {
    version: 3,
    file: fixture.filename,
    sourceRoot: composition.sourceRoot,
    sources: composition.sources.map(entry => entry.name),
    sourcesContent: sourceBodies,
    names: composition.names ?? [],
    mappings: mappingLines.join(';'),
    x_google_ignoreList: composition.ignoreSourceIndices ?? [],
  }
  assert.equal(source.split('\n').length, mappingLines.length, `${fixture.id}: mapped line count`)
  return { ...fixture, source, inputSourceMap }
}

function occurrenceIndex(text, locator, context) {
  assert.equal(typeof locator?.needle, 'string', `${context}: needle`)
  assert.ok(locator.needle.length > 0, `${context}: non-empty needle`)
  const occurrence = locator.occurrence ?? 0
  const offset = locator.offset ?? 0
  assert.ok(Number.isSafeInteger(occurrence) && occurrence >= 0, `${context}: occurrence`)
  assert.ok(Number.isSafeInteger(offset) && offset >= 0, `${context}: offset`)

  let index = -1
  let fromIndex = 0
  for (let current = 0; current <= occurrence; current += 1) {
    index = text.indexOf(locator.needle, fromIndex)
    assert.notEqual(
      index,
      -1,
      `${context}: missing ${JSON.stringify(locator.needle)} #${occurrence}`,
    )
    fromIndex = index + locator.needle.length
  }
  const located = index + offset
  assert.ok(located <= index + locator.needle.length, `${context}: offset outside needle`)
  return located
}

function lineColumn(text, index) {
  const line = text.slice(0, index).split('\n').length
  const lineStart = text.lastIndexOf('\n', index - 1) + 1
  return { line, column: index - lineStart }
}

export function sourcePosition(source, filename, locator, context = 'source locator') {
  const index = occurrenceIndex(source, locator, context)
  return { source: filename, ...lineColumn(source, index) }
}

export function traceGeneratedPosition(code, rawMap, locator, context = 'generated locator') {
  assert.equal(rawMap?.version, 3, `${context}: source map version`)
  assert.ok(Array.isArray(rawMap.sources), `${context}: source map sources`)
  assert.equal(typeof rawMap.mappings, 'string', `${context}: source map mappings`)
  assert.ok(rawMap.mappings.length > 0, `${context}: non-empty source map mappings`)

  const index = occurrenceIndex(code, locator, context)
  const generated = lineColumn(code, index)
  const mapped = originalPositionFor(new TraceMap(rawMap), generated)
  const original =
    mapped.source === null || mapped.line === null || mapped.column === null
      ? null
      : { source: mapped.source, line: mapped.line, column: mapped.column }
  return {
    generated: {
      ...generated,
      needle: locator.needle,
      occurrence: locator.occurrence ?? 0,
      offset: locator.offset ?? 0,
    },
    original,
  }
}

export function validateSourceMapFixture(fixture) {
  assert.equal(typeof fixture?.id, 'string')
  assert.equal(typeof fixture.filename, 'string', `${fixture.id}: filename`)
  assert.ok(['js', 'jsx', 'ts', 'tsx'].includes(fixture.language), `${fixture.id}: language`)
  assert.ok(
    ['module', 'script', 'commonjs', 'unambiguous'].includes(fixture.moduleKind),
    `${fixture.id}: module kind`,
  )
  assert.equal(typeof fixture.source, 'string', `${fixture.id}: source`)
  if (fixture.inputSourceMap !== undefined) {
    assert.equal(fixture.inputSourceMap.version, 3, `${fixture.id}: input map version`)
    assert.equal(fixture.inputSourceMap.file, fixture.filename, `${fixture.id}: input map file`)
    assert.ok(fixture.inputSourceMap.sources.length > 1, `${fixture.id}: input map sources`)
    assert.equal(
      fixture.inputSourceMap.sourcesContent.length,
      fixture.inputSourceMap.sources.length,
      `${fixture.id}: input map sourcesContent`,
    )
  }
  assert.ok(Array.isArray(fixture.probes), `${fixture.id}: probes`)
  assert.ok(fixture.probes.length > 0, `${fixture.id}: non-empty probes`)
  const ids = new Set()
  for (const probe of fixture.probes) {
    assert.equal(typeof probe.id, 'string', `${fixture.id}: probe id`)
    assert.equal(ids.has(probe.id), false, `${fixture.id}: duplicate probe ${probe.id}`)
    ids.add(probe.id)
    assert.equal(typeof probe.kind, 'string', `${fixture.id}:${probe.id}: kind`)
    assert.ok(probe.kind.length > 0, `${fixture.id}:${probe.id}: kind`)
    assert.ok(
      ['exact-parity', 'rust-precision-improvement'].includes(probe.disposition),
      `${fixture.id}:${probe.id}: disposition`,
    )
    assert.equal(typeof probe.babel?.needle, 'string', `${fixture.id}:${probe.id}: Babel locator`)
    assert.equal(typeof probe.rust?.needle, 'string', `${fixture.id}:${probe.id}: Rust locator`)
    if (probe.source === null) {
      assert.equal(probe.kind, 'generated-unmapped', `${fixture.id}:${probe.id}: unmapped kind`)
      assert.equal(
        probe.disposition,
        'exact-parity',
        `${fixture.id}:${probe.id}: unmapped disposition`,
      )
    } else {
      assert.equal(
        typeof probe.source?.needle,
        'string',
        `${fixture.id}:${probe.id}: source locator`,
      )
      if (probe.source.sourceIndex !== undefined) {
        assert.ok(
          Number.isSafeInteger(probe.source.sourceIndex) && probe.source.sourceIndex >= 0,
          `${fixture.id}:${probe.id}: source index`,
        )
      }
    }
    if (probe.disposition === 'rust-precision-improvement') {
      assert.notEqual(probe.source, null, `${fixture.id}:${probe.id}: improved source locator`)
      assert.equal(
        typeof probe.legacySource?.needle,
        'string',
        `${fixture.id}:${probe.id}: legacy source locator`,
      )
      assert.equal(typeof probe.reason, 'string', `${fixture.id}:${probe.id}: reason`)
      assert.ok(probe.reason.length > 0, `${fixture.id}:${probe.id}: non-empty reason`)
    } else {
      assert.equal(probe.legacySource, undefined, `${fixture.id}:${probe.id}: legacy source`)
      assert.equal(probe.reason, undefined, `${fixture.id}:${probe.id}: reason`)
    }
  }
}

function fixtureSourcePosition(fixture, locator, context) {
  if (locator.sourceIndex === undefined) {
    return sourcePosition(fixture.source, fixture.filename, locator, context)
  }
  assert.ok(fixture.inputSourceMap, `${context}: missing input source map`)
  const content = fixture.inputSourceMap.sourcesContent?.[locator.sourceIndex]
  const resolvedSource = new TraceMap(fixture.inputSourceMap).resolvedSources[locator.sourceIndex]
  assert.equal(typeof content, 'string', `${context}: missing source content`)
  assert.equal(typeof resolvedSource, 'string', `${context}: missing resolved source`)
  return sourcePosition(content, resolvedSource, locator, context)
}

export function assertProbeMapping({ code, fixture, implementation, map, probe }) {
  assert.ok(['babel', 'rust'].includes(implementation))
  const context = `${fixture.id}:${probe.id}:${implementation}`
  const traced = traceGeneratedPosition(code, map, probe[implementation], context)
  const sourceLocator =
    implementation === 'babel' && probe.disposition === 'rust-precision-improvement'
      ? probe.legacySource
      : probe.source
  const expected =
    sourceLocator === null
      ? null
      : fixtureSourcePosition(fixture, sourceLocator, `${context}:source`)
  assert.deepEqual(traced.original, expected, `${context}: original position`)
  if (probe.disposition === 'rust-precision-improvement') {
    const intended = fixtureSourcePosition(fixture, probe.source, `${context}:intended-source`)
    const legacy = fixtureSourcePosition(fixture, probe.legacySource, `${context}:legacy-source`)
    assert.notDeepEqual(legacy, intended, `${context}: legacy position must differ`)
  }
  return traced
}
