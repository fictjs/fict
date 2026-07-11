import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  __fictRegisterResume,
  __fictGetSSRScope,
  __fictSetSSRState,
  __fictUseLexicalScope,
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
