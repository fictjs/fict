import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { onMount } from '../src/index'

import {
  UNVERSIONED_SNAPSHOT_MIGRATION_KEY,
  cleanupEventListeners,
  createLegacySnapshotMigration,
  getPendingLoaderWaiterCountForTests,
  installResumableLoader,
  waitForPendingHandlers,
  type SnapshotIssue,
} from '../src/loader'
import {
  FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
  __fictDisableResumable,
  __fictEnsureScope,
  __fictGetScopeProps,
  __fictPopContext,
  __fictPrepareContext,
  __fictPushContext,
  __fictRegisterResume,
  __fictGetSSRScope,
  __fictMergeSSRState,
  __fictSetSSRState,
  __fictUseLexicalScope,
  createEffect,
  createSignal,
  createStore,
  hydrateComponent,
  onDestroy,
  unwrapStore,
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

interface ResumedScopeLifecycleProbe {
  effectRuns: number
  effectCleanups: number
  destroys: number
  signal?: {
    (): number
    (value: number): void
  }
  store?: { value: number }
}

function hydrateResumedScopeProbe(
  scopeId: string,
  host: Element,
  probe: ResumedScopeLifecycleProbe,
  capturedSnapshot = __fictGetSSRScope(scopeId),
  setupRoot?: () => void,
): void {
  if (!capturedSnapshot) throw new Error(`Missing test snapshot for ${scopeId}`)
  const ctx = __fictEnsureScope(scopeId, host, capturedSnapshot)
  const [signal, store] = __fictUseLexicalScope(scopeId, ['signal', 'store']) as [
    ResumedScopeLifecycleProbe['signal'],
    ResumedScopeLifecycleProbe['store'],
  ]
  probe.signal = signal
  probe.store = store

  __fictPrepareContext(ctx)
  __fictPushContext()
  try {
    // Match compiler-generated resume code: its hydrateComponent return value
    // is intentionally ignored, so runtime ownership must retain the teardown.
    hydrateComponent(() => {
      createEffect(() => {
        signal!()
        void store!.value
        probe.effectRuns++
        return () => {
          probe.effectCleanups++
        }
      })
      onDestroy(() => {
        probe.destroys++
      })
      setupRoot?.()
    }, host as HTMLElement)
  } finally {
    __fictPopContext()
  }
}

function createLifecycleProbe(): ResumedScopeLifecycleProbe {
  return { effectRuns: 0, effectCleanups: 0, destroys: 0 }
}

async function flushMutationObservers(): Promise<void> {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
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
    delete (globalThis as { __FICT_MANIFEST__?: Record<string, string> }).__FICT_MANIFEST__
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

  it('installs the first revision into a scope ensured before its snapshot exists', () => {
    const ctx = __fictEnsureScope('sLate', document.createElement('div'))
    expect(ctx.slots).toEqual([])

    const state = (value: number) => ({
      v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
      scopes: {
        sLate: {
          id: 'sLate',
          t: 'Late@component',
          slots: [
            [0, 'sig', value] as [number, 'sig', number],
            [1, 'store', { value }] as [number, 'store', { value: number }],
            [2, 'raw', { value }] as [number, 'raw', { value: number }],
          ],
          props: { value },
          vars: { signal: 0, store: 1, raw: 2 },
        },
      },
    })

    __fictSetSSRState(state(1))
    const [signal, store, raw] = __fictUseLexicalScope('sLate', ['signal', 'store', 'raw']) as [
      () => number,
      { value: number },
      { value: number },
    ]
    expect(signal()).toBe(1)
    expect(store.value).toBe(1)
    expect(raw).toEqual({ value: 1 })
    expect(__fictGetScopeProps('sLate')).toEqual({ value: 1 })
    expect(ctx.scopeType).toBe('Late@component')

    __fictSetSSRState(state(2))
    expect(signal()).toBe(2)
    expect(store.value).toBe(2)
    expect(__fictUseLexicalScope('sLate', ['raw'])[0]).toEqual({ value: 2 })
    expect(__fictGetScopeProps('sLate')).toEqual({ value: 2 })
  })

  it.each(['cursor', 'rendering'] as const)(
    'fails closed when an empty scope was already touched through %s',
    field => {
      const scopeId = `sTouched-${field}`
      const ctx = __fictEnsureScope(scopeId, document.createElement('div'))
      if (field === 'cursor') {
        ctx.cursor = 1
      } else {
        ctx.rendering = true
      }

      expect(() =>
        __fictSetSSRState({
          v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
          scopes: {
            [scopeId]: {
              id: scopeId,
              slots: [[0, 'raw', 1]],
            },
          },
        }),
      ).toThrow('live scope is no longer empty')
      expect(__fictGetSSRScope(scopeId)).toBeUndefined()
      expect(ctx.slots).toEqual([])
    },
  )

  it('merges every legacy snapshot script when static fragments duplicate the script id', () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sFirst: { id: 'sFirst', slots: [[0, 'raw', 'first']] },
        },
      }),
    )
    const secondSnapshot = doc.createElement('script')
    secondSnapshot.id = '__FICT_SNAPSHOT__'
    secondSnapshot.type = 'application/json'
    secondSnapshot.textContent = JSON.stringify({
      v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
      scopes: {
        sSecond: { id: 'sSecond', slots: [[0, 'raw', 'second']] },
      },
    })
    doc.body.appendChild(secondSnapshot)

    installResumableLoader({ document: doc, events: [], prefetch: false })

    expect(__fictGetSSRScope('sFirst')?.slots[0]?.[2]).toBe('first')
    expect(__fictGetSSRScope('sSecond')?.slots[0]?.[2]).toBe('second')
  })

  it('processes a primary snapshot only once when it also has the incremental marker', () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: 0,
        scopes: {
          sMigratedOnce: { id: 'sMigratedOnce', slots: [[0, 'raw', 'once']] },
        },
      }),
    )
    doc.getElementById('__FICT_SNAPSHOT__')?.setAttribute('data-fict-snapshot', '')
    const migrate = vi.fn((snapshot: Record<string, unknown>) => ({
      ...snapshot,
      v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
    }))

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      snapshotMigrations: { 0: migrate },
    })

    expect(migrate).toHaveBeenCalledTimes(1)
    expect(__fictGetSSRScope('sMigratedOnce')?.slots[0]?.[2]).toBe('once')
  })

  it('does not treat an absent initial snapshot as state or an eager error', async () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots()
    const host = doc.createElement('div')
    host.setAttribute('data-fict-s', 'sAbsent')
    const button = doc.createElement('button')
    button.setAttribute('on:click', 'data:text/javascript,export function h(){}#h')
    host.appendChild(button)
    doc.body.appendChild(host)

    installResumableLoader({
      document: doc,
      events: ['click'],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })

    expect(issues).toEqual([])
    expect(__fictGetSSRScope('sAbsent')).toBeUndefined()

    button.dispatchEvent(new Event('click', { bubbles: true }))
    await waitForPendingHandlers()

    expect(issues).toEqual([
      expect.objectContaining({ code: 'scope_snapshot_missing', scopeId: 'sAbsent' }),
    ])
  })

  it('rejects unversioned snapshots instead of guessing their value codec', () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        scopes: {
          s2: { id: 's2', slots: [[0, 'raw', 'legacy']] },
        },
      }),
    )

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })

    expect(__fictGetSSRScope('s2')).toBeUndefined()
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'snapshot_unsupported_version',
        expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
      }),
    )
  })

  it('rejects ambiguous v1 snapshots unless the application provides a migration', () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: 1,
        scopes: {
          sLegacy: {
            id: 'sLegacy',
            slots: [],
            props: { value: { __t: 'u' } },
          },
        },
      }),
    )

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })

    expect(__fictGetSSRScope('sLegacy')).toBeUndefined()
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'snapshot_unsupported_version',
        expectedVersion: 2,
        actualVersion: 1,
      }),
    )
  })

  it('lets applications interpret ambiguous v1 props as encoded markers explicitly', () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: 1,
        scopes: {
          sEncoded: {
            id: 'sEncoded',
            slots: [],
            props: { value: { __t: 'u' } },
          },
        },
      }),
    )

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      snapshotMigrations: { 1: createLegacySnapshotMigration('encoded-props') },
    })

    const snapshot = __fictGetSSRScope('sEncoded')
    expect(snapshot).toBeDefined()
    __fictEnsureScope('sEncoded', doc.createElement('div'), snapshot)
    const props = __fictGetScopeProps('sEncoded')
    expect(props).toHaveProperty('value', undefined)
  })

  it('lets applications preserve the same v1 bytes as raw literal props explicitly', () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: 1,
        scopes: {
          sRaw: {
            id: 'sRaw',
            slots: [],
            props: { value: { __t: 'u' } },
          },
        },
      }),
    )

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      snapshotMigrations: { 1: createLegacySnapshotMigration('raw-props') },
    })

    const snapshot = __fictGetSSRScope('sRaw')
    expect(snapshot).toBeDefined()
    __fictEnsureScope('sRaw', doc.createElement('div'), snapshot)
    expect(__fictGetScopeProps('sRaw')).toEqual({ value: { __t: 'u' } })
  })

  it('requires an explicit sentinel migration for unversioned raw-props snapshots', () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        scopes: {
          sUnversioned: {
            id: 'sUnversioned',
            slots: [],
            props: { value: { __t: 'u' } },
          },
        },
      }),
    )

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      snapshotMigrations: {
        [UNVERSIONED_SNAPSHOT_MIGRATION_KEY]: createLegacySnapshotMigration('raw-props'),
      },
    })

    const snapshot = __fictGetSSRScope('sUnversioned')
    expect(snapshot).toBeDefined()
    __fictEnsureScope('sUnversioned', doc.createElement('div'), snapshot)
    expect(__fictGetScopeProps('sUnversioned')).toEqual({ value: { __t: 'u' } })
  })

  it('throws a clear error when installed without a browser document', () => {
    vi.stubGlobal('window', undefined)
    try {
      expect(() => installResumableLoader({ events: [], prefetch: false })).toThrow(
        '[fict/loader] installResumableLoader requires a browser document.',
      )
    } finally {
      vi.unstubAllGlobals()
    }
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

  it('observes visibility prefetch targets in the installed document realm', () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const doc = iframe.contentDocument
    const view = iframe.contentWindow
    expect(doc).not.toBeNull()
    expect(view).not.toBeNull()

    const observed: Element[] = []
    let observerConstructions = 0
    class ForeignIntersectionObserver {
      constructor() {
        observerConstructions++
      }

      observe(target: Element) {
        observed.push(target)
      }

      unobserve() {}

      disconnect() {}
    }
    Object.defineProperty(view!, 'IntersectionObserver', {
      configurable: true,
      value: ForeignIntersectionObserver,
    })
    vi.stubGlobal('IntersectionObserver', undefined)

    try {
      const button = doc!.createElement('button')
      button.setAttribute('data-fict-h', '/foreign-prefetch.js#default')
      doc!.body.appendChild(button)
      expect(doc!.defaultView?.IntersectionObserver).toBe(ForeignIntersectionObserver)
      expect(doc!.querySelectorAll('[data-fict-h]')).toHaveLength(1)

      installResumableLoader({
        document: doc!,
        events: [],
        prefetch: { visibility: true, hover: false },
      })

      expect(observerConstructions).toBe(1)
      expect(observed).toEqual([button])
    } finally {
      vi.unstubAllGlobals()
      iframe.remove()
    }
  })

  it('observes pure event QRLs for visibility prefetch', () => {
    const doc = createDocumentWithSnapshots()
    const button = doc.createElement('button')
    button.setAttribute('on:click', '/visibility-event.js#handle')
    doc.body.appendChild(button)

    const observed: Element[] = []
    class TestIntersectionObserver {
      observe(target: Element) {
        observed.push(target)
      }

      unobserve() {}

      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)

    try {
      installResumableLoader({
        document: doc,
        events: [],
        prefetch: { visibility: true, hover: false },
      })

      expect(observed).toEqual([button])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('prefetches an ancestor event QRL when hovering its nested content', async () => {
    const doc = createDocumentWithSnapshots()
    const button = doc.createElement('button')
    button.setAttribute('on:click', '/hover-event.js#handle')
    const label = doc.createElement('span')
    button.appendChild(label)
    doc.body.appendChild(button)

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: { visibility: false, hover: true, hoverDelay: 0 },
    })

    label.dispatchEvent(new Event('pointerover', { bubbles: true }))
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(
      doc.head.querySelector('link[rel="modulepreload"][href*="/hover-event.js"]'),
    ).toBeTruthy()
  })

  it('prefetches and deduplicates nested keyboard and pointer event QRLs', () => {
    const doc = createDocumentWithSnapshots()
    const host = doc.createElement('section')
    host.setAttribute('data-fict-h', '/nested-resume.js#default')
    const input = doc.createElement('input')
    input.setAttribute('on:keydown', '/nested-keyboard.js#keydown')
    input.setAttribute('on:keyup', '/nested-keyboard.js#keyup')
    const nested = doc.createElement('span')
    nested.setAttribute('on:pointerdown', '/nested-pointer.js#pointerdown')
    host.append(input, nested)
    doc.body.appendChild(host)

    let intersect: ((target: Element) => void) | undefined
    class TestIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        intersect = target =>
          callback(
            [{ isIntersecting: true, target } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          )
      }

      observe() {}

      unobserve() {}

      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)

    try {
      installResumableLoader({
        document: doc,
        events: [],
        prefetch: { visibility: true, hover: false },
      })
      expect(intersect).toBeDefined()

      intersect!(host)

      expect(
        doc.head.querySelectorAll('link[rel="modulepreload"][href*="/nested-keyboard.js"]'),
      ).toHaveLength(1)
      expect(
        doc.head.querySelector('link[rel="modulepreload"][href*="/nested-pointer.js"]'),
      ).toBeTruthy()
    } finally {
      vi.unstubAllGlobals()
    }
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

  it('disengages resumability before invoking a single client-render fallback', () => {
    const issues: SnapshotIssue[] = []
    const fallbackIssues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION + 1,
        scopes: { sRejected: { id: 'sRejected', slots: [] } },
      }),
      ['{invalid-incremental-json'],
    )
    const root = doc.createElement('main')
    root.textContent = 'server shell'
    doc.body.appendChild(root)

    installResumableLoader({
      document: doc,
      events: ['click'],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
      onSnapshotRejected: issue => {
        fallbackIssues.push(issue)
        root.replaceChildren(doc.createTextNode('client rendered'))
      },
    })

    expect(root.textContent).toBe('client rendered')
    expect(fallbackIssues).toHaveLength(1)
    expect(fallbackIssues[0]?.code).toBe('snapshot_unsupported_version')
    expect(__fictGetSSRScope('sRejected')).toBeUndefined()

    root.dispatchEvent(new Event('click', { bubbles: true }))
    expect(fallbackIssues).toHaveLength(1)
    expect(issues.filter(issue => issue.code === 'scope_snapshot_missing')).toHaveLength(0)
  })

  it('falls back to client rendering when an event targets a missing scope', async () => {
    const fallbackIssues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({ v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION, scopes: {} }),
    )
    const host = doc.createElement('div')
    host.setAttribute('data-fict-s', 'sMissing')
    const button = doc.createElement('button')
    button.setAttribute('on:click', 'data:text/javascript,export function h(){}#h')
    host.appendChild(button)
    doc.body.appendChild(host)

    installResumableLoader({
      document: doc,
      events: ['click'],
      prefetch: false,
      onSnapshotRejected: async issue => {
        await Promise.resolve()
        fallbackIssues.push(issue)
        host.replaceChildren(doc.createTextNode('client fallback'))
      },
    })

    button.dispatchEvent(new Event('click', { bubbles: true }))
    await waitForPendingHandlers()

    expect(fallbackIssues).toHaveLength(1)
    expect(fallbackIssues[0]?.code).toBe('scope_snapshot_missing')
    expect(host.textContent).toBe('client fallback')
  })

  it('reports rejected client-render fallbacks without unhandled rejections', async () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots('{invalid-json')

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
      onSnapshotRejected: async () => {
        throw new Error('fallback boom')
      },
    })
    await waitForPendingHandlers()

    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'snapshot_fallback_failed',
        error: expect.objectContaining({ message: 'fallback boom' }),
      }),
    )
  })

  it('reports client-render fallbacks whose then accessor throws', () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots('{invalid-json')
    const error = new Error('fallback then getter boom')
    const result = Object.defineProperty({}, 'then', {
      get() {
        throw error
      },
    }) as Promise<void>
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() =>
      installResumableLoader({
        document: doc,
        events: [],
        prefetch: false,
        onSnapshotIssue: issue => issues.push(issue),
        onSnapshotRejected: () => result,
      }),
    ).not.toThrow()

    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'snapshot_fallback_failed', error }),
    )
    expect(errorSpy).toHaveBeenCalledWith(
      '[fict/loader] Client-render fallback failed: fallback then getter boom',
    )
    errorSpy.mockRestore()
  })

  it.each(['constructor', 'catch'] as const)(
    'reports client-render fallbacks whose Promise %s accessor throws',
    accessor => {
      const issues: SnapshotIssue[] = []
      const doc = createDocumentWithSnapshots('{invalid-json')
      const error = new Error(`fallback ${accessor} getter boom`)
      const result = Promise.resolve()
      Object.defineProperty(result, accessor, {
        get() {
          throw error
        },
      })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      expect(() =>
        installResumableLoader({
          document: doc,
          events: [],
          prefetch: false,
          onSnapshotIssue: issue => issues.push(issue),
          onSnapshotRejected: () => result,
        }),
      ).not.toThrow()

      expect(issues).toContainEqual(
        expect.objectContaining({ code: 'snapshot_fallback_failed', error }),
      )
      errorSpy.mockRestore()
    },
  )

  it('migrates older snapshot schema versions when a migration is provided', () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: 0,
        scopeList: [{ id: 'sOld', slots: [[0, 'raw', 'migrated']] }],
      }),
    )

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      snapshotMigrations: {
        0(snapshot, context) {
          expect(context.fromVersion).toBe(0)
          expect(context.toVersion).toBe(FICT_SSR_SNAPSHOT_SCHEMA_VERSION)
          const scopes: Record<string, unknown> = {}
          for (const scope of snapshot.scopeList as Array<{ id: string }>) {
            scopes[scope.id] = scope
          }
          return {
            v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
            scopes,
          }
        },
      },
    })

    const scope = __fictGetSSRScope('sOld')
    expect(scope).toBeDefined()
    expect(scope?.slots[0]?.[2]).toBe('migrated')
  })

  it('reports failed snapshot schema migrations and keeps them fail-closed', () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: 0,
        scopes: {
          sBlocked: { id: 'sBlocked', slots: [[0, 'raw', 'blocked']] },
        },
      }),
    )

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      snapshotMigrations: {
        0() {
          throw new Error('migration boom')
        },
      },
      onSnapshotIssue: issue => issues.push(issue),
    })

    expect(__fictGetSSRScope('sBlocked')).toBeUndefined()
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'snapshot_migration_failed',
        actualVersion: 0,
      }),
    )
  })

  it.each([
    {
      name: 'non-object output',
      migrations: { 0: () => null },
      message: /must return a snapshot object/,
    },
    {
      name: 'an invalid next version',
      migrations: { 0: () => ({ v: 'next', scopes: {} }) },
      message: /invalid schema version/,
    },
    {
      name: 'a non-advancing version',
      migrations: { 0: () => ({ v: 0, scopes: {} }) },
      message: /did not advance/,
    },
    {
      name: 'a version cycle',
      migrations: {
        0: () => ({ v: 1, scopes: {} }),
        1: () => ({ v: 0, scopes: {} }),
      },
      message: /produced a cycle/,
    },
  ])('rejects snapshot migrations that produce $name', ({ migrations, message }) => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: 0,
        scopes: { sGuarded: { id: 'sGuarded', slots: [] } },
      }),
    )

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      snapshotMigrations: migrations,
      onSnapshotIssue: issue => issues.push(issue),
    })

    expect(__fictGetSSRScope('sGuarded')).toBeUndefined()
    expect(issues).toHaveLength(1)
    expect(issues[0]).toEqual(
      expect.objectContaining({ code: 'snapshot_migration_failed', actualVersion: 0 }),
    )
    expect(issues[0]?.message).toMatch(message)
  })

  it('reports a missing migration step as an unsupported snapshot version', () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: 0,
        scopes: { sUnsupported: { id: 'sUnsupported', slots: [] } },
      }),
    )

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      snapshotMigrations: {},
      onSnapshotIssue: issue => issues.push(issue),
    })

    expect(__fictGetSSRScope('sUnsupported')).toBeUndefined()
    expect(issues).toEqual([
      expect.objectContaining({ code: 'snapshot_unsupported_version', actualVersion: 0 }),
    ])
  })

  it('reports parse and shape errors for invalid snapshots', () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots('{not-valid-json', [
      JSON.stringify({ v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION, scopes: [] }),
    ])

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })

    expect(issues.some(issue => issue.code === 'snapshot_parse_error')).toBe(true)
    expect(issues.some(issue => issue.code === 'snapshot_invalid_shape')).toBe(true)
  })

  it('rejects malformed incremental scopes without corrupting valid snapshots', () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sBase: { id: 'sBase', slots: [[0, 'raw', 'base']] },
        },
      }),
      [
        JSON.stringify({
          v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
          scopes: {
            sBroken: { id: 'sBroken', slots: 'not-an-array' },
          },
        }),
        JSON.stringify({
          v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
          scopes: {
            sLater: { id: 'sLater', slots: [[0, 'raw', 'later']] },
          },
        }),
      ],
    )

    expect(() =>
      installResumableLoader({
        document: doc,
        events: [],
        prefetch: false,
        onSnapshotIssue: issue => issues.push(issue),
      }),
    ).not.toThrow()

    expect(__fictGetSSRScope('sBase')?.slots[0]?.[2]).toBe('base')
    expect(__fictGetSSRScope('sBroken')).toBeUndefined()
    expect(__fictGetSSRScope('sLater')?.slots[0]?.[2]).toBe('later')
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'snapshot_invalid_shape',
        source: '<script[data-fict-snapshot]>',
      }),
    )
  })

  it('rejects malformed live revisions before mutating any resumed scope', async () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sFirst: {
            id: 'sFirst',
            slots: [[0, 'sig', 1]],
            vars: { value: 0 },
          },
          sSecond: {
            id: 'sSecond',
            slots: [[0, 'sig', 1]],
            vars: { value: 0 },
          },
        },
      }),
    )

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })

    const firstSnapshot = __fictGetSSRScope('sFirst')
    const secondSnapshot = __fictGetSSRScope('sSecond')
    __fictEnsureScope('sFirst', doc.createElement('div'), firstSnapshot)
    __fictEnsureScope('sSecond', doc.createElement('div'), secondSnapshot)
    const first = __fictUseLexicalScope('sFirst', ['value'])[0] as {
      (): number
      (value: number): void
    }
    const second = __fictUseLexicalScope('sSecond', ['value'])[0] as () => number
    first(9)

    const script = doc.createElement('script')
    script.type = 'application/json'
    script.setAttribute('data-fict-snapshot', '')
    script.textContent = JSON.stringify({
      v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
      scopes: {
        sFirst: {
          id: 'sFirst',
          slots: [[0, 'sig', 2]],
          vars: { value: 0 },
        },
        sSecond: {
          id: 'sSecond',
          slots: [[0, 'sig', { __t: 'ref', v: '$.missing' }]],
          vars: { value: 0 },
        },
      },
    })
    doc.body.appendChild(script)

    await vi.waitFor(() => {
      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'snapshot_invalid_shape',
          source: '<script[data-fict-snapshot]>',
        }),
      )
    })
    expect(first()).toBe(9)
    expect(second()).toBe(1)
    expect(__fictGetSSRScope('sFirst')?.slots[0]?.[2]).toBe(1)
    expect(__fictGetSSRScope('sSecond')?.slots[0]?.[2]).toBe(1)

    // The failed multi-scope prepare must not persist the tentative client-owned
    // decision for sFirst. Once it converges to the accepted baseline, a later
    // valid revision can still update it.
    first(1)
    const retry = doc.createElement('script')
    retry.type = 'application/json'
    retry.setAttribute('data-fict-snapshot', '')
    retry.textContent = JSON.stringify({
      v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
      scopes: {
        sFirst: {
          id: 'sFirst',
          slots: [[0, 'sig', 2]],
          vars: { value: 0 },
        },
        sSecond: {
          id: 'sSecond',
          slots: [[0, 'sig', 2]],
          vars: { value: 0 },
        },
      },
    })
    doc.body.appendChild(retry)

    await vi.waitFor(() => {
      expect(__fictGetSSRScope('sSecond')?.slots[0]?.[2]).toBe(2)
    })
    expect(first()).toBe(2)
    expect(second()).toBe(2)
  })

  it('commits every scope in one streamed revision before flushing effects', async () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sFirst: {
            id: 'sFirst',
            slots: [[0, 'sig', 1]],
            vars: { value: 0 },
          },
          sSecond: {
            id: 'sSecond',
            slots: [[0, 'sig', 1]],
            vars: { value: 0 },
          },
        },
      }),
    )

    installResumableLoader({ document: doc, events: [], prefetch: false })
    const firstSnapshot = __fictGetSSRScope('sFirst')
    const secondSnapshot = __fictGetSSRScope('sSecond')
    __fictEnsureScope('sFirst', doc.createElement('div'), firstSnapshot)
    __fictEnsureScope('sSecond', doc.createElement('div'), secondSnapshot)
    const first = __fictUseLexicalScope('sFirst', ['value'])[0] as () => number
    const second = __fictUseLexicalScope('sSecond', ['value'])[0] as () => number
    const observed: Array<[number, number]> = []
    const dispose = createEffect(() => {
      observed.push([first(), second()])
    })

    try {
      const script = doc.createElement('script')
      script.type = 'application/json'
      script.setAttribute('data-fict-snapshot', '')
      script.textContent = JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sFirst: {
            id: 'sFirst',
            slots: [[0, 'sig', 2]],
            vars: { value: 0 },
          },
          sSecond: {
            id: 'sSecond',
            slots: [[0, 'sig', 2]],
            vars: { value: 0 },
          },
        },
      })
      doc.body.appendChild(script)

      await vi.waitFor(() => {
        expect(__fictGetSSRScope('sSecond')?.slots[0]?.[2]).toBe(2)
      })
      expect(observed).toEqual([
        [1, 1],
        [2, 2],
      ])
    } finally {
      dispose()
    }
  })

  it.each(['set', 'merge'] as const)(
    'publishes %s snapshot state before a live revision effect can throw',
    operation => {
      const scope = (value: number) => ({
        id: 'sEffect',
        slots: [[0, 'sig', value] as [number, 'sig', number]],
        vars: { value: 0 },
      })
      __fictSetSSRState({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: { sEffect: scope(1) },
      })
      __fictEnsureScope('sEffect', document.createElement('div'), __fictGetSSRScope('sEffect'))
      const signal = __fictUseLexicalScope('sEffect', ['value'])[0] as () => number
      const effectError = new Error(`${operation} effect failed`)
      let snapshotDuringFlush: unknown
      const dispose = createEffect(() => {
        if (signal() !== 2) return
        snapshotDuringFlush = __fictGetSSRScope('sEffect')?.slots[0]?.[2]
        throw effectError
      })
      const apply = (value: number) => {
        const state = {
          v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
          scopes: { sEffect: scope(value) },
        }
        if (operation === 'set') {
          __fictSetSSRState(state)
        } else {
          __fictMergeSSRState(state)
        }
      }

      let thrown: unknown
      try {
        apply(2)
      } catch (error) {
        thrown = error
      } finally {
        dispose()
      }
      expect(thrown).toMatchObject({ message: effectError.message, cause: effectError })
      expect(snapshotDuringFlush).toBe(2)
      expect(__fictGetSSRScope('sEffect')?.slots[0]?.[2]).toBe(2)
      expect(signal()).toBe(2)

      // A later revision proves the live baseline advanced with the state that
      // was already published before the failed effect flush.
      apply(3)
      expect(__fictGetSSRScope('sEffect')?.slots[0]?.[2]).toBe(3)
      expect(signal()).toBe(3)
    },
  )

  it('keeps loader state aligned after a committed streamed effect fails', async () => {
    const issues: SnapshotIssue[] = []
    const fallback = vi.fn()
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sEffect: {
            id: 'sEffect',
            slots: [[0, 'sig', 1]],
            vars: { value: 0 },
          },
          sOther: {
            id: 'sOther',
            slots: [[0, 'raw', 1]],
            vars: { value: 0 },
          },
        },
      }),
    )
    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
      onSnapshotRejected: fallback,
    })
    __fictEnsureScope('sEffect', doc.createElement('div'), __fictGetSSRScope('sEffect'))
    const signal = __fictUseLexicalScope('sEffect', ['value'])[0] as () => number
    const effectError = new Error('streamed effect failed')
    const dispose = createEffect(() => {
      if (signal() === 2) throw effectError
    })

    try {
      const appendSnapshot = (scopes: Record<string, unknown>) => {
        const script = doc.createElement('script')
        script.type = 'application/json'
        script.setAttribute('data-fict-snapshot', '')
        script.textContent = JSON.stringify({
          v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
          scopes,
        })
        doc.body.appendChild(script)
      }

      appendSnapshot({
        sEffect: {
          id: 'sEffect',
          slots: [[0, 'sig', 2]],
          vars: { value: 0 },
        },
      })
      await vi.waitFor(() => {
        expect(issues).toContainEqual(
          expect.objectContaining({
            code: 'snapshot_effect_failed',
            error: effectError,
          }),
        )
      })
      expect(fallback).not.toHaveBeenCalled()
      expect(signal()).toBe(2)
      expect(__fictGetSSRScope('sEffect')?.slots[0]?.[2]).toBe(2)
      expect(__fictUseLexicalScope('sEffect', ['value'])[0]).toBe(signal)

      // This payload does not mention sEffect. The loader must merge it over the
      // committed installation state instead of replaying stale sEffect=1.
      appendSnapshot({
        sOther: {
          id: 'sOther',
          slots: [[0, 'raw', 2]],
          vars: { value: 0 },
        },
      })
      await vi.waitFor(() => {
        expect(__fictGetSSRScope('sOther')?.slots[0]?.[2]).toBe(2)
      })
      expect(signal()).toBe(2)
      expect(__fictGetSSRScope('sEffect')?.slots[0]?.[2]).toBe(2)
      expect(fallback).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  it('rejects descriptor-mutated stores before publishing any scope in a revision', async () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sSignal: {
            id: 'sSignal',
            slots: [[0, 'sig', 1]],
            vars: { value: 0 },
          },
          sStore: {
            id: 'sStore',
            slots: [[0, 'store', { nested: { value: 1 } }]],
            vars: { store: 0 },
          },
        },
      }),
    )

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })
    __fictEnsureScope('sSignal', doc.createElement('div'), __fictGetSSRScope('sSignal'))
    __fictEnsureScope('sStore', doc.createElement('div'), __fictGetSSRScope('sStore'))
    const signal = __fictUseLexicalScope('sSignal', ['value'])[0] as () => number
    const store = __fictUseLexicalScope('sStore', ['store'])[0] as {
      nested: { value: number }
    }
    const rawStore = unwrapStore(store)
    Object.defineProperty(rawStore.nested, 'value', {
      value: 1,
      writable: false,
      enumerable: true,
      configurable: true,
    })

    const appendRevision = () => {
      const script = doc.createElement('script')
      script.type = 'application/json'
      script.setAttribute('data-fict-snapshot', '')
      script.textContent = JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sSignal: {
            id: 'sSignal',
            slots: [[0, 'sig', 2]],
            vars: { value: 0 },
          },
          sStore: {
            id: 'sStore',
            slots: [[0, 'store', { nested: { value: 2 } }]],
            vars: { store: 0 },
          },
        },
      })
      doc.body.appendChild(script)
    }

    appendRevision()
    await vi.waitFor(() => {
      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'snapshot_invalid_shape',
          message: expect.stringContaining('store property descriptor is not canonical'),
        }),
      )
    })
    expect(signal()).toBe(1)
    expect(store.nested.value).toBe(1)
    expect(__fictGetSSRScope('sSignal')?.slots[0]?.[2]).toBe(1)
    expect(__fictGetSSRScope('sStore')?.slots[0]?.[2]).toEqual({ nested: { value: 1 } })

    Object.defineProperty(rawStore.nested, 'value', {
      value: 1,
      writable: true,
      enumerable: true,
      configurable: true,
    })
    appendRevision()
    await vi.waitFor(() => {
      expect(__fictGetSSRScope('sStore')?.slots[0]?.[2]).toEqual({ nested: { value: 2 } })
    })
    expect(signal()).toBe(2)
    expect(store.nested.value).toBe(2)
  })

  it('makes a value-equal replacement signal client-owned without blocking siblings', async () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sOther: {
            id: 'sOther',
            slots: [[0, 'sig', 1]],
            vars: { value: 0 },
          },
          sSignal: {
            id: 'sSignal',
            slots: [[0, 'sig', 1]],
            vars: { value: 0 },
          },
        },
      }),
    )
    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })
    __fictEnsureScope('sOther', doc.createElement('div'), __fictGetSSRScope('sOther'))
    const signalContext = __fictEnsureScope(
      'sSignal',
      doc.createElement('div'),
      __fictGetSSRScope('sSignal'),
    )
    const other = __fictUseLexicalScope('sOther', ['value'])[0] as () => number
    const original = __fictUseLexicalScope('sSignal', ['value'])[0] as () => number
    const replacement = createSignal(1)
    signalContext.slots[0] = replacement

    const appendRevision = (value: number) => {
      const script = doc.createElement('script')
      script.type = 'application/json'
      script.setAttribute('data-fict-snapshot', '')
      script.textContent = JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sOther: {
            id: 'sOther',
            slots: [[0, 'sig', value]],
            vars: { value: 0 },
          },
          sSignal: {
            id: 'sSignal',
            slots: [[0, 'sig', value]],
            vars: { value: 0 },
          },
        },
      })
      doc.body.appendChild(script)
    }

    appendRevision(2)
    await vi.waitFor(() => {
      expect(__fictGetSSRScope('sSignal')?.slots[0]?.[2]).toBe(2)
    })
    expect(other()).toBe(2)
    expect(original()).toBe(1)
    expect(replacement()).toBe(1)
    expect(signalContext.slots[0]).toBe(replacement)
    expect(__fictGetSSRScope('sOther')?.slots[0]?.[2]).toBe(2)
    expect(issues).toEqual([])

    appendRevision(3)
    await vi.waitFor(() => {
      expect(__fictGetSSRScope('sSignal')?.slots[0]?.[2]).toBe(3)
    })
    expect(other()).toBe(3)
    expect(original()).toBe(1)
    expect(replacement()).toBe(1)
    expect(signalContext.slots[0]).toBe(replacement)
    expect(issues).toEqual([])
  })

  it('makes a value-equal replacement store client-owned without using its captured setter', async () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sOther: {
            id: 'sOther',
            slots: [[0, 'sig', 1]],
            vars: { value: 0 },
          },
          sStore: {
            id: 'sStore',
            slots: [[0, 'store', { value: 1 }]],
            vars: { store: 0 },
          },
        },
      }),
    )
    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })
    __fictEnsureScope('sOther', doc.createElement('div'), __fictGetSSRScope('sOther'))
    const storeContext = __fictEnsureScope(
      'sStore',
      doc.createElement('div'),
      __fictGetSSRScope('sStore'),
    )
    const other = __fictUseLexicalScope('sOther', ['value'])[0] as () => number
    const original = __fictUseLexicalScope('sStore', ['store'])[0] as { value: number }
    const [replacement] = createStore({ value: 1 })
    storeContext.slots[0] = replacement

    const appendRevision = (value: number) => {
      const script = doc.createElement('script')
      script.type = 'application/json'
      script.setAttribute('data-fict-snapshot', '')
      script.textContent = JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sOther: {
            id: 'sOther',
            slots: [[0, 'sig', value]],
            vars: { value: 0 },
          },
          sStore: {
            id: 'sStore',
            slots: [[0, 'store', { value }]],
            vars: { store: 0 },
          },
        },
      })
      doc.body.appendChild(script)
    }

    appendRevision(2)
    await vi.waitFor(() => {
      expect(__fictGetSSRScope('sStore')?.slots[0]?.[2]).toEqual({ value: 2 })
    })
    expect(other()).toBe(2)
    expect(original.value).toBe(1)
    expect(replacement.value).toBe(1)
    expect(storeContext.slots[0]).toBe(replacement)
    expect(__fictGetSSRScope('sOther')?.slots[0]?.[2]).toBe(2)
    expect(issues).toEqual([])

    appendRevision(3)
    await vi.waitFor(() => {
      expect(__fictGetSSRScope('sStore')?.slots[0]?.[2]).toEqual({ value: 3 })
    })
    expect(other()).toBe(3)
    expect(original.value).toBe(1)
    expect(replacement.value).toBe(1)
    expect(storeContext.slots[0]).toBe(replacement)
    expect(issues).toEqual([])
  })

  it('makes a value-equal nested store identity substitution client-owned', async () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sOther: {
            id: 'sOther',
            slots: [[0, 'sig', 1]],
            vars: { value: 0 },
          },
          sStore: {
            id: 'sStore',
            slots: [[0, 'store', { nested: { value: 1 } }]],
            vars: { store: 0 },
          },
        },
      }),
    )
    installResumableLoader({ document: doc, events: [], prefetch: false })
    __fictEnsureScope('sOther', doc.createElement('div'), __fictGetSSRScope('sOther'))
    __fictEnsureScope('sStore', doc.createElement('div'), __fictGetSSRScope('sStore'))
    const other = __fictUseLexicalScope('sOther', ['value'])[0] as () => number
    const store = __fictUseLexicalScope('sStore', ['store'])[0] as {
      nested: { value: number }
    }
    const external = { value: 1 }
    store.nested = external

    const appendRevision = (value: number) => {
      const script = doc.createElement('script')
      script.type = 'application/json'
      script.setAttribute('data-fict-snapshot', '')
      script.textContent = JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sOther: {
            id: 'sOther',
            slots: [[0, 'sig', value]],
            vars: { value: 0 },
          },
          sStore: {
            id: 'sStore',
            slots: [[0, 'store', { nested: { value } }]],
            vars: { store: 0 },
          },
        },
      })
      doc.body.appendChild(script)
    }

    appendRevision(2)
    await vi.waitFor(() => {
      expect(__fictGetSSRScope('sStore')?.slots[0]?.[2]).toEqual({ nested: { value: 2 } })
    })
    expect(other()).toBe(2)
    expect(unwrapStore(store.nested)).toBe(external)
    expect(external.value).toBe(1)

    // Ownership remains sticky even if the external object later converges to
    // the accepted server baseline.
    external.value = 2
    appendRevision(3)
    await vi.waitFor(() => {
      expect(__fictGetSSRScope('sStore')?.slots[0]?.[2]).toEqual({ nested: { value: 3 } })
    })
    expect(other()).toBe(3)
    expect(unwrapStore(store.nested)).toBe(external)
    expect(external.value).toBe(2)
  })

  it.each<{
    name: string
    initial: Record<string, unknown>
    next: Record<string, unknown>
    mutate: (raw: Record<string, unknown>) => void
    reason: string
  }>([
    {
      name: 'a non-extensible nested object',
      initial: { nested: { value: 1 } },
      next: { nested: { value: 2 } },
      mutate(raw) {
        Object.preventExtensions(raw.nested as object)
      },
      reason: 'store node is not extensible',
    },
    {
      name: 'an accessor descriptor',
      initial: { nested: { value: 1 } },
      next: { nested: { value: 2 } },
      mutate(raw) {
        Object.defineProperty(raw.nested as object, 'value', {
          get: () => 1,
          enumerable: true,
          configurable: true,
        })
      },
      reason: 'store property descriptor is not canonical',
    },
    {
      name: 'a non-configurable descriptor',
      initial: { nested: { value: 1 } },
      next: { nested: { value: 2 } },
      mutate(raw) {
        Object.defineProperty(raw.nested as object, 'value', {
          value: 1,
          writable: true,
          enumerable: true,
          configurable: false,
        })
      },
      reason: 'store property descriptor is not canonical',
    },
    {
      name: 'a non-writable array length',
      initial: { items: [1] },
      next: { items: [1, 2] },
      mutate(raw) {
        Object.defineProperty(raw.items as unknown[], 'length', { writable: false })
      },
      reason: 'array length is not writable',
    },
    {
      name: 'a new __proto__ key',
      initial: { safe: 1 },
      next: JSON.parse('{"safe":1,"__proto__":{"polluted":true}}') as Record<string, unknown>,
      mutate() {},
      reason: 'adding __proto__ would invoke an inherited setter',
    },
  ])('fails closed before reconciling $name', async ({ initial, next, mutate, reason }) => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sStore: {
            id: 'sStore',
            slots: [[0, 'store', initial]],
            vars: { store: 0 },
          },
        },
      }),
    )
    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })
    __fictEnsureScope('sStore', doc.createElement('div'), __fictGetSSRScope('sStore'))
    const store = __fictUseLexicalScope('sStore', ['store'])[0] as Record<string, unknown>
    const raw = unwrapStore(store)
    mutate(raw)

    const script = doc.createElement('script')
    script.type = 'application/json'
    script.setAttribute('data-fict-snapshot', '')
    script.textContent = JSON.stringify({
      v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
      scopes: {
        sStore: {
          id: 'sStore',
          slots: [[0, 'store', next]],
          vars: { store: 0 },
        },
      },
    })
    doc.body.appendChild(script)

    await vi.waitFor(() => {
      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'snapshot_invalid_shape',
          message: expect.stringContaining(reason),
        }),
      )
    })
    expect(__fictGetSSRScope('sStore')?.slots[0]?.[2]).toEqual(initial)
    if (Object.prototype.hasOwnProperty.call(next, '__proto__')) {
      expect(Object.getPrototypeOf(raw)).toBe(Object.prototype)
    }
  })

  it('fails closed when a streamed store shares reference topology with another slot', async () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sAliased: {
            id: 'sAliased',
            slots: [
              [0, 'store', { value: 1 }],
              [1, 'raw', { __t: 'ref', v: '$[0]' }],
            ],
            vars: { store: 0, raw: 1 },
          },
        },
      }),
    )

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })
    const initialSnapshot = __fictGetSSRScope('sAliased')
    __fictEnsureScope('sAliased', doc.createElement('div'), initialSnapshot)
    const [store, raw] = __fictUseLexicalScope('sAliased', ['store', 'raw']) as [
      { value: number },
      { value: number },
    ]

    const script = doc.createElement('script')
    script.type = 'application/json'
    script.setAttribute('data-fict-snapshot', '')
    script.textContent = JSON.stringify({
      v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
      scopes: {
        sAliased: {
          id: 'sAliased',
          slots: [
            [0, 'store', { value: 2 }],
            [1, 'raw', { __t: 'ref', v: '$[0]' }],
          ],
          vars: { store: 0, raw: 1 },
        },
      },
    })
    doc.body.appendChild(script)

    await vi.waitFor(() => {
      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'snapshot_invalid_shape',
          message: expect.stringContaining('store aliases or cycles cannot be reconciled safely'),
        }),
      )
    })
    expect(store.value).toBe(1)
    expect(raw.value).toBe(1)
    expect(__fictGetSSRScope('sAliased')?.slots[0]?.[2]).toEqual({ value: 1 })
  })

  it('preserves streamed alias topology across signal, raw, and props roots', async () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sAliased: {
            id: 'sAliased',
            slots: [
              [0, 'sig', { value: 1 }],
              [1, 'raw', { __t: 'ref', v: '$[0]' }],
            ],
            props: { __t: 'ref', v: '$[0]' },
            vars: { signal: 0, raw: 1 },
          },
        },
      }),
    )

    installResumableLoader({ document: doc, events: [], prefetch: false })
    const initialSnapshot = __fictGetSSRScope('sAliased')
    __fictEnsureScope('sAliased', doc.createElement('div'), initialSnapshot)

    const script = doc.createElement('script')
    script.type = 'application/json'
    script.setAttribute('data-fict-snapshot', '')
    script.textContent = JSON.stringify({
      v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
      scopes: {
        sAliased: {
          id: 'sAliased',
          slots: [
            [0, 'sig', { value: 1 }],
            [1, 'raw', { value: 1 }],
          ],
          props: { __t: 'ref', v: '$[1]' },
          vars: { signal: 0, raw: 1 },
        },
      },
    })
    doc.body.appendChild(script)

    await vi.waitFor(() => {
      expect(__fictGetSSRScope('sAliased')?.props).toEqual({ __t: 'ref', v: '$[1]' })
    })
    const [signal, raw] = __fictUseLexicalScope('sAliased', ['signal', 'raw']) as [
      () => { value: number },
      { value: number },
    ]
    expect(signal()).toEqual({ value: 1 })
    expect(signal()).not.toBe(raw)
    expect(raw).toEqual({ value: 1 })
    expect(__fictGetScopeProps('sAliased')).toBe(raw)
  })

  it('fails closed when a resumable component props identity may already be captured', async () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sProps: {
            id: 'sProps',
            slots: [],
            props: { value: 1 },
          },
        },
      }),
    )

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })
    const host = doc.createElement('div')
    host.setAttribute('data-fict-h', 'data:text/javascript,export default null#resume')
    __fictEnsureScope('sProps', host, __fictGetSSRScope('sProps'))

    const script = doc.createElement('script')
    script.type = 'application/json'
    script.setAttribute('data-fict-snapshot', '')
    script.textContent = JSON.stringify({
      v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
      scopes: {
        sProps: {
          id: 'sProps',
          slots: [],
          props: { value: 2 },
        },
      },
    })
    doc.body.appendChild(script)

    await vi.waitFor(() => {
      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'snapshot_invalid_shape',
          message: expect.stringContaining(
            'component props identity may already be captured by hydration',
          ),
        }),
      )
    })
    expect(__fictGetScopeProps('sProps')).toEqual({ value: 1 })
    expect(__fictGetSSRScope('sProps')?.props).toEqual({ value: 1 })
  })

  it('retries an incremental snapshot after its partial payload is completed', async () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {},
      }),
    )

    installResumableLoader({ document: doc, events: [], prefetch: false })

    const script = doc.createElement('script')
    script.type = 'application/json'
    script.setAttribute('data-fict-snapshot', '')
    doc.body.appendChild(script)
    await Promise.resolve()

    script.textContent = JSON.stringify({
      v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
      scopes: {
        sStreamed: { id: 'sStreamed', slots: [[0, 'raw', 'complete']] },
      },
    })

    await vi.waitFor(() => {
      expect(__fictGetSSRScope('sStreamed')?.slots[0]?.[2]).toBe('complete')
    })
  })

  it('observes nested legacy snapshot scripts using the configured id', async () => {
    const doc = createDocumentWithSnapshots()
    const snapshotScriptId = 'fict:snapshot[static]'

    installResumableLoader({
      document: doc,
      events: [],
      prefetch: false,
      snapshotScriptId,
    })

    const fragment = doc.createElement('section')
    const script = doc.createElement('script')
    script.id = snapshotScriptId
    script.type = 'application/json'
    script.textContent = JSON.stringify({
      v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
      scopes: {
        sLateStatic: { id: 'sLateStatic', slots: [[0, 'raw', 'late-static']] },
      },
    })
    fragment.appendChild(script)
    doc.body.appendChild(fragment)

    await vi.waitFor(() => {
      expect(__fictGetSSRScope('sLateStatic')?.slots[0]?.[2]).toBe('late-static')
    })
  })

  it('observes streamed snapshots with the installed document realm', async () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const doc = iframe.contentDocument
    const foreignObserver = iframe.contentWindow?.MutationObserver
    expect(doc).not.toBeNull()
    expect(foreignObserver).toBeTypeOf('function')

    vi.stubGlobal('MutationObserver', undefined)
    try {
      installResumableLoader({ document: doc!, events: [], prefetch: false })

      const script = doc!.createElement('script')
      script.type = 'application/json'
      script.setAttribute('data-fict-snapshot', '')
      script.textContent = JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sForeignStreamed: {
            id: 'sForeignStreamed',
            slots: [[0, 'raw', 'foreign-complete']],
          },
        },
      })
      doc!.body.appendChild(script)

      await vi.waitFor(() => {
        expect(__fictGetSSRScope('sForeignStreamed')?.slots[0]?.[2]).toBe('foreign-complete')
      })
    } finally {
      vi.unstubAllGlobals()
      iframe.remove()
    }
  })

  it('merges streamed revisions into resumed scopes without overwriting client-owned state', async () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sStreamed: {
            id: 'sStreamed',
            slots: [
              [0, 'sig', 1],
              [1, 'store', { value: 1 }],
              [2, 'raw', { value: 1 }],
            ],
            vars: { count: 0, store: 1, raw: 2 },
          },
        },
      }),
    )
    const observed: Array<[number, number, number]> = []
    ;(
      globalThis as {
        __fictReadStreamedScope?: (scopeId: string) => void
      }
    ).__fictReadStreamedScope = scopeId => {
      const [count, store, raw] = __fictUseLexicalScope(scopeId, ['count', 'store', 'raw']) as [
        () => number,
        { value: number },
        { value: number },
      ]
      observed.push([count(), store.value, raw.value])
    }

    const host = doc.createElement('div')
    host.setAttribute('data-fict-s', 'sStreamed')
    const button = doc.createElement('button')
    button.setAttribute(
      'on:click',
      'data:text/javascript,export function handle(scopeId){globalThis.__fictReadStreamedScope(scopeId)}#handle',
    )
    host.appendChild(button)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitForPendingHandlers()
    expect(observed).toEqual([[1, 1, 1]])

    const [count, store] = __fictUseLexicalScope('sStreamed', ['count', 'store']) as [
      {
        (): number
        (value: number): void
      },
      { value: number },
    ]
    const appendRevision = (value: number) => {
      const script = doc.createElement('script')
      script.type = 'application/json'
      script.setAttribute('data-fict-snapshot', '')
      script.textContent = JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sStreamed: {
            id: 'sStreamed',
            slots: [
              [0, 'sig', value],
              [1, 'store', { value }],
              [2, 'raw', { value }],
            ],
            vars: { count: 0, store: 1, raw: 2 },
          },
        },
      })
      doc.body.appendChild(script)
    }

    appendRevision(2)
    await vi.waitFor(() => {
      expect(__fictGetSSRScope('sStreamed')?.slots[0]?.[2]).toBe(2)
    })
    expect(count()).toBe(2)
    expect(store.value).toBe(2)
    expect(__fictUseLexicalScope('sStreamed', ['store'])[0]).toBe(store)
    expect(__fictUseLexicalScope('sStreamed', ['raw'])[0]).toEqual({ value: 2 })

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitForPendingHandlers()
    expect(observed).toEqual([
      [1, 1, 1],
      [2, 2, 2],
    ])

    count(9)
    store.value = 9
    const clientRaw = __fictUseLexicalScope('sStreamed', ['raw'])[0] as { value: number }
    clientRaw.value = 9
    appendRevision(3)
    await vi.waitFor(() => {
      expect(__fictGetSSRScope('sStreamed')?.slots[0]?.[2]).toBe(3)
    })
    expect(count()).toBe(9)
    expect(store.value).toBe(9)
    expect(__fictUseLexicalScope('sStreamed', ['raw'])[0]).toBe(clientRaw)
    expect(clientRaw.value).toBe(9)

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitForPendingHandlers()
    expect(observed).toEqual([
      [1, 1, 1],
      [2, 2, 2],
      [9, 9, 9],
    ])

    // Converging back to the latest server baseline must not let a later
    // revision reclaim a scope that the client already owns.
    count(3)
    store.value = 3
    clientRaw.value = 3
    appendRevision(4)
    await vi.waitFor(() => {
      expect(__fictGetSSRScope('sStreamed')?.slots[0]?.[2]).toBe(4)
    })
    expect(count()).toBe(3)
    expect(store.value).toBe(3)
    expect(clientRaw.value).toBe(3)

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitForPendingHandlers()
    expect(observed.at(-1)).toEqual([3, 3, 3])

    delete (
      globalThis as {
        __fictReadStreamedScope?: (scopeId: string) => void
      }
    ).__fictReadStreamedScope
  })

  describe('resumed scope teardown', () => {
    const createLifecycleDocument = (...scopeIds: string[]): Document =>
      createDocumentWithSnapshots(
        JSON.stringify({
          v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
          scopes: Object.fromEntries(
            scopeIds.map(scopeId => [
              scopeId,
              {
                id: scopeId,
                slots: [
                  [0, 'sig', 1],
                  [1, 'store', { value: 1 }],
                ],
                vars: { signal: 0, store: 1 },
              },
            ]),
          ),
        }),
      )

    const appendLifecycleHost = (
      doc: Document,
      scopeId: string,
      resumeName: string,
      parent: ParentNode = doc.body,
    ): HTMLElement => {
      const host = doc.createElement('div')
      host.setAttribute('data-fict-s', scopeId)
      host.setAttribute('data-fict-h', `data:text/javascript,export default null#${resumeName}`)
      host.setAttribute(
        'on:click',
        'data:text/javascript,export default function handle(){}#default',
      )
      parent.appendChild(host)
      return host
    }

    const resumeHost = async (host: HTMLElement): Promise<void> => {
      host.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
      await waitForPendingHandlers()
    }

    const resumeShadowHost = async (host: HTMLElement): Promise<void> => {
      host.dispatchEvent(new Event('click', { bubbles: true, cancelable: true, composed: true }))
      await waitForPendingHandlers()
    }

    it.each(['open', 'closed'] as const)(
      'releases a resumed scope removed directly from an %s shadow root',
      async mode => {
        const scopeId = `sShadow-${mode}`
        const resumeName = `__fict_teardown_shadow_${mode}`
        const doc = createLifecycleDocument(scopeId)
        const shadowHost = doc.createElement('section')
        doc.body.appendChild(shadowHost)
        const shadowRoot = shadowHost.attachShadow({ mode })
        const host = appendLifecycleHost(doc, scopeId, resumeName, shadowRoot)
        const probe = createLifecycleProbe()
        __fictRegisterResume(resumeName, (resumedScopeId, node) => {
          hydrateResumedScopeProbe(resumedScopeId as string, node as Element, probe)
        })
        installResumableLoader({ document: doc, events: ['click'], prefetch: false })

        if (mode === 'open') {
          await resumeShadowHost(host)
        } else {
          // Closed shadow trees intentionally hide their internal composed path
          // from document listeners; exercise the same generated resume entry
          // directly while retaining the closed root reference.
          hydrateResumedScopeProbe(scopeId, host, probe)
        }
        expect(probe.effectRuns).toBe(1)
        if (mode === 'closed') {
          host.removeAttribute('data-fict-s')
        }
        host.remove()
        await vi.waitFor(() => expect(probe.destroys).toBe(1))

        expect(() => __fictUseLexicalScope(scopeId, ['signal'])).toThrow('Missing resumed scope')
        const runsAfterRemoval = probe.effectRuns
        probe.signal!(2)
        expect(probe.effectRuns).toBe(runsAfterRemoval)
        cleanupEventListeners()
        expect(probe.destroys).toBe(1)
      },
    )

    it('keeps a scope alive across shadow-root reparenting and observes its new root', async () => {
      const doc = createLifecycleDocument('sShadowMoved')
      const leftHost = doc.createElement('section')
      const rightHost = doc.createElement('section')
      doc.body.append(leftHost, rightHost)
      const leftRoot = leftHost.attachShadow({ mode: 'open' })
      const rightRoot = rightHost.attachShadow({ mode: 'closed' })
      const host = appendLifecycleHost(
        doc,
        'sShadowMoved',
        '__fict_teardown_shadow_moved',
        leftRoot,
      )
      const probe = createLifecycleProbe()
      __fictRegisterResume('__fict_teardown_shadow_moved', (scopeId, node) => {
        hydrateResumedScopeProbe(scopeId as string, node as Element, probe)
      })
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })

      await resumeShadowHost(host)
      rightRoot.appendChild(host)
      await flushMutationObservers()

      expect(probe.destroys).toBe(0)
      const runsBeforeUpdate = probe.effectRuns
      probe.store!.value = 2
      await vi.waitFor(() => expect(probe.effectRuns).toBeGreaterThan(runsBeforeUpdate))

      host.remove()
      await vi.waitFor(() => expect(probe.destroys).toBe(1))
      cleanupEventListeners()
      expect(probe.destroys).toBe(1)
    })

    it('starts observing a closed shadow root entered after light-DOM hydration', async () => {
      const doc = createLifecycleDocument('sLightToShadow')
      const boundary = doc.createElement('section')
      doc.body.appendChild(boundary)
      const shadowRoot = boundary.attachShadow({ mode: 'closed' })
      const host = appendLifecycleHost(doc, 'sLightToShadow', '__fict_teardown_light_to_shadow')
      const probe = createLifecycleProbe()
      __fictRegisterResume('__fict_teardown_light_to_shadow', (scopeId, node) => {
        hydrateResumedScopeProbe(scopeId as string, node as Element, probe)
      })
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })

      await resumeHost(host)
      shadowRoot.appendChild(host)
      await flushMutationObservers()
      expect(probe.destroys).toBe(0)

      host.remove()
      await vi.waitFor(() => expect(probe.destroys).toBe(1))
      expect(() => __fictUseLexicalScope('sLightToShadow', ['signal'])).toThrow(
        'Missing resumed scope',
      )
    })

    it('releases a shadow scope while its first resume is still pending', async () => {
      const doc = createLifecycleDocument('sPendingShadow')
      const boundary = doc.createElement('section')
      doc.body.appendChild(boundary)
      const shadowRoot = boundary.attachShadow({ mode: 'open' })
      const host = appendLifecycleHost(
        doc,
        'sPendingShadow',
        '__fict_teardown_pending_shadow',
        shadowRoot,
      )
      let resumeStarted = false
      let releaseResume!: () => void
      const resumeGate = new Promise<void>(resolve => {
        releaseResume = resolve
      })
      __fictRegisterResume('__fict_teardown_pending_shadow', async () => {
        resumeStarted = true
        await resumeGate
      })
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })

      host.dispatchEvent(new Event('click', { bubbles: true, cancelable: true, composed: true }))
      await vi.waitFor(() => expect(resumeStarted).toBe(true))
      host.remove()
      await vi.waitFor(() =>
        expect(() => __fictUseLexicalScope('sPendingShadow', ['signal'])).toThrow(
          'Missing resumed scope',
        ),
      )

      releaseResume()
      await waitForPendingHandlers()
      cleanupEventListeners()
    })

    it('keeps a queued shadow removal observable across same-host scope lookup', async () => {
      const doc = createLifecycleDocument('sRemovedThenEnsured')
      const boundary = doc.createElement('section')
      doc.body.appendChild(boundary)
      const shadowRoot = boundary.attachShadow({ mode: 'closed' })
      const host = appendLifecycleHost(
        doc,
        'sRemovedThenEnsured',
        '__fict_teardown_removed_then_ensured',
        shadowRoot,
      )
      const probe = createLifecycleProbe()
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })
      hydrateResumedScopeProbe('sRemovedThenEnsured', host, probe)

      host.remove()
      expect(
        __fictEnsureScope('sRemovedThenEnsured', host, __fictGetSSRScope('sRemovedThenEnsured')),
      ).toBeDefined()
      await vi.waitFor(() => expect(probe.destroys).toBe(1))

      expect(() => __fictUseLexicalScope('sRemovedThenEnsured', ['signal'])).toThrow(
        'Missing resumed scope',
      )
    })

    it('releases a shadow scope when its connected shadow host is removed', async () => {
      const doc = createLifecycleDocument('sShadowBoundary')
      const shadowHost = doc.createElement('section')
      doc.body.appendChild(shadowHost)
      const shadowRoot = shadowHost.attachShadow({ mode: 'closed' })
      const host = appendLifecycleHost(
        doc,
        'sShadowBoundary',
        '__fict_teardown_shadow_boundary',
        shadowRoot,
      )
      const probe = createLifecycleProbe()
      __fictRegisterResume('__fict_teardown_shadow_boundary', (scopeId, node) => {
        hydrateResumedScopeProbe(scopeId as string, node as Element, probe)
      })
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })

      hydrateResumedScopeProbe('sShadowBoundary', host, probe)
      shadowHost.remove()
      await vi.waitFor(() => expect(probe.destroys).toBe(1))

      cleanupEventListeners()
      expect(probe.destroys).toBe(1)
    })

    it('observes every shadow boundary in a nested closed-root chain', async () => {
      const doc = createLifecycleDocument('sNestedShadow')
      const outerHost = doc.createElement('section')
      doc.body.appendChild(outerHost)
      const outerRoot = outerHost.attachShadow({ mode: 'open' })
      const innerHost = doc.createElement('article')
      outerRoot.appendChild(innerHost)
      const innerRoot = innerHost.attachShadow({ mode: 'closed' })
      const host = appendLifecycleHost(
        doc,
        'sNestedShadow',
        '__fict_teardown_nested_shadow',
        innerRoot,
      )
      const probe = createLifecycleProbe()
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })
      hydrateResumedScopeProbe('sNestedShadow', host, probe)

      innerHost.remove()
      await vi.waitFor(() => expect(probe.destroys).toBe(1))

      cleanupEventListeners()
      expect(probe.destroys).toBe(1)
    })

    it('disposes nested shadow hydration roots child-first', async () => {
      const doc = createLifecycleDocument('sShadowParent', 'sShadowChild')
      const boundary = doc.createElement('section')
      doc.body.appendChild(boundary)
      const outerRoot = boundary.attachShadow({ mode: 'closed' })
      const parentHost = appendLifecycleHost(
        doc,
        'sShadowParent',
        '__fict_teardown_shadow_parent',
        outerRoot,
      )
      const innerRoot = parentHost.attachShadow({ mode: 'closed' })
      const childHost = appendLifecycleHost(
        doc,
        'sShadowChild',
        '__fict_teardown_shadow_child',
        innerRoot,
      )
      const parentProbe = createLifecycleProbe()
      const childProbe = createLifecycleProbe()
      const destroyOrder: string[] = []
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })
      hydrateResumedScopeProbe(
        'sShadowParent',
        parentHost,
        parentProbe,
        __fictGetSSRScope('sShadowParent'),
        () => onDestroy(() => destroyOrder.push('parent')),
      )
      hydrateResumedScopeProbe(
        'sShadowChild',
        childHost,
        childProbe,
        __fictGetSSRScope('sShadowChild'),
        () => onDestroy(() => destroyOrder.push('child')),
      )

      boundary.remove()
      await vi.waitFor(() => {
        expect(parentProbe.destroys).toBe(1)
        expect(childProbe.destroys).toBe(1)
      })

      expect(destroyOrder).toEqual(['child', 'parent'])
    })

    it('shares and releases shadow-root observers by active scope lease count', async () => {
      const NativeObserver = MutationObserver
      const observerRecords: Array<{ disconnects: number }> = []
      class TrackingMutationObserver {
        private readonly inner: MutationObserver
        private readonly record = { disconnects: 0 }

        constructor(callback: MutationCallback) {
          this.inner = new NativeObserver(callback)
          observerRecords.push(this.record)
        }

        observe(target: Node, options?: MutationObserverInit): void {
          this.inner.observe(target, options)
        }

        disconnect(): void {
          this.record.disconnects++
          this.inner.disconnect()
        }

        takeRecords(): MutationRecord[] {
          return this.inner.takeRecords()
        }
      }

      vi.stubGlobal('MutationObserver', TrackingMutationObserver)
      try {
        const doc = createLifecycleDocument('sShadowLeaseA', 'sShadowLeaseB')
        const boundary = doc.createElement('section')
        doc.body.appendChild(boundary)
        const shadowRoot = boundary.attachShadow({ mode: 'closed' })
        const hostA = appendLifecycleHost(
          doc,
          'sShadowLeaseA',
          '__fict_teardown_shadow_lease_a',
          shadowRoot,
        )
        const hostB = appendLifecycleHost(
          doc,
          'sShadowLeaseB',
          '__fict_teardown_shadow_lease_b',
          shadowRoot,
        )
        const probeA = createLifecycleProbe()
        const probeB = createLifecycleProbe()
        installResumableLoader({ document: doc, events: ['click'], prefetch: false })
        hydrateResumedScopeProbe('sShadowLeaseA', hostA, probeA)
        hydrateResumedScopeProbe('sShadowLeaseB', hostB, probeB)

        expect(observerRecords).toHaveLength(3)
        hostA.remove()
        await vi.waitFor(() => expect(probeA.destroys).toBe(1))
        expect(observerRecords.reduce((sum, record) => sum + record.disconnects, 0)).toBe(0)

        hostB.remove()
        await vi.waitFor(() => expect(probeB.destroys).toBe(1))
        expect(observerRecords.reduce((sum, record) => sum + record.disconnects, 0)).toBe(2)

        cleanupEventListeners()
        expect(observerRecords.reduce((sum, record) => sum + record.disconnects, 0)).toBe(3)
      } finally {
        cleanupEventListeners()
        vi.unstubAllGlobals()
      }
    })

    it('rolls back every acquired root when a later shadow observer rejects setup', async () => {
      const doc = createLifecycleDocument('sObserveRejected', 'sObserveRetry')
      const boundary = doc.createElement('section')
      doc.body.appendChild(boundary)
      const outerRoot = boundary.attachShadow({ mode: 'closed' })
      const innerBoundary = doc.createElement('article')
      outerRoot.appendChild(innerBoundary)
      const innerRoot = innerBoundary.attachShadow({ mode: 'closed' })
      const rejectedHost = appendLifecycleHost(
        doc,
        'sObserveRejected',
        '__fict_teardown_observe_rejected',
        innerRoot,
      )
      const retryHost = appendLifecycleHost(
        doc,
        'sObserveRetry',
        '__fict_teardown_observe_retry',
        innerRoot,
      )
      const rejectedProbe = createLifecycleProbe()
      const retryProbe = createLifecycleProbe()
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })

      const NativeObserver = MutationObserver
      const observerRecords: Array<{ disconnects: number }> = []
      let observeCalls = 0
      class RejectingMutationObserver {
        private readonly inner: MutationObserver
        private readonly record = { disconnects: 0 }

        constructor(callback: MutationCallback) {
          this.inner = new NativeObserver(callback)
          observerRecords.push(this.record)
        }

        observe(target: Node, options?: MutationObserverInit): void {
          observeCalls++
          if (observeCalls === 2) throw new Error('shadow observe failed')
          this.inner.observe(target, options)
        }

        disconnect(): void {
          this.record.disconnects++
          this.inner.disconnect()
        }

        takeRecords(): MutationRecord[] {
          return this.inner.takeRecords()
        }
      }

      vi.stubGlobal('MutationObserver', RejectingMutationObserver)
      try {
        expect(() =>
          hydrateResumedScopeProbe('sObserveRejected', rejectedHost, rejectedProbe),
        ).toThrow('shadow observe failed')
        expect(() => __fictUseLexicalScope('sObserveRejected', ['signal'])).toThrow(
          'Missing resumed scope',
        )
        expect(observerRecords.slice(0, 2).map(record => record.disconnects)).toEqual([1, 1])

        hydrateResumedScopeProbe('sObserveRetry', retryHost, retryProbe)
        retryHost.remove()
        await vi.waitFor(() => expect(retryProbe.destroys).toBe(1))

        expect(observerRecords).toHaveLength(5)
        expect(observerRecords.map(record => record.disconnects)).toEqual([1, 1, 1, 1, 1])
      } finally {
        cleanupEventListeners()
        vi.unstubAllGlobals()
      }
    })

    it('finishes scope teardown when a shadow observer rejects disconnect', async () => {
      const doc = createLifecycleDocument('sDisconnectRejected', 'sDisconnectRetry')
      const boundary = doc.createElement('section')
      doc.body.appendChild(boundary)
      const shadowRoot = boundary.attachShadow({ mode: 'closed' })
      const rejectedHost = appendLifecycleHost(
        doc,
        'sDisconnectRejected',
        '__fict_teardown_disconnect_rejected',
        shadowRoot,
      )
      const retryHost = appendLifecycleHost(
        doc,
        'sDisconnectRetry',
        '__fict_teardown_disconnect_retry',
        shadowRoot,
      )
      const rejectedProbe = createLifecycleProbe()
      const retryProbe = createLifecycleProbe()
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })

      const NativeObserver = MutationObserver
      const observerRecords: Array<{ disconnects: number }> = []
      let rejectNextDisconnect = true
      class RejectingDisconnectObserver {
        private readonly inner: MutationObserver
        private readonly record = { disconnects: 0 }

        constructor(callback: MutationCallback) {
          this.inner = new NativeObserver(callback)
          observerRecords.push(this.record)
        }

        observe(target: Node, options?: MutationObserverInit): void {
          this.inner.observe(target, options)
        }

        disconnect(): void {
          this.record.disconnects++
          this.inner.disconnect()
          if (rejectNextDisconnect) {
            rejectNextDisconnect = false
            throw new Error('shadow disconnect failed')
          }
        }

        takeRecords(): MutationRecord[] {
          return this.inner.takeRecords()
        }
      }

      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('MutationObserver', RejectingDisconnectObserver)
      try {
        hydrateResumedScopeProbe('sDisconnectRejected', rejectedHost, rejectedProbe)
        rejectedHost.remove()
        await vi.waitFor(() => expect(rejectedProbe.destroys).toBe(1))
        expect(rejectedProbe.effectCleanups).toBe(1)
        expect(() => __fictUseLexicalScope('sDisconnectRejected', ['signal'])).toThrow(
          'Missing resumed scope',
        )
        expect(consoleError).toHaveBeenCalledWith(
          '[fict] Failed to disconnect a resumed scope observer.',
          expect.objectContaining({ message: 'shadow disconnect failed' }),
        )

        hydrateResumedScopeProbe('sDisconnectRetry', retryHost, retryProbe)
        retryHost.remove()
        await vi.waitFor(() => expect(retryProbe.destroys).toBe(1))

        expect(observerRecords).toHaveLength(4)
        expect(observerRecords.map(record => record.disconnects)).toEqual([1, 1, 1, 1])
      } finally {
        consoleError.mockRestore()
        cleanupEventListeners()
        vi.unstubAllGlobals()
      }
    })

    it('disposes once when shadow removal races loader cleanup and a queued drain', async () => {
      const doc = createLifecycleDocument('sShadowCleanupRace')
      const boundary = doc.createElement('section')
      doc.body.appendChild(boundary)
      const shadowRoot = boundary.attachShadow({ mode: 'closed' })
      const host = appendLifecycleHost(
        doc,
        'sShadowCleanupRace',
        '__fict_teardown_shadow_cleanup_race',
        shadowRoot,
      )
      const probe = createLifecycleProbe()
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })
      hydrateResumedScopeProbe('sShadowCleanupRace', host, probe)

      host.remove()
      await Promise.resolve()
      cleanupEventListeners()
      await flushMutationObservers()

      expect(probe.destroys).toBe(1)
      expect(probe.effectCleanups).toBe(1)
    })

    it('releases a permanently removed scope root, effects, store subscriptions, and registry exactly once', async () => {
      const doc = createLifecycleDocument('sRemoved')
      const host = appendLifecycleHost(doc, 'sRemoved', '__fict_teardown_removed')
      const probe = createLifecycleProbe()
      __fictRegisterResume('__fict_teardown_removed', (scopeId, node) => {
        hydrateResumedScopeProbe(scopeId as string, node as Element, probe)
      })
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })

      await resumeHost(host)
      expect(probe.effectRuns).toBe(1)
      probe.signal!(2)
      probe.store!.value = 2
      await vi.waitFor(() => expect(probe.effectRuns).toBeGreaterThan(1))
      const runsBeforeRemoval = probe.effectRuns
      const cleanupsBeforeRemoval = probe.effectCleanups

      host.remove()
      await vi.waitFor(() => expect(probe.destroys).toBe(1))

      expect(probe.effectCleanups).toBe(cleanupsBeforeRemoval + 1)
      expect(() => __fictUseLexicalScope('sRemoved', ['signal'])).toThrow('Missing resumed scope')
      probe.signal!(3)
      probe.store!.value = 3
      expect(probe.effectRuns).toBe(runsBeforeRemoval)

      cleanupEventListeners()
      await flushMutationObservers()
      expect(probe.destroys).toBe(1)
      expect(probe.effectCleanups).toBe(cleanupsBeforeRemoval + 1)
    })

    it('keeps a synchronously reparented scope alive and disposes once when removal races cleanup', async () => {
      const doc = createLifecycleDocument('sMoved')
      const from = doc.createElement('section')
      const to = doc.createElement('section')
      doc.body.append(from, to)
      const host = appendLifecycleHost(doc, 'sMoved', '__fict_teardown_moved', from)
      const probe = createLifecycleProbe()
      __fictRegisterResume('__fict_teardown_moved', (scopeId, node) => {
        hydrateResumedScopeProbe(scopeId as string, node as Element, probe)
      })
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })

      await resumeHost(host)
      to.appendChild(host)
      await flushMutationObservers()

      expect(probe.destroys).toBe(0)
      const runsBeforeUpdate = probe.effectRuns
      probe.store!.value = 2
      await vi.waitFor(() => expect(probe.effectRuns).toBeGreaterThan(runsBeforeUpdate))
      expect(__fictUseLexicalScope('sMoved', ['store'])[0]).toBe(probe.store)

      host.remove()
      cleanupEventListeners()
      await flushMutationObservers()
      expect(probe.destroys).toBe(1)
    })

    it('waits for other mutation observers to finish reparenting before teardown', async () => {
      const doc = createLifecycleDocument('sObserverMoved')
      const destination = doc.createElement('section')
      doc.body.appendChild(destination)
      const host = appendLifecycleHost(doc, 'sObserverMoved', '__fict_teardown_observer_moved')
      const probe = createLifecycleProbe()
      __fictRegisterResume('__fict_teardown_observer_moved', (scopeId, node) => {
        hydrateResumedScopeProbe(scopeId as string, node as Element, probe)
      })
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })
      await resumeHost(host)

      const Observer = doc.defaultView?.MutationObserver ?? MutationObserver
      const mover = new Observer(mutations => {
        if (
          mutations.some(mutation => Array.from(mutation.removedNodes).some(node => node === host))
        ) {
          destination.appendChild(host)
        }
      })
      mover.observe(doc.body, { childList: true, subtree: true })
      host.remove()
      await flushMutationObservers()

      expect(destination.contains(host)).toBe(true)
      expect(probe.destroys).toBe(0)
      const runsBeforeUpdate = probe.effectRuns
      probe.signal!(2)
      await vi.waitFor(() => expect(probe.effectRuns).toBeGreaterThan(runsBeforeUpdate))

      mover.disconnect()
      cleanupEventListeners()
      expect(probe.destroys).toBe(1)
    })

    it('resumes a replacement host with the same scope id before the removal observer drains', async () => {
      const doc = createLifecycleDocument('sReplaced')
      const oldProbe = createLifecycleProbe()
      const newProbe = createLifecycleProbe()
      const oldHost = appendLifecycleHost(doc, 'sReplaced', '__fict_teardown_replaced_old')
      __fictRegisterResume('__fict_teardown_replaced_old', (scopeId, node) => {
        hydrateResumedScopeProbe(scopeId as string, node as Element, oldProbe)
      })
      __fictRegisterResume('__fict_teardown_replaced_new', (scopeId, node) => {
        hydrateResumedScopeProbe(scopeId as string, node as Element, newProbe)
      })
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })
      await resumeHost(oldHost)

      oldHost.remove()
      const newHost = appendLifecycleHost(doc, 'sReplaced', '__fict_teardown_replaced_new')
      await resumeHost(newHost)

      expect(oldProbe.destroys).toBe(1)
      expect(newProbe.effectRuns).toBe(1)
      expect(newProbe.destroys).toBe(0)
      expect(__fictUseLexicalScope('sReplaced', ['store'])[0]).toBe(newProbe.store)

      cleanupEventListeners()
      expect(oldProbe.destroys).toBe(1)
      expect(newProbe.destroys).toBe(1)
    })

    it('tracks the hydration root before onMount can reenter loader cleanup', async () => {
      const doc = createLifecycleDocument('sReentrant')
      const probe = createLifecycleProbe()
      const host = appendLifecycleHost(doc, 'sReentrant', '__fict_teardown_reentrant')
      __fictRegisterResume('__fict_teardown_reentrant', (scopeId, node) => {
        hydrateResumedScopeProbe(
          scopeId as string,
          node as Element,
          probe,
          __fictGetSSRScope(scopeId as string),
          () => onMount(() => cleanupEventListeners()),
        )
      })
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })

      await resumeHost(host)

      expect(probe.destroys).toBe(1)
      expect(probe.effectCleanups).toBe(1)
      expect(() => __fictUseLexicalScope('sReentrant', ['signal'])).toThrow('Missing resumed scope')
      cleanupEventListeners()
      expect(probe.destroys).toBe(1)
    })

    it('disposes nested parent and child scope roots once each', async () => {
      const doc = createLifecycleDocument('sParent', 'sChild')
      const parentProbe = createLifecycleProbe()
      const childProbe = createLifecycleProbe()
      const parentHost = appendLifecycleHost(doc, 'sParent', '__fict_teardown_parent')
      __fictRegisterResume('__fict_teardown_parent', (scopeId, node) => {
        hydrateResumedScopeProbe(scopeId as string, node as Element, parentProbe)
      })
      __fictRegisterResume('__fict_teardown_child', (scopeId, node) => {
        hydrateResumedScopeProbe(scopeId as string, node as Element, childProbe)
      })
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })

      await resumeHost(parentHost)
      const childHost = appendLifecycleHost(doc, 'sChild', '__fict_teardown_child', parentHost)
      await resumeHost(childHost)
      expect(parentProbe.effectRuns).toBe(1)
      expect(childProbe.effectRuns).toBe(1)

      parentHost.remove()
      await vi.waitFor(() => {
        expect(parentProbe.destroys).toBe(1)
        expect(childProbe.destroys).toBe(1)
      })

      cleanupEventListeners()
      await flushMutationObservers()
      expect(parentProbe.destroys).toBe(1)
      expect(childProbe.destroys).toBe(1)
    })

    it('keeps a child scope alive when it is moved out before its parent is removed', async () => {
      const doc = createLifecycleDocument('sMoveParent', 'sMoveChild')
      const parentProbe = createLifecycleProbe()
      const childProbe = createLifecycleProbe()
      const parentHost = appendLifecycleHost(doc, 'sMoveParent', '__fict_teardown_move_parent')
      __fictRegisterResume('__fict_teardown_move_parent', (scopeId, node) => {
        hydrateResumedScopeProbe(scopeId as string, node as Element, parentProbe)
      })
      __fictRegisterResume('__fict_teardown_move_child', (scopeId, node) => {
        hydrateResumedScopeProbe(scopeId as string, node as Element, childProbe)
      })
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })
      await resumeHost(parentHost)
      const childHost = appendLifecycleHost(
        doc,
        'sMoveChild',
        '__fict_teardown_move_child',
        parentHost,
      )
      await resumeHost(childHost)

      doc.body.appendChild(childHost)
      parentHost.remove()
      await vi.waitFor(() => expect(parentProbe.destroys).toBe(1))

      expect(childProbe.destroys).toBe(0)
      const childRuns = childProbe.effectRuns
      childProbe.signal!(2)
      await vi.waitFor(() => expect(childProbe.effectRuns).toBeGreaterThan(childRuns))
      expect(__fictUseLexicalScope('sMoveChild', ['signal'])[0]).toBe(childProbe.signal)

      cleanupEventListeners()
      expect(parentProbe.destroys).toBe(1)
      expect(childProbe.destroys).toBe(1)
    })

    it.each(['host removal', 'loader cleanup'] as const)(
      'reclaims a delayed resume root that settles after %s',
      async action => {
        const doc = createLifecycleDocument('sDelayed')
        const host = appendLifecycleHost(doc, 'sDelayed', '__fict_teardown_delayed')
        const probe = createLifecycleProbe()
        let releaseResume!: () => void
        const resumeGate = new Promise<void>(resolve => {
          releaseResume = resolve
        })
        let resumeStarted = false
        let resumeFinished = false
        __fictRegisterResume('__fict_teardown_delayed', async (scopeId, node) => {
          const capturedSnapshot = __fictGetSSRScope(scopeId as string)
          resumeStarted = true
          await resumeGate
          hydrateResumedScopeProbe(scopeId as string, node as Element, probe, capturedSnapshot)
          resumeFinished = true
        })
        installResumableLoader({ document: doc, events: ['click'], prefetch: false })

        host.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
        await vi.waitFor(() => expect(resumeStarted).toBe(true))
        if (action === 'host removal') {
          host.remove()
          await flushMutationObservers()
        } else {
          cleanupEventListeners()
        }

        releaseResume()
        await vi.waitFor(() => expect(resumeFinished).toBe(true))
        await vi.waitFor(() => expect(probe.destroys).toBe(1))
        expect(() => __fictUseLexicalScope('sDelayed', ['signal'])).toThrow('Missing resumed scope')

        cleanupEventListeners()
        await flushMutationObservers()
        expect(probe.destroys).toBe(1)
      },
    )

    it('does not let a delayed old resume dispose the replacement installation root', async () => {
      const doc = createLifecycleDocument('sReinstalled')
      const host = appendLifecycleHost(doc, 'sReinstalled', '__fict_teardown_old_install')
      const oldProbe = createLifecycleProbe()
      const newProbe = createLifecycleProbe()
      let releaseOldResume!: () => void
      const oldResumeGate = new Promise<void>(resolve => {
        releaseOldResume = resolve
      })
      let oldResumeStarted = false
      let oldResumeFinished = false
      __fictRegisterResume('__fict_teardown_old_install', async (scopeId, node) => {
        const capturedSnapshot = __fictGetSSRScope(scopeId as string)
        oldResumeStarted = true
        await oldResumeGate
        hydrateResumedScopeProbe(scopeId as string, node as Element, oldProbe, capturedSnapshot)
        oldResumeFinished = true
      })
      __fictRegisterResume('__fict_teardown_new_install', (scopeId, node) => {
        hydrateResumedScopeProbe(scopeId as string, node as Element, newProbe)
      })
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })

      host.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
      await vi.waitFor(() => expect(oldResumeStarted).toBe(true))

      host.setAttribute(
        'data-fict-h',
        'data:text/javascript,export default null#__fict_teardown_new_install',
      )
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })
      await resumeHost(host)
      expect(newProbe.effectRuns).toBe(1)
      expect(newProbe.destroys).toBe(0)

      releaseOldResume()
      await vi.waitFor(() => expect(oldResumeFinished).toBe(true))
      await vi.waitFor(() => expect(oldProbe.destroys).toBe(1))

      expect(newProbe.destroys).toBe(0)
      expect(__fictUseLexicalScope('sReinstalled', ['signal'])[0]).toBe(newProbe.signal)
      const newRuns = newProbe.effectRuns
      newProbe.signal!(2)
      await vi.waitFor(() => expect(newProbe.effectRuns).toBeGreaterThan(newRuns))

      cleanupEventListeners()
      expect(oldProbe.destroys).toBe(1)
      expect(newProbe.destroys).toBe(1)
    })

    it('releases every scope even when one root teardown throws', async () => {
      const doc = createLifecycleDocument('sThrowingCleanup', 'sHealthyCleanup')
      const throwingProbe = createLifecycleProbe()
      const healthyProbe = createLifecycleProbe()
      const throwingHost = appendLifecycleHost(
        doc,
        'sThrowingCleanup',
        '__fict_teardown_throwing_cleanup',
      )
      const healthyHost = appendLifecycleHost(
        doc,
        'sHealthyCleanup',
        '__fict_teardown_healthy_cleanup',
      )
      __fictRegisterResume('__fict_teardown_throwing_cleanup', (scopeId, node) => {
        hydrateResumedScopeProbe(
          scopeId as string,
          node as Element,
          throwingProbe,
          __fictGetSSRScope(scopeId as string),
          () =>
            onDestroy(() => {
              throw new Error('scope teardown failed')
            }),
        )
      })
      __fictRegisterResume('__fict_teardown_healthy_cleanup', (scopeId, node) => {
        hydrateResumedScopeProbe(scopeId as string, node as Element, healthyProbe)
      })
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })
      await resumeHost(throwingHost)
      await resumeHost(healthyHost)

      expect(() => cleanupEventListeners()).toThrow('scope teardown failed')

      expect(throwingProbe.destroys).toBe(1)
      expect(healthyProbe.destroys).toBe(1)
      expect(() => __fictUseLexicalScope('sThrowingCleanup', ['signal'])).toThrow(
        'Missing resumed scope',
      )
      expect(() => __fictUseLexicalScope('sHealthyCleanup', ['signal'])).toThrow(
        'Missing resumed scope',
      )
      cleanupEventListeners()
    })

    it('isolates teardown for equal source scope ids in different documents', async () => {
      const docA = createLifecycleDocument('sShared')
      const docB = createLifecycleDocument('sShared')
      const probeA = createLifecycleProbe()
      const probeB = createLifecycleProbe()
      const hostA = appendLifecycleHost(docA, 'sShared', '__fict_teardown_document_a')
      const hostB = appendLifecycleHost(docB, 'sShared', '__fict_teardown_document_b')
      __fictRegisterResume('__fict_teardown_document_a', (scopeId, node) => {
        hydrateResumedScopeProbe(scopeId as string, node as Element, probeA)
      })
      __fictRegisterResume('__fict_teardown_document_b', (scopeId, node) => {
        hydrateResumedScopeProbe(scopeId as string, node as Element, probeB)
      })
      installResumableLoader({ document: docA, events: ['click'], prefetch: false })
      installResumableLoader({ document: docB, events: ['click'], prefetch: false })
      await resumeHost(hostA)
      await resumeHost(hostB)

      hostA.remove()
      await vi.waitFor(() => expect(probeA.destroys).toBe(1))

      expect(probeB.destroys).toBe(0)
      const runsBeforeUpdate = probeB.effectRuns
      probeB.store!.value = 2
      await vi.waitFor(() => expect(probeB.effectRuns).toBeGreaterThan(runsBeforeUpdate))

      cleanupEventListeners()
      expect(probeA.destroys).toBe(1)
      expect(probeB.destroys).toBe(1)
    })
  })

  it('keeps independent document loaders isolated until shared cleanup', async () => {
    const createIslandDocument = (value: string): Document =>
      createDocumentWithSnapshots(
        JSON.stringify({
          v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
          scopes: {
            s1: {
              id: 's1',
              slots: [[0, 'raw', value]],
              vars: { value: 0 },
            },
          },
        }),
      )
    const docA = createIslandDocument('A')
    const docB = createIslandDocument('B')
    const resumedValues: string[] = []
    const handlerCalls: string[] = []
    const issuesA: SnapshotIssue[] = []
    const issuesB: SnapshotIssue[] = []
    ;(globalThis as { __fictMultiDocumentCalls?: string[] }).__fictMultiDocumentCalls = handlerCalls

    const appendIsland = (doc: Document, name: string, resumeName: string): HTMLButtonElement => {
      const host = doc.createElement('div')
      host.setAttribute('data-fict-s', 's1')
      host.setAttribute('data-fict-h', `data:text/javascript,export default null#${resumeName}`)
      const button = doc.createElement('button')
      button.setAttribute(
        'on:click',
        `data:text/javascript,export function handle(){globalThis.__fictMultiDocumentCalls.push("${name}")}#handle`,
      )
      host.appendChild(button)
      doc.body.appendChild(host)
      return button
    }
    const buttonA = appendIsland(docA, 'A', '__fict_multi_document_a')
    const buttonB = appendIsland(docB, 'B', '__fict_multi_document_b')

    __fictRegisterResume('__fict_multi_document_a', scopeId => {
      resumedValues.push(__fictUseLexicalScope(scopeId as string, ['value'])[0] as string)
    })
    __fictRegisterResume('__fict_multi_document_b', scopeId => {
      resumedValues.push(__fictUseLexicalScope(scopeId as string, ['value'])[0] as string)
    })

    installResumableLoader({
      document: docA,
      events: ['click'],
      prefetch: false,
      onSnapshotIssue: issue => issuesA.push(issue),
    })
    installResumableLoader({
      document: docB,
      events: ['click'],
      prefetch: false,
      onSnapshotIssue: issue => issuesB.push(issue),
    })

    buttonA.dispatchEvent(new Event('click', { bubbles: true }))
    buttonB.dispatchEvent(new Event('click', { bubbles: true }))
    await waitForPendingHandlers()

    expect(resumedValues.toSorted()).toEqual(['A', 'B'])
    expect(handlerCalls.toSorted()).toEqual(['A', 'B'])

    cleanupEventListeners()
    buttonA.dispatchEvent(new Event('click', { bubbles: true }))
    buttonB.dispatchEvent(new Event('click', { bubbles: true }))
    expect(handlerCalls).toEqual(['A', 'B'])
    expect(__fictGetSSRScope('s1')).toBeUndefined()

    const rejectedSnapshot = docA.createElement('script')
    rejectedSnapshot.type = 'application/json'
    rejectedSnapshot.setAttribute('data-fict-snapshot', '')
    rejectedSnapshot.textContent = JSON.stringify({
      v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION + 1,
      scopes: {},
    })
    docA.body.appendChild(rejectedSnapshot)
    await Promise.resolve()
    expect(issuesA).toEqual([])
    expect(issuesB).toEqual([])

    delete (globalThis as { __fictMultiDocumentCalls?: string[] }).__fictMultiDocumentCalls
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
    Object.defineProperty(clickEvent, 'composedPath', {
      configurable: true,
      value: undefined,
    })
    childButton.dispatchEvent(clickEvent)
    await waitForPendingHandlers()

    expect((globalThis as { __fictParentCalls?: number }).__fictParentCalls).toBe(1)
    expect(onIssue).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'scope_snapshot_missing', scopeId: 'sMissing' }),
    )

    delete (globalThis as { __fictParentCalls?: number }).__fictParentCalls
  })

  it('rejects non-array serialized props without iterating forged lengths', async () => {
    const onIssue = vi.fn()
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sMalformed: {
            id: 'sMalformed',
            slots: [],
            props: { __t: 's', v: { length: 4_294_967_295 } },
          },
        },
      }),
    )

    ;(globalThis as { __fictMalformedPropsCalls?: number }).__fictMalformedPropsCalls = 0

    const host = doc.createElement('div')
    host.setAttribute('data-fict-s', 'sMalformed')
    const button = doc.createElement('button')
    button.setAttribute(
      'on:click',
      'data:text/javascript,export function handle(){globalThis.__fictMalformedPropsCalls++}#handle',
    )
    host.appendChild(button)
    doc.body.appendChild(host)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installResumableLoader({
      document: doc,
      events: ['click'],
      prefetch: false,
      onSnapshotIssue: onIssue,
    })

    button.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    await waitForPendingHandlers()

    expect((globalThis as { __fictMalformedPropsCalls?: number }).__fictMalformedPropsCalls).toBe(0)
    expect(onIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'snapshot_invalid_shape',
        scopeId: 'sMalformed',
        eventType: 'click',
      }),
    )
    expect(errorSpy).not.toHaveBeenCalled()

    errorSpy.mockRestore()
    warnSpy.mockRestore()
    delete (globalThis as { __fictMalformedPropsCalls?: number }).__fictMalformedPropsCalls
  })

  it('continues event path scanning after successful child handlers', async () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          s1: { id: 's1', slots: [] },
        },
      }),
    )

    ;(globalThis as { __fictBubbleCalls?: string[] }).__fictBubbleCalls = []

    const parent = doc.createElement('div')
    parent.setAttribute('data-fict-s', 's1')
    parent.setAttribute('data-role', 'parent')
    parent.setAttribute(
      'on:click',
      "data:text/javascript,export function parent(scopeId,event,el){globalThis.__fictBubbleCalls.push('parent:'+event.currentTarget.getAttribute('data-role')+':'+el.getAttribute('data-role'))}#parent",
    )

    const child = doc.createElement('button')
    child.setAttribute('data-role', 'child')
    child.setAttribute(
      'on:click',
      "data:text/javascript,export function child(scopeId,event,el){globalThis.__fictBubbleCalls.push('child:'+event.currentTarget.getAttribute('data-role')+':'+el.getAttribute('data-role'))}#child",
    )

    parent.appendChild(child)
    doc.body.appendChild(parent)

    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    child.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    await waitForPendingHandlers()

    expect((globalThis as { __fictBubbleCalls?: string[] }).__fictBubbleCalls).toEqual([
      'child:child:child',
      'parent:parent:parent',
    ])

    delete (globalThis as { __fictBubbleCalls?: string[] }).__fictBubbleCalls
  })

  it('stops event path scanning when a successful child handler stops propagation', async () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          s1: { id: 's1', slots: [] },
        },
      }),
    )

    ;(globalThis as { __fictStoppedBubbleCalls?: string[] }).__fictStoppedBubbleCalls = []

    const parent = doc.createElement('div')
    parent.setAttribute('data-fict-s', 's1')
    parent.setAttribute(
      'on:click',
      "data:text/javascript,export function parent(){globalThis.__fictStoppedBubbleCalls.push('parent')}#parent",
    )

    const child = doc.createElement('button')
    child.setAttribute(
      'on:click',
      "data:text/javascript,export function child(scopeId,event){globalThis.__fictStoppedBubbleCalls.push('child');event.stopPropagation()}#child",
    )

    parent.appendChild(child)
    doc.body.appendChild(parent)

    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    child.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    await waitForPendingHandlers()

    expect(
      (globalThis as { __fictStoppedBubbleCalls?: string[] }).__fictStoppedBubbleCalls,
    ).toEqual(['child'])

    delete (globalThis as { __fictStoppedBubbleCalls?: string[] }).__fictStoppedBubbleCalls
  })

  it('does not cancel inert link click handlers', async () => {
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
    const link = doc.createElement('a')
    link.href = '/next'
    link.setAttribute('on:click', 'data:text/javascript,export function h(){}#h')
    host.appendChild(link)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    const dispatchResult = link.dispatchEvent(event)
    await waitForPendingHandlers()

    expect(event.defaultPrevented).toBe(false)
    expect(dispatchResult).toBe(true)
  })

  it('prevents ancestor link defaults for flagged child handlers', async () => {
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
    const link = doc.createElement('a')
    link.href = '/next'
    const child = doc.createElement('span')
    child.setAttribute(
      'on:click',
      'data:text/javascript,export function h(scopeId,event){event.preventDefault()}#h[pd]',
    )
    link.appendChild(child)
    host.appendChild(link)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    const dispatchResult = child.dispatchEvent(event)
    await waitForPendingHandlers()

    expect(event.defaultPrevented).toBe(true)
    expect(dispatchResult).toBe(false)
  })

  it('does not cancel ancestor link defaults for unflagged child handlers', async () => {
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
    const link = doc.createElement('a')
    link.href = '/next'
    const child = doc.createElement('span')
    child.setAttribute('on:click', 'data:text/javascript,export function h(){}#h')
    link.appendChild(child)
    host.appendChild(link)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    const dispatchResult = child.dispatchEvent(event)
    await waitForPendingHandlers()

    expect(event.defaultPrevented).toBe(false)
    expect(dispatchResult).toBe(true)
  })

  it('parses bracketed QRL module URLs before the export hash', async () => {
    ;(globalThis as { __FICT_MANIFEST__?: Record<string, string> }).__FICT_MANIFEST__ = {
      '/assets/page-[id].js':
        'data:text/javascript,export function route(){globalThis.__fictBracketQrlCalls.push("route")}',
      '/assets/chunk.js?route=[id]':
        'data:text/javascript,export function query(){globalThis.__fictBracketQrlCalls.push("query")}',
    }
    ;(globalThis as { __fictBracketQrlCalls?: string[] }).__fictBracketQrlCalls = []

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
    const routeButton = doc.createElement('button')
    routeButton.setAttribute('on:click', '/assets/page-[id].js#route')
    const queryButton = doc.createElement('button')
    queryButton.setAttribute('on:click', '/assets/chunk.js?route=[id]#query')
    host.append(routeButton, queryButton)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    routeButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    queryButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitForPendingHandlers()

    expect((globalThis as { __fictBracketQrlCalls?: string[] }).__fictBracketQrlCalls).toEqual([
      'route',
      'query',
    ])

    delete (globalThis as { __fictBracketQrlCalls?: string[] }).__fictBracketQrlCalls
  })

  it('parses data QRL URLs with brackets before the export hash', async () => {
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
    button.setAttribute(
      'on:click',
      'data:text/javascript,const xs=[1];export function h(){globalThis.__fictBracketDataQrl=xs[0]}#h',
    )
    host.appendChild(button)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitForPendingHandlers()

    expect((globalThis as { __fictBracketDataQrl?: number }).__fictBracketDataQrl).toBe(1)

    delete (globalThis as { __fictBracketDataQrl?: number }).__fictBracketDataQrl
  })

  it('parses QRL metadata suffixes after the export name', async () => {
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
    button.setAttribute(
      'on:click',
      'data:text/javascript,export function h(){globalThis.__fictSuffixQrl="hit"}#h[0]',
    )
    host.appendChild(button)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitForPendingHandlers()

    expect((globalThis as { __fictSuffixQrl?: string }).__fictSuffixQrl).toBe('hit')

    delete (globalThis as { __fictSuffixQrl?: string }).__fictSuffixQrl
  })

  it('prevents submit button click defaults for flagged child handlers', async () => {
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
    const form = doc.createElement('form')
    const button = doc.createElement('button')
    button.type = 'submit'
    const child = doc.createElement('span')
    child.setAttribute(
      'on:click',
      'data:text/javascript,export function h(scopeId,event){event.preventDefault()}#h[pd]',
    )
    button.appendChild(child)
    form.appendChild(button)
    host.appendChild(form)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    const dispatchResult = child.dispatchEvent(event)
    await waitForPendingHandlers()

    expect(event.defaultPrevented).toBe(true)
    expect(dispatchResult).toBe(false)
  })

  it('does not cancel inert form submit handlers', async () => {
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
    const form = doc.createElement('form')
    form.setAttribute('on:submit', 'data:text/javascript,export function h(){}#h')
    host.appendChild(form)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['submit'], prefetch: false })

    const event = new Event('submit', { bubbles: true, cancelable: true })
    const dispatchResult = form.dispatchEvent(event)
    await waitForPendingHandlers()

    expect(event.defaultPrevented).toBe(false)
    expect(dispatchResult).toBe(true)
  })

  it('prevents checkbox click defaults when the handler calls preventDefault', async () => {
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
    const input = doc.createElement('input')
    input.type = 'checkbox'
    input.setAttribute(
      'on:click',
      'data:text/javascript,export function h(scopeId,event){event.preventDefault()}#h',
    )
    host.appendChild(input)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    input.click()
    await waitForPendingHandlers()

    expect(input.checked).toBe(false)
  })

  it('replays checkbox click defaults when the handler does not call preventDefault', async () => {
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
    const input = doc.createElement('input')
    input.type = 'checkbox'
    input.setAttribute('on:click', 'data:text/javascript,export function h(){}#h')
    host.appendChild(input)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    input.click()
    await waitForPendingHandlers()

    expect(input.checked).toBe(true)
  })

  it.each([
    ['the handler module fails to import', '/__fict_missing_checkbox_handler__.js#default'],
    [
      'the handler throws',
      'data:text/javascript,export function h(){throw new Error("checkbox boom")}#h',
    ],
  ])('replays checkbox click defaults when %s', async (_label, qrl) => {
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
    const input = doc.createElement('input')
    input.type = 'checkbox'
    input.setAttribute('on:click', qrl)
    host.appendChild(input)
    doc.body.appendChild(host)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      installResumableLoader({ document: doc, events: ['click'], prefetch: false })
      input.click()
      await waitForPendingHandlers()

      expect(input.checked).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('prevents radio click defaults when the handler calls preventDefault', async () => {
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
    const first = doc.createElement('input')
    first.type = 'radio'
    first.name = 'choice'
    first.checked = true
    const second = doc.createElement('input')
    second.type = 'radio'
    second.name = 'choice'
    second.setAttribute(
      'on:click',
      'data:text/javascript,export function h(scopeId,event){event.preventDefault()}#h',
    )
    host.append(first, second)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    second.click()
    await waitForPendingHandlers()

    expect(second.checked).toBe(false)
  })

  it('replays radio click defaults when the handler does not call preventDefault', async () => {
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
    const first = doc.createElement('input')
    first.type = 'radio'
    first.name = 'choice'
    first.checked = true
    const second = doc.createElement('input')
    second.type = 'radio'
    second.name = 'choice'
    second.setAttribute('on:click', 'data:text/javascript,export function h(){}#h')
    host.append(first, second)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    second.click()
    await waitForPendingHandlers()

    expect(first.checked).toBe(false)
    expect(second.checked).toBe(true)
  })

  it('handles resumable handler failures without unhandled promise rejections', async () => {
    const issues: SnapshotIssue[] = []
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installResumableLoader({
      document: doc,
      events: ['click'],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })

    const ev = new Event('click', { bubbles: true, cancelable: true })
    button.dispatchEvent(ev)
    await waitForPendingHandlers()

    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'handler_import_failed',
        scopeId: 's1',
        qrl: '/__fict_missing_module__.js#default',
        eventType: 'click',
      }),
    )
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to import handler module'))
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('continues event path scanning after nested handler import failures', async () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sParent: { id: 'sParent', slots: [] },
          sChild: { id: 'sChild', slots: [] },
        },
      }),
    )

    ;(globalThis as { __fictRecoveredParentCalls?: number }).__fictRecoveredParentCalls = 0

    const parentHost = doc.createElement('div')
    parentHost.setAttribute('data-fict-s', 'sParent')
    parentHost.setAttribute(
      'on:click',
      'data:text/javascript,export function parent(){globalThis.__fictRecoveredParentCalls=(globalThis.__fictRecoveredParentCalls||0)+1}#parent',
    )

    const childHost = doc.createElement('div')
    childHost.setAttribute('data-fict-s', 'sChild')
    const childButton = doc.createElement('button')
    childButton.setAttribute('on:click', '/__fict_missing_nested_handler__.js#default')

    childHost.appendChild(childButton)
    parentHost.appendChild(childHost)
    doc.body.appendChild(parentHost)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installResumableLoader({
      document: doc,
      events: ['click'],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })

    childButton.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    await waitForPendingHandlers()

    expect((globalThis as { __fictRecoveredParentCalls?: number }).__fictRecoveredParentCalls).toBe(
      1,
    )
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'handler_import_failed',
        scopeId: 'sChild',
      }),
    )

    warnSpy.mockRestore()
    delete (globalThis as { __fictRecoveredParentCalls?: number }).__fictRecoveredParentCalls
  })

  it('reports missing and thrown resumable handlers', async () => {
    const issues: SnapshotIssue[] = []
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
    const missingButton = doc.createElement('button')
    missingButton.setAttribute('on:click', 'data:text/javascript,export const present=1#missing')
    const throwingButton = doc.createElement('button')
    throwingButton.setAttribute(
      'on:click',
      'data:text/javascript,export function boom(){throw new Error("handler boom")}#boom',
    )
    host.append(missingButton, throwingButton)
    doc.body.appendChild(host)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installResumableLoader({
      document: doc,
      events: ['click'],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })

    missingButton.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    throwingButton.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    await waitForPendingHandlers()

    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'handler_missing',
        exportName: 'missing',
      }),
    )
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'handler_failed',
        exportName: 'boom',
      }),
    )
    warnSpy.mockRestore()
  })

  it('rolls back event overrides when a non-configurable target blocks shadow retargeting', async () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          s1: { id: 's1', slots: [] },
        },
      }),
    )

    ;(globalThis as { __fictBlockedRetargetCalls?: number }).__fictBlockedRetargetCalls = 0

    const scope = doc.createElement('div')
    scope.setAttribute('data-fict-s', 's1')
    const button = doc.createElement('button')
    button.setAttribute(
      'on:click',
      'data:text/javascript,export function capture(){globalThis.__fictBlockedRetargetCalls++}#capture',
    )
    scope.appendChild(button)

    const shadowHost = doc.createElement('section')
    shadowHost.attachShadow({ mode: 'open' }).appendChild(scope)
    doc.body.appendChild(shadowHost)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installResumableLoader({
      document: doc,
      events: ['click'],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })

    const event = new Event('click', { bubbles: true, cancelable: true, composed: true })
    Object.defineProperty(event, 'target', {
      configurable: false,
      value: shadowHost,
    })
    button.dispatchEvent(event)
    await waitForPendingHandlers()

    expect((globalThis as { __fictBlockedRetargetCalls?: number }).__fictBlockedRetargetCalls).toBe(
      0,
    )
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'handler_failed',
        scopeId: 's1',
        exportName: 'capture',
      }),
    )
    expect(Object.prototype.hasOwnProperty.call(event, 'currentTarget')).toBe(false)
    expect(event.currentTarget).toBeNull()
    expect(Object.getOwnPropertyDescriptor(event, 'target')).toEqual({
      configurable: false,
      enumerable: false,
      value: shadowHost,
      writable: false,
    })

    warnSpy.mockRestore()
    delete (globalThis as { __fictBlockedRetargetCalls?: number }).__fictBlockedRetargetCalls
  })

  it('deduplicates concurrent resumes while preserving every handler event', async () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          s1: { id: 's1', slots: [] },
        },
      }),
    )

    let releaseResume!: () => void
    const resumeGate = new Promise<void>(resolve => {
      releaseResume = resolve
    })
    let releaseFirstHandler!: () => void
    const firstHandlerGate = new Promise<void>(resolve => {
      releaseFirstHandler = resolve
    })
    let resumeCalls = 0
    const handlerOrder: string[] = []
    ;(globalThis as { __fictConcurrentHandlerOrder?: string[] }).__fictConcurrentHandlerOrder =
      handlerOrder
    ;(globalThis as { __fictFirstHandlerGate?: Promise<void> }).__fictFirstHandlerGate =
      firstHandlerGate

    const host = doc.createElement('div')
    host.setAttribute('data-fict-s', 's1')
    host.setAttribute('data-fict-h', 'data:text/javascript,export default null#__fict_concurrent')
    __fictRegisterResume('__fict_concurrent', () => {
      resumeCalls++
      return resumeGate
    })

    const button = doc.createElement('button')
    button.setAttribute(
      'on:click',
      'data:text/javascript,export async function handle(scopeId,event){if(event.sequence==="first"){globalThis.__fictConcurrentHandlerOrder.push("first:start");await globalThis.__fictFirstHandlerGate;globalThis.__fictConcurrentHandlerOrder.push("first:end")}else{globalThis.__fictConcurrentHandlerOrder.push(event.sequence)}}#handle',
    )
    host.appendChild(button)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    const firstEvent = new Event('click', { bubbles: true, cancelable: true })
    const secondEvent = new Event('click', { bubbles: true, cancelable: true })
    ;(firstEvent as Event & { sequence: string }).sequence = 'first'
    ;(secondEvent as Event & { sequence: string }).sequence = 'second'
    button.dispatchEvent(firstEvent)
    button.dispatchEvent(secondEvent)

    await vi.waitFor(() => expect(resumeCalls).toBe(1))
    expect(handlerOrder).toEqual([])

    releaseResume()
    await vi.waitFor(() => expect(handlerOrder).toEqual(['first:start']))
    releaseFirstHandler()
    await waitForPendingHandlers()

    expect(resumeCalls).toBe(1)
    expect(handlerOrder).toEqual(['first:start', 'first:end', 'second'])

    delete (globalThis as { __fictConcurrentHandlerOrder?: string[] }).__fictConcurrentHandlerOrder
    delete (globalThis as { __fictFirstHandlerGate?: Promise<void> }).__fictFirstHandlerGate
  })

  it.each(['cleanup', 'reinstall'] as const)(
    'does not run an event continuation after loader %s',
    async action => {
      const doc = createDocumentWithSnapshots(
        JSON.stringify({
          v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
          scopes: {
            s1: { id: 's1', slots: [] },
          },
        }),
      )
      let releaseResume!: () => void
      const resumeGate = new Promise<void>(resolve => {
        releaseResume = resolve
      })
      let resumeCalls = 0
      ;(globalThis as { __fictStaleHandlerCalls?: number }).__fictStaleHandlerCalls = 0

      const host = doc.createElement('div')
      host.setAttribute('data-fict-s', 's1')
      host.setAttribute('data-fict-h', 'data:text/javascript,export default null#__fict_stale')
      __fictRegisterResume('__fict_stale', () => {
        resumeCalls++
        return resumeGate
      })

      const input = doc.createElement('input')
      input.type = 'checkbox'
      input.setAttribute(
        'on:click',
        'data:text/javascript,export function handle(){globalThis.__fictStaleHandlerCalls++}#handle',
      )
      host.appendChild(input)
      doc.body.appendChild(host)

      installResumableLoader({ document: doc, events: ['click'], prefetch: false })

      const staleEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      })
      const originalPreventDefault = Object.getOwnPropertyDescriptor(staleEvent, 'preventDefault')
      input.dispatchEvent(staleEvent)
      await vi.waitFor(() => expect(resumeCalls).toBe(1))

      if (action === 'cleanup') {
        cleanupEventListeners()
      } else {
        installResumableLoader({ document: doc, events: ['click'], prefetch: false })
      }

      releaseResume()
      await waitForPendingHandlers()

      expect((globalThis as { __fictStaleHandlerCalls?: number }).__fictStaleHandlerCalls).toBe(0)
      expect(input.checked).toBe(true)
      expect(Object.getOwnPropertyDescriptor(staleEvent, 'preventDefault')).toEqual(
        originalPreventDefault,
      )
      expect(getPendingLoaderWaiterCountForTests()).toBe(0)

      if (action === 'reinstall') {
        input.click()
        await waitForPendingHandlers()
        expect((globalThis as { __fictStaleHandlerCalls?: number }).__fictStaleHandlerCalls).toBe(1)
        expect(input.checked).toBe(false)
        expect(getPendingLoaderWaiterCountForTests()).toBe(0)
      }

      delete (globalThis as { __fictStaleHandlerCalls?: number }).__fictStaleHandlerCalls
    },
  )

  it('releases cancellation waiters after successful events', async () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          s1: { id: 's1', slots: [] },
        },
      }),
    )
    ;(globalThis as { __fictWaiterHandlerCalls?: number }).__fictWaiterHandlerCalls = 0

    const host = doc.createElement('div')
    host.setAttribute('data-fict-s', 's1')
    const button = doc.createElement('button')
    button.setAttribute(
      'on:click',
      'data:text/javascript,export function handle(){globalThis.__fictWaiterHandlerCalls++}#handle',
    )
    host.appendChild(button)
    doc.body.appendChild(host)
    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    for (let index = 0; index < 25; index++) {
      button.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
      await waitForPendingHandlers()
      expect(getPendingLoaderWaiterCountForTests()).toBe(0)
    }

    expect((globalThis as { __fictWaiterHandlerCalls?: number }).__fictWaiterHandlerCalls).toBe(25)
    delete (globalThis as { __fictWaiterHandlerCalls?: number }).__fictWaiterHandlerCalls
  })

  it('allows a later event to retry after a shared resume failure', async () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          s1: { id: 's1', slots: [] },
        },
      }),
    )

    let rejectFirstResume!: (reason?: unknown) => void
    const firstResume = new Promise<void>((_resolve, reject) => {
      rejectFirstResume = reject
    })
    let resumeAttempts = 0
    ;(globalThis as { __fictRetryHandlerCalls?: number }).__fictRetryHandlerCalls = 0

    const host = doc.createElement('div')
    host.setAttribute('data-fict-s', 's1')
    host.setAttribute('data-fict-h', 'data:text/javascript,export default null#__fict_retry')
    __fictRegisterResume('__fict_retry', () => {
      resumeAttempts++
      if (resumeAttempts === 1) {
        return firstResume
      }
    })

    const button = doc.createElement('button')
    button.setAttribute(
      'on:click',
      'data:text/javascript,export function handle(){globalThis.__fictRetryHandlerCalls++}#handle',
    )
    host.appendChild(button)
    doc.body.appendChild(host)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installResumableLoader({
      document: doc,
      events: ['click'],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })

    button.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    button.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(resumeAttempts).toBe(1))
    rejectFirstResume(new Error('retryable resume failure'))
    await waitForPendingHandlers()

    expect(resumeAttempts).toBe(1)
    expect((globalThis as { __fictRetryHandlerCalls?: number }).__fictRetryHandlerCalls).toBe(0)
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'resume_failed',
        scopeId: 's1',
        exportName: '__fict_retry',
      }),
    )

    button.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    await waitForPendingHandlers()

    expect(resumeAttempts).toBe(2)
    expect((globalThis as { __fictRetryHandlerCalls?: number }).__fictRetryHandlerCalls).toBe(1)

    warnSpy.mockRestore()
    delete (globalThis as { __fictRetryHandlerCalls?: number }).__fictRetryHandlerCalls
  })

  it('reports resume import and resume function failures', async () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          s1: { id: 's1', slots: [] },
          s2: { id: 's2', slots: [] },
          s3: { id: 's3', slots: [] },
        },
      }),
    )

    const missingResumeHost = doc.createElement('div')
    missingResumeHost.setAttribute('data-fict-s', 's1')
    missingResumeHost.setAttribute('data-fict-h', '/__fict_missing_resume__.js#resume')
    const missingResumeButton = doc.createElement('button')
    missingResumeButton.setAttribute('on:click', 'data:text/javascript,export function ok(){}#ok')
    missingResumeHost.appendChild(missingResumeButton)

    const throwingResumeHost = doc.createElement('div')
    throwingResumeHost.setAttribute('data-fict-s', 's2')
    throwingResumeHost.setAttribute(
      'data-fict-h',
      'data:text/javascript,export default null#__fict_throwing_resume',
    )
    __fictRegisterResume('__fict_throwing_resume', () => {
      throw new Error('resume boom')
    })
    const throwingResumeButton = doc.createElement('button')
    throwingResumeButton.setAttribute('on:click', 'data:text/javascript,export function ok(){}#ok')
    throwingResumeHost.appendChild(throwingResumeButton)

    const missingFunctionHost = doc.createElement('div')
    missingFunctionHost.setAttribute('data-fict-s', 's3')
    missingFunctionHost.setAttribute(
      'data-fict-h',
      'data:text/javascript,export default null#__fict_missing_registry',
    )
    const missingFunctionButton = doc.createElement('button')
    ;(globalThis as { __fictMissingResumeHandlerCalls?: number }).__fictMissingResumeHandlerCalls =
      0
    missingFunctionButton.setAttribute(
      'on:click',
      'data:text/javascript,export function ok(){globalThis.__fictMissingResumeHandlerCalls=(globalThis.__fictMissingResumeHandlerCalls||0)+1}#ok',
    )
    missingFunctionHost.appendChild(missingFunctionButton)
    doc.body.append(missingResumeHost, throwingResumeHost, missingFunctionHost)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installResumableLoader({
      document: doc,
      events: ['click'],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })

    missingResumeButton.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    throwingResumeButton.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    missingFunctionButton.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    await waitForPendingHandlers()

    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'resume_import_failed',
        scopeId: 's1',
      }),
    )
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'resume_failed',
        scopeId: 's2',
        exportName: '__fict_throwing_resume',
      }),
    )
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'resume_function_missing',
        scopeId: 's3',
        exportName: '__fict_missing_registry',
      }),
    )
    expect(
      (globalThis as { __fictMissingResumeHandlerCalls?: number }).__fictMissingResumeHandlerCalls,
    ).toBe(0)
    warnSpy.mockRestore()
    delete (globalThis as { __fictMissingResumeHandlerCalls?: number })
      .__fictMissingResumeHandlerCalls
  })

  it('keeps sibling scopes resumable when one resume function fails', async () => {
    const issues: SnapshotIssue[] = []
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          sBad: { id: 'sBad', slots: [] },
          sGood: { id: 'sGood', slots: [] },
        },
      }),
    )

    ;(globalThis as { __fictG2BadHandlerCalls?: number }).__fictG2BadHandlerCalls = 0
    ;(globalThis as { __fictG2GoodResumeScopes?: string[] }).__fictG2GoodResumeScopes = []
    ;(globalThis as { __fictG2GoodHandlerScope?: string }).__fictG2GoodHandlerScope = undefined

    const badHost = doc.createElement('div')
    badHost.setAttribute('data-fict-s', 'sBad')
    badHost.setAttribute('data-fict-h', 'data:text/javascript,export default null#__fict_g2_bad')
    __fictRegisterResume('__fict_g2_bad', () => {
      throw new Error('g2 resume boom')
    })
    const badButton = doc.createElement('button')
    badButton.setAttribute(
      'on:click',
      'data:text/javascript,export function bad(){globalThis.__fictG2BadHandlerCalls=(globalThis.__fictG2BadHandlerCalls||0)+1}#bad',
    )
    badHost.appendChild(badButton)

    const goodHost = doc.createElement('div')
    goodHost.setAttribute('data-fict-s', 'sGood')
    goodHost.setAttribute('data-fict-h', 'data:text/javascript,export default null#__fict_g2_good')
    __fictRegisterResume('__fict_g2_good', (scopeId, node) => {
      ;(globalThis as { __fictG2GoodResumeScopes?: string[] }).__fictG2GoodResumeScopes?.push(
        String(scopeId),
      )
      ;(node as Element).setAttribute('data-resumed', 'yes')
    })
    const goodButton = doc.createElement('button')
    goodButton.setAttribute(
      'on:click',
      'data:text/javascript,export function good(scopeId){globalThis.__fictG2GoodHandlerScope=scopeId}#good',
    )
    goodHost.appendChild(goodButton)
    doc.body.append(badHost, goodHost)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installResumableLoader({
      document: doc,
      events: ['click'],
      prefetch: false,
      onSnapshotIssue: issue => issues.push(issue),
    })

    badButton.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    await waitForPendingHandlers()

    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'resume_failed',
        scopeId: 'sBad',
        exportName: '__fict_g2_bad',
      }),
    )
    expect((globalThis as { __fictG2BadHandlerCalls?: number }).__fictG2BadHandlerCalls).toBe(0)
    expect(goodHost.getAttribute('data-resumed')).toBeNull()

    goodButton.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    await waitForPendingHandlers()

    expect(
      (globalThis as { __fictG2GoodResumeScopes?: string[] }).__fictG2GoodResumeScopes,
    ).toEqual(['sGood'])
    expect((globalThis as { __fictG2GoodHandlerScope?: string }).__fictG2GoodHandlerScope).toBe(
      'sGood',
    )
    expect(goodHost.getAttribute('data-resumed')).toBe('yes')
    expect(issues.filter(issue => issue.scopeId === 'sGood')).toHaveLength(0)

    warnSpy.mockRestore()
    delete (globalThis as { __fictG2BadHandlerCalls?: number }).__fictG2BadHandlerCalls
    delete (globalThis as { __fictG2GoodResumeScopes?: string[] }).__fictG2GoodResumeScopes
    delete (globalThis as { __fictG2GoodHandlerScope?: string }).__fictG2GoodHandlerScope
  })

  it('resolves resume registry keys when hosts use relative asset QRLs', async () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          s1: { id: 's1', slots: [] },
        },
      }),
    )
    ;(globalThis as { __FICT_MANIFEST__?: Record<string, string> }).__FICT_MANIFEST__ = {
      '/assets/example-pages.js': 'data:text/javascript,export default null',
    }
    ;(globalThis as { __fictResumeHits?: number }).__fictResumeHits = 0
    ;(globalThis as { __fictHandlerHits?: number }).__fictHandlerHits = 0

    const host = doc.createElement('div')
    host.setAttribute('data-fict-s', 's1')
    host.setAttribute('data-fict-h', '/assets/example-pages.js#__fict_r2')

    __fictRegisterResume('data:text/javascript,export default null#__fict_r2', (_scopeId, node) => {
      ;(globalThis as { __fictResumeHits?: number }).__fictResumeHits =
        ((globalThis as { __fictResumeHits?: number }).__fictResumeHits ?? 0) + 1
      ;(node as Element).setAttribute('data-resumed', 'yes')
    })

    const button = doc.createElement('button')
    button.textContent = 'Run'
    button.setAttribute(
      'on:click',
      'data:text/javascript,export default function(){globalThis.__fictHandlerHits=(globalThis.__fictHandlerHits||0)+1}#default',
    )
    host.appendChild(button)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    button.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    await waitForPendingHandlers()

    expect((globalThis as { __fictResumeHits?: number }).__fictResumeHits).toBe(1)
    expect(host.getAttribute('data-resumed')).toBe('yes')
    expect((globalThis as { __fictHandlerHits?: number }).__fictHandlerHits).toBe(1)

    delete (globalThis as { __fictResumeHits?: number }).__fictResumeHits
    delete (globalThis as { __fictHandlerHits?: number }).__fictHandlerHits
    delete (globalThis as { __FICT_MANIFEST__?: Record<string, string> }).__FICT_MANIFEST__
  })

  it('imports manifest-relative resume and handler modules from the installed document base', async () => {
    const tempDirectory = await mkdtemp(path.join(process.cwd(), '.fict-loader-relative-manifest-'))
    const resumeModulePath = path.join(tempDirectory, 'resume.mjs')
    const handlerModulePath = path.join(tempDirectory, 'handler.mjs')
    const resumeModuleUrl = pathToFileURL(resumeModulePath).href
    const handlerModuleUrl = pathToFileURL(handlerModulePath).href
    const documentUrl = pathToFileURL(path.join(tempDirectory, 'index.html')).href
    const issues: SnapshotIssue[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await writeFile(
        resumeModulePath,
        'globalThis.__fictInstallDocumentRelativeResume(import.meta.url)\nexport const resume = null\n',
      )
      await writeFile(
        handlerModulePath,
        'export function handle(scopeId){globalThis.__fictDocumentRelativeHandler={moduleUrl:import.meta.url,scopeId}}\n',
      )

      let loadedResumeModuleUrl: string | undefined
      ;(
        globalThis as {
          __fictInstallDocumentRelativeResume?: (moduleUrl: string) => void
        }
      ).__fictInstallDocumentRelativeResume = moduleUrl => {
        loadedResumeModuleUrl = moduleUrl
        __fictRegisterResume(`${moduleUrl}#resume`, (scopeId, host) => {
          host.setAttribute('data-relative-resume-scope', scopeId)
        })
      }
      ;(
        globalThis as {
          __FICT_MANIFEST__?: Record<string, string>
        }
      ).__FICT_MANIFEST__ = {
        'virtual:fict-relative-resume': './resume.mjs',
        'virtual:fict-relative-handler': './handler.mjs',
      }

      const doc = createDocumentWithSnapshots(
        JSON.stringify({
          v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
          scopes: {
            sRelative: { id: 'sRelative', slots: [] },
          },
        }),
      )
      const base = doc.createElement('base')
      base.href = documentUrl
      doc.head.appendChild(base)
      expect(doc.baseURI).toBe(documentUrl)

      const host = doc.createElement('div')
      host.setAttribute('data-fict-s', 'sRelative')
      host.setAttribute('data-fict-h', 'virtual:fict-relative-resume#resume')
      const button = doc.createElement('button')
      button.setAttribute('on:click', 'virtual:fict-relative-handler#handle')
      host.appendChild(button)
      doc.body.appendChild(host)

      installResumableLoader({
        document: doc,
        events: ['click'],
        prefetch: false,
        onSnapshotIssue: issue => issues.push(issue),
      })

      button.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
      await waitForPendingHandlers()

      expect(issues).toEqual([])
      expect(loadedResumeModuleUrl).toBe(resumeModuleUrl)
      expect(host.getAttribute('data-relative-resume-scope')).toBe('sRelative')
      expect(
        (
          globalThis as {
            __fictDocumentRelativeHandler?: { moduleUrl: string; scopeId: string }
          }
        ).__fictDocumentRelativeHandler,
      ).toEqual({ moduleUrl: handlerModuleUrl, scopeId: 'sRelative' })
    } finally {
      cleanupEventListeners()
      warnSpy.mockRestore()
      delete (
        globalThis as {
          __fictInstallDocumentRelativeResume?: (moduleUrl: string) => void
        }
      ).__fictInstallDocumentRelativeResume
      delete (
        globalThis as {
          __fictDocumentRelativeHandler?: { moduleUrl: string; scopeId: string }
        }
      ).__fictDocumentRelativeHandler
      delete (globalThis as { __FICT_MANIFEST__?: Record<string, string> }).__FICT_MANIFEST__
      await rm(tempDirectory, { recursive: true, force: true })
    }
  })

  it('retargets currentTarget to the interactive element for resumable handlers', async () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          s1: { id: 's1', slots: [] },
        },
      }),
    )

    ;(globalThis as { __fictCurrentTargetText?: string }).__fictCurrentTargetText = undefined

    const host = doc.createElement('div')
    host.setAttribute('data-fict-s', 's1')
    const button = doc.createElement('button')
    button.textContent = 'Run'
    button.setAttribute(
      'on:click',
      'data:text/javascript,export function currentTarget(scopeId,event){globalThis.__fictCurrentTargetText=event.currentTarget?.textContent??null}#currentTarget',
    )
    host.appendChild(button)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['click'], prefetch: false })

    const event = new Event('click', { bubbles: true, cancelable: true })
    button.dispatchEvent(event)
    await waitForPendingHandlers()

    expect(
      (globalThis as { __fictCurrentTargetText?: string | null }).__fictCurrentTargetText,
    ).toBe('Run')
    expect(event.currentTarget).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(event, 'currentTarget')).toBe(false)

    delete (globalThis as { __fictCurrentTargetText?: string | null }).__fictCurrentTargetText
  })

  it('preserves control values across first-event hydration for resumable input handlers', async () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          s1: { id: 's1', slots: [] },
        },
      }),
    )

    ;(globalThis as { __fictCapturedInputValue?: string | null }).__fictCapturedInputValue =
      undefined

    const host = doc.createElement('div')
    host.setAttribute('data-fict-s', 's1')
    host.setAttribute('data-fict-h', 'data:text/javascript,export default null#__fict_r0')

    __fictRegisterResume('__fict_r0', (_scopeId, node) => {
      const input = node instanceof Element ? node.querySelector('input') : null
      if (input instanceof HTMLInputElement) {
        input.value = ''
      }
    })

    const input = doc.createElement('input')
    input.setAttribute(
      'on:input',
      'data:text/javascript,export function capture(scopeId,event){globalThis.__fictCapturedInputValue=event.currentTarget?.value??null}#capture',
    )
    host.appendChild(input)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['input'], prefetch: false })

    input.value = 'growth'
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }))
    await waitForPendingHandlers()

    expect(
      (globalThis as { __fictCapturedInputValue?: string | null }).__fictCapturedInputValue,
    ).toBe('growth')

    delete (globalThis as { __fictCapturedInputValue?: string | null }).__fictCapturedInputValue
  })

  it('preserves an input edit and backward selection across first-event hydration', async () => {
    const doc = createDocumentWithSnapshots(
      JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          s1: { id: 's1', slots: [] },
        },
      }),
    )

    ;(
      globalThis as {
        __fictCapturedInputSelection?: {
          value: string | null
          selectionStart: number | null
          selectionEnd: number | null
          selectionDirection: string | null
        }
      }
    ).__fictCapturedInputSelection = undefined

    const host = doc.createElement('div')
    host.setAttribute('data-fict-s', 's1')
    host.setAttribute(
      'data-fict-h',
      'data:text/javascript,export default null#__fict_r_input_selection',
    )

    __fictRegisterResume('__fict_r_input_selection', (_scopeId, node) => {
      const input = node instanceof Element ? node.querySelector('input') : null
      if (input instanceof HTMLInputElement) {
        input.value = 'server'
        input.setSelectionRange(0, 0, 'none')
      }
    })

    const input = doc.createElement('input')
    input.value = 'abcd'
    input.setAttribute(
      'on:input',
      'data:text/javascript,export function capture(scopeId,event){globalThis.__fictCapturedInputSelection={value:event.target?.value??null,selectionStart:event.target?.selectionStart??null,selectionEnd:event.target?.selectionEnd??null,selectionDirection:event.target?.selectionDirection??null}}#capture',
    )
    host.appendChild(input)
    doc.body.appendChild(host)

    installResumableLoader({ document: doc, events: ['input'], prefetch: false })

    input.value = 'abXcd'
    input.setSelectionRange(2, 3, 'backward')
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }))
    await waitForPendingHandlers()

    expect(
      (
        globalThis as {
          __fictCapturedInputSelection?: {
            value: string | null
            selectionStart: number | null
            selectionEnd: number | null
            selectionDirection: string | null
          }
        }
      ).__fictCapturedInputSelection,
    ).toEqual({
      value: 'abXcd',
      selectionStart: 2,
      selectionEnd: 3,
      selectionDirection: 'backward',
    })
    expect(input.value).toBe('abXcd')
    expect(input.selectionStart).toBe(2)
    expect(input.selectionEnd).toBe(3)
    expect(input.selectionDirection).toBe('backward')

    delete (globalThis as { __fictCapturedInputSelection?: unknown }).__fictCapturedInputSelection
  })

  it('preserves a foreign-document textarea edit for a bubbling change handler', async () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const doc = iframe.contentDocument
    const view = iframe.contentWindow
    expect(doc).not.toBeNull()
    expect(view).not.toBeNull()

    try {
      const script = doc!.createElement('script')
      script.id = '__FICT_SNAPSHOT__'
      script.type = 'application/json'
      script.textContent = JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          s1: { id: 's1', slots: [] },
          s2: { id: 's2', slots: [] },
        },
      })
      doc!.body.appendChild(script)
      ;(
        globalThis as {
          __fictCapturedBubbledTextarea?: {
            value: string | null
            selectionStart: number | null
            selectionEnd: number | null
            selectionDirection: string | null
            currentTargetTag: string | null
          }
        }
      ).__fictCapturedBubbledTextarea = undefined
      ;(
        globalThis as { __fictCapturedOuterTextareaTarget?: string | null }
      ).__fictCapturedOuterTextareaTarget = undefined

      const host = doc!.createElement('div')
      host.setAttribute('data-fict-s', 's1')
      host.setAttribute(
        'data-fict-h',
        'data:text/javascript,export default null#__fict_r_bubbled_textarea',
      )
      host.setAttribute(
        'on:change',
        'data:text/javascript,export function capture(scopeId,event){globalThis.__fictCapturedBubbledTextarea={value:event.target?.value??null,selectionStart:event.target?.selectionStart??null,selectionEnd:event.target?.selectionEnd??null,selectionDirection:event.target?.selectionDirection??null,currentTargetTag:event.currentTarget?.localName??null}}#capture',
      )

      __fictRegisterResume('__fict_r_bubbled_textarea', (_scopeId, node) => {
        const textarea =
          node && typeof (node as Element).querySelector === 'function'
            ? (node as Element).querySelector('textarea')
            : null
        if (textarea) {
          ;(textarea as HTMLTextAreaElement).value = 'server'
          ;(textarea as HTMLTextAreaElement).setSelectionRange(0, 0, 'none')
        }
      })

      const textarea = doc!.createElement('textarea')
      expect(textarea instanceof HTMLTextAreaElement).toBe(false)
      textarea.value = 'leftright'
      host.appendChild(textarea)
      const shadowBoundary = doc!.createElement('section')
      shadowBoundary.setAttribute('data-fict-s', 's2')
      shadowBoundary.setAttribute(
        'on:change',
        'data:text/javascript,export function capture(scopeId,event){globalThis.__fictCapturedOuterTextareaTarget=event.target?.localName??null}#capture',
      )
      const shadowRoot = shadowBoundary.attachShadow({ mode: 'open' })
      shadowRoot.appendChild(host)
      doc!.body.appendChild(shadowBoundary)

      installResumableLoader({ document: doc!, events: ['change'], prefetch: false })

      textarea.value = 'leftXright'
      textarea.setSelectionRange(4, 5, 'backward')
      textarea.dispatchEvent(
        new view!.Event('change', { bubbles: true, cancelable: true, composed: true }),
      )
      await waitForPendingHandlers()

      expect(
        (
          globalThis as {
            __fictCapturedBubbledTextarea?: {
              value: string | null
              selectionStart: number | null
              selectionEnd: number | null
              selectionDirection: string | null
              currentTargetTag: string | null
            }
          }
        ).__fictCapturedBubbledTextarea,
      ).toEqual({
        value: 'leftXright',
        selectionStart: 4,
        selectionEnd: 5,
        selectionDirection: 'backward',
        currentTargetTag: 'div',
      })
      expect(textarea.value).toBe('leftXright')
      expect(textarea.selectionStart).toBe(4)
      expect(textarea.selectionEnd).toBe(5)
      expect(textarea.selectionDirection).toBe('backward')
      expect(
        (globalThis as { __fictCapturedOuterTextareaTarget?: string | null })
          .__fictCapturedOuterTextareaTarget,
      ).toBe('section')
    } finally {
      iframe.remove()
      delete (globalThis as { __fictCapturedBubbledTextarea?: unknown })
        .__fictCapturedBubbledTextarea
      delete (globalThis as { __fictCapturedOuterTextareaTarget?: unknown })
        .__fictCapturedOuterTextareaTarget
    }
  })

  it('preserves contenteditable markup and selection across first-event hydration', async () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const doc = iframe.contentDocument
    const view = iframe.contentWindow
    expect(doc).not.toBeNull()
    expect(view).not.toBeNull()

    try {
      const script = doc!.createElement('script')
      script.id = '__FICT_SNAPSHOT__'
      script.type = 'application/json'
      script.textContent = JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          s1: { id: 's1', slots: [] },
        },
      })
      doc!.body.appendChild(script)

      const host = doc!.createElement('div')
      host.setAttribute('data-fict-s', 's1')
      host.setAttribute(
        'data-fict-h',
        'data:text/javascript,export default null#__fict_r_contenteditable',
      )

      __fictRegisterResume('__fict_r_contenteditable', (_scopeId, node) => {
        const editable =
          node && typeof (node as Element).querySelector === 'function'
            ? (node as Element).querySelector('[contenteditable]')
            : null
        if (editable) editable.innerHTML = '<span>server</span>'
      })

      const editable = doc!.createElement('div')
      editable.setAttribute('contenteditable', 'true')
      editable.setAttribute(
        'on:input',
        'data:text/javascript,export function capture(scopeId,event){const selection=event.currentTarget.ownerDocument.getSelection();globalThis.__fictCapturedEditableState={html:event.currentTarget.innerHTML,anchorText:selection?.anchorNode?.nodeValue??null,anchorOffset:selection?.anchorOffset??-1,focusText:selection?.focusNode?.nodeValue??null,focusOffset:selection?.focusOffset??-1}}#capture',
      )
      editable.innerHTML = '<span>server</span>'
      host.appendChild(editable)
      doc!.body.appendChild(host)

      installResumableLoader({ document: doc!, events: ['input'], prefetch: false })

      editable.innerHTML = '<span>user edit</span>'
      const editedText = editable.firstElementChild?.firstChild
      const selection = doc!.getSelection()
      expect(editedText).not.toBeNull()
      expect(selection).not.toBeNull()
      selection!.setBaseAndExtent(editedText!, 7, editedText!, 2)

      editable.dispatchEvent(new view!.Event('input', { bubbles: true, cancelable: true }))
      await waitForPendingHandlers()

      expect(
        (
          globalThis as {
            __fictCapturedEditableState?: {
              html: string
              anchorText: string | null
              anchorOffset: number
              focusText: string | null
              focusOffset: number
            }
          }
        ).__fictCapturedEditableState,
      ).toEqual({
        html: '<span>user edit</span>',
        anchorText: 'user edit',
        anchorOffset: 7,
        focusText: 'user edit',
        focusOffset: 2,
      })
      expect(editable.innerHTML).toBe('<span>user edit</span>')
      expect(selection?.anchorNode?.nodeValue).toBe('user edit')
      expect(selection?.anchorOffset).toBe(7)
      expect(selection?.focusNode?.nodeValue).toBe('user edit')
      expect(selection?.focusOffset).toBe(2)
    } finally {
      iframe.remove()
      delete (globalThis as { __fictCapturedEditableState?: unknown }).__fictCapturedEditableState
    }
  })

  it('preserves foreign-document input values across first-event hydration', async () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const doc = iframe.contentDocument
    expect(doc).not.toBeNull()

    try {
      const script = doc!.createElement('script')
      script.id = '__FICT_SNAPSHOT__'
      script.type = 'application/json'
      script.textContent = JSON.stringify({
        v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopes: {
          s1: { id: 's1', slots: [] },
        },
      })
      doc!.body.appendChild(script)
      ;(globalThis as { __fictForeignInputValue?: string | null }).__fictForeignInputValue =
        undefined

      const host = doc!.createElement('div')
      host.setAttribute('data-fict-s', 's1')
      host.setAttribute('data-fict-h', 'data:text/javascript,export default null#__fict_r0')

      __fictRegisterResume('__fict_r0', (_scopeId, node) => {
        const input =
          node && typeof (node as Element).querySelector === 'function'
            ? (node as Element).querySelector('input')
            : null
        if (input) {
          ;(input as HTMLInputElement).value = ''
        }
      })

      const input = doc!.createElement('input')
      expect(input instanceof HTMLInputElement).toBe(false)
      input.setAttribute(
        'on:input',
        'data:text/javascript,export function capture(scopeId,event){globalThis.__fictForeignInputValue=event.currentTarget?.value??null}#capture',
      )
      host.appendChild(input)
      doc!.body.appendChild(host)

      installResumableLoader({ document: doc!, events: ['input'], prefetch: false })

      input.value = 'foreign'
      input.dispatchEvent(new iframe.contentWindow!.Event('input', { bubbles: true }))
      await waitForPendingHandlers()

      expect(
        (globalThis as { __fictForeignInputValue?: string | null }).__fictForeignInputValue,
      ).toBe('foreign')
    } finally {
      iframe.remove()
      delete (globalThis as { __fictForeignInputValue?: string | null }).__fictForeignInputValue
    }
  })
})
