import { __fictGetCurrentSSRSession } from '@fictjs/runtime/internal'

interface GlobalSnapshot {
  key: string
  exists: boolean
  value: unknown
}

export function installGlobals(window: Window, document: Document): () => void {
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

  const globals = { ...required, ...optional }
  const keys = Object.keys(globals)

  const snapshot = captureGlobals(keys)
  for (const key of keys) {
    const value = globals[key]
    if (value !== undefined) {
      ;(globalThis as Record<string, unknown>)[key] = value
    }
  }

  return () => restoreGlobals(snapshot)
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

function captureGlobals(keys: string[]): GlobalSnapshot[] {
  const snapshot: GlobalSnapshot[] = []
  for (const key of keys) {
    const exists = Object.prototype.hasOwnProperty.call(globalThis, key)
    const value = (globalThis as Record<string, unknown>)[key]
    snapshot.push({ key, exists, value })
  }
  return snapshot
}

function restoreGlobals(snapshot: GlobalSnapshot[]): void {
  for (const entry of snapshot) {
    if (entry.exists) {
      ;(globalThis as Record<string, unknown>)[entry.key] = entry.value
    } else {
      delete (globalThis as Record<string, unknown>)[entry.key]
    }
  }
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

function getNodeRequire(): ((specifier: string) => unknown) | null {
  const g = globalThis as Record<string, unknown>
  const direct = g.require
  if (typeof direct === 'function') {
    return direct as (specifier: string) => unknown
  }
  try {
    return Function('return typeof require === "function" ? require : null')() as
      | ((specifier: string) => unknown)
      | null
  } catch {
    return null
  }
}
