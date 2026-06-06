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
  __fictRegisterResume,
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

    button.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    await waitForPendingHandlers()

    expect(
      (globalThis as { __fictCurrentTargetText?: string | null }).__fictCurrentTargetText,
    ).toBe('Run')

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
