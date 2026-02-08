import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cleanupEventListeners, installResumableLoader, type SnapshotIssue } from '../src/loader'
import {
  FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
  __fictDisableResumable,
  __fictGetSSRScope,
  __fictSetSSRState,
} from '../src/internal'

function createDocumentWithSnapshots(
  initialPayload?: string,
  incrementalPayloads: string[] = [],
): Document {
  const doc = document.implementation.createHTMLDocument('fict-loader-test')

  if (initialPayload !== undefined) {
    const script = doc.createElement('script')
    script.id = '__FICT_SNAPSHOT__'
    script.type = 'application/json'
    script.textContent = initialPayload
    doc.body.appendChild(script)
  }

  for (const payload of incrementalPayloads) {
    const script = doc.createElement('script')
    script.type = 'application/json'
    script.setAttribute('data-fict-snapshot', '')
    script.textContent = payload
    doc.body.appendChild(script)
  }

  return doc
}

describe('resumable loader snapshot validation', () => {
  beforeEach(() => {
    cleanupEventListeners()
    __fictSetSSRState(null)
    __fictDisableResumable()
  })

  afterEach(() => {
    cleanupEventListeners()
    __fictSetSSRState(null)
    __fictDisableResumable()
  })

  it('accepts versioned snapshots', () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          s1: { id: 's1', slots: [[0, 'raw', 123]] },
        },
      }),
    )

    installResumableLoader({ document: doc, events: [], prefetch: false })

    const scope = __fictGetSSRScope('s1')
    expect(scope).toBeDefined()
    expect(scope?.id).toBe('s1')
    expect(scope?.slots[0]?.[2]).toBe(123)
  })

  it('accepts legacy snapshots without explicit version', () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        scopes: {
          s2: { id: 's2', slots: [[0, 'raw', 'legacy']] },
        },
      }),
    )

    installResumableLoader({ document: doc, events: [], prefetch: false })

    const scope = __fictGetSSRScope('s2')
    expect(scope).toBeDefined()
    expect(scope?.slots[0]?.[2]).toBe('legacy')
  })

  it('rejects unsupported snapshot schema versions', () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION + 1,
        scopes: {
          s3: { id: 's3', slots: [[0, 'raw', 'blocked']] },
        },
      }),
    )

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })

    expect(__fictGetSSRScope('s3')).toBeUndefined()
    expect(issues.some(issue => issue.code === 'snapshot_unsupported_version')).toBe(true)
  })

  it('reports parse and shape errors for invalid snapshots', () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots('{not-valid-json', ['{"v":1,"scopes":[] }'])

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })

    expect(issues.some(issue => issue.code === 'snapshot_parse_error')).toBe(true)
    expect(issues.some(issue => issue.code === 'snapshot_invalid_shape')).toBe(true)
  })

  it('ignores incremental snapshots with unsupported versions', () => {
    const onIssue = vi.fn()
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sBase: { id: 'sBase', slots: [[0, 'raw', 'base']] },
        },
      }),
      [
        JSON.stringify({
          v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION + 1,
          scopes: {
            sBad: { id: 'sBad', slots: [[0, 'raw', 'bad']] },
          },
        }),
      ],
    )

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      onSnapshotIssue: onIssue,
    })

    expect(__fictGetSSRScope('sBase')).toBeDefined()
    expect(__fictGetSSRScope('sBad')).toBeUndefined()
    expect(onIssue).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'snapshot_unsupported_version' }),
    )
  })
})
