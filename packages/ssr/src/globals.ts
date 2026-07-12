import { __fictGetCurrentSSRSession } from '@fictjs/runtime/internal'

import { getNodeRequire } from './node-require'

interface GlobalSnapshot {
  key: string
  descriptor: PropertyDescriptor | undefined
}

const activeGlobalTargets = new WeakSet<object>()
const GLOBALS_LEASE = Symbol.for('@fictjs/ssr.exposeGlobalsLease')

export function installGlobals(
  window: Window,
  document: Document,
  target: object = globalThis,
): () => void {
  const win = window as Window & {
    Node?: typeof Node
    Element?: typeof Element
    HTMLElement?: typeof HTMLElement
    SVGElement?: typeof SVGElement
    Document?: typeof Document
    DocumentFragment?: typeof DocumentFragment
    Text?: typeof Text
    Comment?: typeof Comment
    Range?: typeof Range
    Event?: typeof Event
    CustomEvent?: typeof CustomEvent
    MutationObserver?: typeof MutationObserver
    DOMParser?: typeof DOMParser
    getComputedStyle?: Window['getComputedStyle']
  }

  const required: Record<string, unknown> = {
    window: win,
    document,
    self: win,
    Node: win.Node,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    SVGElement: win.SVGElement,
    Document: win.Document,
    DocumentFragment: win.DocumentFragment,
    Text: win.Text,
    Comment: win.Comment,
  }

  const optional: Record<string, unknown> = {
    Range: win.Range,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    MutationObserver: win.MutationObserver,
    DOMParser: win.DOMParser,
    getComputedStyle: win.getComputedStyle?.bind(win),
  }

  const missing = Object.entries(required)
    .filter(([, value]) => value === undefined)
    .map(([key]) => key)

  if (missing.length) {
    throw new Error(`[fict/ssr] Missing DOM globals: ${missing.join(', ')}`)
  }

  const globals = Object.entries({ ...required, ...optional }).filter(
    ([, value]) => value !== undefined,
  )

  const lease = acquireGlobalTarget(target)
  let snapshot: GlobalSnapshot[] = []
  let installingKey = '<capture>'
  try {
    snapshot = captureGlobals(
      target,
      globals.map(([key]) => key),
    )
    for (const [key, value] of globals) {
      installingKey = key
      const previous = snapshot.find(entry => entry.key === key)?.descriptor
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: previous?.enumerable ?? true,
        value,
        writable: true,
      })
    }
  } catch (error) {
    let rollbackError: unknown
    try {
      restoreGlobals(target, snapshot)
      releaseGlobalTarget(target, lease)
    } catch (caught) {
      rollbackError = caught
    }

    const failure = new Error(
      rollbackError === undefined
        ? `[fict/ssr] Failed to install DOM global \`${installingKey}\`: ${formatError(error)}`
        : `[fict/ssr] Failed to install DOM global \`${installingKey}\` and roll back the partial installation: ${formatError(error)}; rollback: ${formatError(rollbackError)}`,
    )
    ;(failure as Error & { cause?: unknown }).cause = error
    throw failure
  }

  let active = true
  return () => {
    if (!active) return
    restoreGlobals(target, snapshot)
    releaseGlobalTarget(target, lease)
    active = false
  }
}

export function installManifest(manifest?: Record<string, string> | string): () => void {
  if (!manifest) return () => {}

  let resolved: Record<string, string>
  if (typeof manifest === 'string') {
    const raw = readTextFileFromPath(manifest)
    resolved = JSON.parse(raw) as Record<string, string>
  } else {
    resolved = manifest
  }

  const session = __fictGetCurrentSSRSession()
  if (session) {
    const previous = session.manifest
    session.manifest = resolved

    return () => {
      session.manifest = previous
    }
  }

  const key = '__FICT_MANIFEST__'
  const snapshot = {
    exists: Object.prototype.hasOwnProperty.call(globalThis, key),
    value: (globalThis as Record<string, unknown>)[key],
  }
  ;(globalThis as Record<string, unknown>)[key] = resolved

  return () => {
    if (snapshot.exists) {
      ;(globalThis as Record<string, unknown>)[key] = snapshot.value
    } else {
      delete (globalThis as Record<string, unknown>)[key]
    }
  }
}

function captureGlobals(target: object, keys: string[]): GlobalSnapshot[] {
  const snapshot: GlobalSnapshot[] = []
  for (const key of keys) {
    snapshot.push({ key, descriptor: Object.getOwnPropertyDescriptor(target, key) })
  }
  return snapshot
}

function restoreGlobals(target: object, snapshot: GlobalSnapshot[]): void {
  let firstError: unknown
  for (let index = snapshot.length - 1; index >= 0; index--) {
    const entry = snapshot[index]
    if (!entry) continue
    try {
      if (entry.descriptor) {
        Object.defineProperty(target, entry.key, entry.descriptor)
      } else if (!Reflect.deleteProperty(target, entry.key)) {
        throw new Error(`Could not delete newly installed global \`${entry.key}\`.`)
      }
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError !== undefined) throw firstError
}

function acquireGlobalTarget(target: object): object {
  if (
    activeGlobalTargets.has(target) ||
    Object.getOwnPropertyDescriptor(target, GLOBALS_LEASE) !== undefined
  ) {
    throw new Error(
      '[fict/ssr] `exposeGlobals: true` cannot be used by overlapping or nested renders. ' +
        'Keep DOM access render-local, or wait for the active compatibility render to dispose.',
    )
  }

  const lease = {}
  activeGlobalTargets.add(target)
  try {
    Object.defineProperty(target, GLOBALS_LEASE, {
      configurable: true,
      enumerable: false,
      value: lease,
      writable: false,
    })
  } catch (error) {
    activeGlobalTargets.delete(target)
    const failure = new Error(
      `[fict/ssr] Failed to acquire the process DOM-global compatibility lease: ${formatError(error)}`,
    )
    ;(failure as Error & { cause?: unknown }).cause = error
    throw failure
  }
  return lease
}

function releaseGlobalTarget(target: object, lease: object): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, GLOBALS_LEASE)
  if (!descriptor || !('value' in descriptor) || descriptor.value !== lease) {
    throw new Error('[fict/ssr] The process DOM-global compatibility lease changed before cleanup.')
  }
  if (!Reflect.deleteProperty(target, GLOBALS_LEASE)) {
    throw new Error('[fict/ssr] Could not release the process DOM-global compatibility lease.')
  }
  activeGlobalTargets.delete(target)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readTextFileFromPath(path: string): string {
  const g = globalThis as Record<string, unknown>

  const deno = g.Deno as { readTextFileSync?: (path: string) => string } | undefined
  if (deno && typeof deno.readTextFileSync === 'function') {
    return deno.readTextFileSync(path)
  }

  const nodeRequire = getNodeRequire()
  if (nodeRequire) {
    const fs = nodeRequire('node:fs') as {
      readFileSync: (path: string, encoding: string) => string
    }
    return fs.readFileSync(path, 'utf8')
  }

  throw new Error(
    '[fict/ssr] `manifest` as file path is only supported when Deno.readTextFileSync or CommonJS require is available. ' +
      'Pass a manifest object in Node ESM or edge runtimes.',
  )
}
