import assert from 'node:assert/strict'

import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'

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
      : sourcePosition(fixture.source, fixture.filename, sourceLocator, `${context}:source`)
  assert.deepEqual(traced.original, expected, `${context}: original position`)
  if (probe.disposition === 'rust-precision-improvement') {
    const intended = sourcePosition(
      fixture.source,
      fixture.filename,
      probe.source,
      `${context}:intended-source`,
    )
    const legacy = sourcePosition(
      fixture.source,
      fixture.filename,
      probe.legacySource,
      `${context}:legacy-source`,
    )
    assert.notDeepEqual(legacy, intended, `${context}: legacy position must differ`)
  }
  return traced
}
