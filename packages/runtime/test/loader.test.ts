import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cleanupEventListeners,
  installResumableLoader,
  waitForPendingHandlers,
  type SnapshotIssue,
} from '../src/loader'
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

  it('appends prefetch links to the source document head', async () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {},
      }),
    )
    const btn = doc.createElement('button')
    const qrlUrl = '/prefetch-owner-doc.js'
    btn.setAttribute('data-fict-h', `${qrlUrl}#default`)
    doc.body.appendChild(btn)

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: { visibility: false, hover: true, hoverDelay: 0 },
    })

    btn.dispatchEvent(new Event('pointerover', { bubbles: true }))
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    const prefetchLink = doc.head.querySelector(`link[rel="modulepreload"][href*="${qrlUrl}"]`)
    expect(prefetchLink).toBeTruthy()
    expect(prefetchLink?.ownerDocument).toBe(doc)

    const globalPrefetchLink = document.head.querySelector(
      `link[rel="modulepreload"][href*="${qrlUrl}"]`,
    )
    expect(globalPrefetchLink).toBeNull()
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

  it('continues event path scanning when a nested scope snapshot is missing', async () => {
    const onIssue = vi.fn()
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sParent: { id: 'sParent', slots: [] },
        },
      }),
    )

    ;(globalThis as { __fictParentCalls?: number }).__fictParentCalls = 0

    const parentHost = doc.createElement('div')
    parentHost.setAttribute('data-fict-s', 'sParent')
    parentHost.setAttribute(
      'on:click',
      'data:text/javascript,export function parent(){globalThis.__fictParentCalls=(globalThis.__fictParentCalls||0)+1}#parent',
    )

    const childHost = doc.createElement('div')
    childHost.setAttribute('data-fict-s', 'sMissing')
    const childButton = doc.createElement('button')
    childButton.setAttribute('on:click', 'data:text/javascript,export function child(){}#child')

    childHost.appendChild(childButton)
    parentHost.appendChild(childHost)
    doc.body.appendChild(parentHost)

    installResumableLoader({
      document: doc,
      events: ['click'],
      prefetch: false,
      onSnapshotIssue: onIssue,
    })

    const clickEvent = new Event('click', { bubbles: true, cancelable: true })
    childButton.dispatchEvent(clickEvent)
    await waitForPendingHandlers()

    expect((globalThis as { __fictParentCalls?: number }).__fictParentCalls).toBe(1)
    expect(onIssue).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'scope_snapshot_missing', scopeId: 'sMissing' }),
    )

    delete (globalThis as { __fictParentCalls?: number }).__fictParentCalls
  })

  it('handles resumable handler failures without unhandled promise rejections', async () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          s1: { id: 's1', slots: [] },
        },
      }),
    )

    const host = doc.createElement('div')
    host.setAttribute('data-fict-s', 's1')
    const button = doc.createElement('button')
    button.setAttribute('on:click', '/__fict_missing_module__.js#default')
    host.appendChild(button)
    doc.body.appendChild(host)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    const ev = new Event('click', { bubbles: true, cancelable: true })
    button.dispatchEvent(ev)
    await waitForPendingHandlers()

    expect(errorSpy).toHaveBeenCalledWith(
      '[fict/loader] Failed to handle resumable event.',
      expect.anything(),
    )
    errorSpy.mockRestore()
  })
})
