import { describe, expect, it } from 'vitest'

import { parseModuleReactiveMetadata } from '../src/graph-host'
import {
  MODULE_REACTIVE_METADATA_VERSION,
  type ReactiveExportKind,
  type ResolvedMetadataInput,
} from '../src/index'

describe('native metadata protocol', () => {
  it('preserves special export keys and a query-bearing resolved identity', () => {
    const exports = Object.fromEntries([
      ['__proto__', 'signal'],
      ['constructor', 'memo'],
      ['toString', 'store'],
    ]) as Record<string, ReactiveExportKind>
    const input: ResolvedMetadataInput = {
      request: './counter',
      resolvedId: '/src/counter.tsx?client',
      status: 'resolved',
      metadata: {
        version: MODULE_REACTIVE_METADATA_VERSION,
        exports,
      },
      fingerprint: 'sha256:counter',
    }

    const parsed = parseModuleReactiveMetadata(JSON.stringify(input.metadata))
    expect(parsed?.version).toBe(MODULE_REACTIVE_METADATA_VERSION)
    expect(Object.prototype.hasOwnProperty.call(parsed?.exports, '__proto__')).toBe(true)
    expect(input.resolvedId).toContain('?client')
  })

  it('represents authoritative misses without inventing metadata', () => {
    const input: ResolvedMetadataInput = {
      request: 'opaque-package',
      resolvedId: null,
      status: 'missing',
      metadata: null,
      fingerprint: 'missing:opaque-package',
    }

    expect(JSON.parse(JSON.stringify(input))).toEqual(input)
  })
})
