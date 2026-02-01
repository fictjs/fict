import { readFileSync } from 'node:fs'

import { render } from '@fictjs/runtime'
import type { FictNode } from '@fictjs/runtime'
import {
  __fictDisableSSR,
  __fictEnableSSR,
  __fictSerializeSSRState,
} from '@fictjs/runtime/internal'
import { parseHTML } from 'linkedom'

const DEFAULT_HTML = '<!doctype html><html><head></head><body></body></html>'

export interface SSRDom {
  window: Window
  document: Document
}

export interface RenderToStringOptions {
  /**
   * Provide a pre-created DOM (document + window). If omitted, a new DOM is
   * created per render using `html`.
   */
  dom?: SSRDom
  /**
   * Provide a document directly. If `window` is omitted, `document.defaultView`
   * will be used when available.
   */
  document?: Document
  /**
   * Provide a window directly. If `document` is omitted, `window.document` is used.
   */
  window?: Window
  /**
   * HTML template used when creating a new DOM.
   */
  html?: string
  /**
   * Provide a container element to render into.
   */
  container?: HTMLElement
  /**
   * Tag name for the auto-created container.
   */
  containerTag?: string
  /**
   * id applied to the auto-created container.
   */
  containerId?: string
  /**
   * Additional attributes applied to the auto-created container.
   */
  containerAttributes?: Record<string, string | number | boolean | null | undefined>
  /**
   * Return the container element including its outer tag.
   */
  includeContainer?: boolean
  /**
   * Return a full HTML document string (doctype + documentElement.outerHTML).
   */
  fullDocument?: boolean
  /**
   * Override doctype when `fullDocument` is true. Use `null` to omit.
   */
  doctype?: string | null
  /**
   * Expose DOM globals (window/document/Node/Element/etc) during render.
   * Defaults to true.
   */
  exposeGlobals?: boolean
  /**
   * Manifest mapping module URLs to built client chunk URLs.
   * Can be an object or a path to a JSON file.
   */
  manifest?: Record<string, string> | string
  /**
   * Include the SSR snapshot script for resumability.
   * Defaults to true.
   */
  includeSnapshot?: boolean
  /**
   * Script element id for the snapshot.
   */
  snapshotScriptId?: string
  /**
   * Where to append the snapshot script when not returning full document.
   * Defaults to 'container'.
   */
  snapshotTarget?: 'container' | 'body' | 'head'
}

export interface RenderToDocumentResult extends SSRDom {
  html: string
  container: HTMLElement
  dispose: () => void
}

export function createSSRDocument(html: string = DEFAULT_HTML): SSRDom {
  const window = parseHTML(html) as Window & typeof globalThis
  const document = window.document as Document | undefined
  if (!window || !document) {
    throw new Error('[fict/ssr] Failed to create DOM. Missing window or document.')
  }
  return { window, document }
}

export function renderToDocument(
  view: () => FictNode,
  options: RenderToStringOptions = {},
): RenderToDocumentResult {
  const includeSnapshot = options.includeSnapshot !== false
  if (includeSnapshot) {
    __fictEnableSSR()
  }
  const dom = resolveDom(options)
  const { document, window } = dom

  const shouldExpose = options.exposeGlobals !== false
  const restoreGlobals = shouldExpose ? installGlobals(window, document) : () => {}
  const restoreManifest = installManifest(options.manifest)

  const container = resolveContainer(document, options)

  let teardown = () => {}
  try {
    teardown = render(view, container)
  } catch (error) {
    if (includeSnapshot) {
      __fictDisableSSR()
    }
    restoreGlobals()
    restoreManifest()
    throw error
  }

  if (includeSnapshot) {
    const state = __fictSerializeSSRState()
    injectSnapshot(document, container, state, options)
    __fictDisableSSR()
  }

  const html = serializeOutput(document, container, options)

  const dispose = () => {
    try {
      teardown()
    } finally {
      restoreGlobals()
      restoreManifest()
    }
  }

  return { html, document, window, container, dispose }
}

export function renderToString(view: () => FictNode, options: RenderToStringOptions = {}): string {
  const result = renderToDocument(view, options)
  const html = result.html
  result.dispose()
  return html
}

export async function renderToStringAsync(
  view: () => FictNode,
  options: RenderToStringOptions = {},
): Promise<string> {
  return renderToString(view, options)
}

function resolveDom(options: RenderToStringOptions): SSRDom {
  if (options.dom) {
    return options.dom
  }

  if (options.document && options.window) {
    return { document: options.document, window: options.window }
  }

  if (options.document) {
    const window =
      options.window ??
      (options.document.defaultView as Window | null) ??
      (options.document as Document & { defaultView?: Window | null }).defaultView ??
      undefined
    if (!window) {
      throw new Error(
        '[fict/ssr] A window is required when providing a document without defaultView.',
      )
    }
    return { document: options.document, window }
  }

  if (options.window) {
    return { document: options.window.document, window: options.window }
  }

  return createSSRDocument(options.html)
}

function resolveContainer(document: Document, options: RenderToStringOptions): HTMLElement {
  if (options.container) {
    if (options.container.ownerDocument && options.container.ownerDocument !== document) {
      throw new Error('[fict/ssr] Provided container belongs to a different document.')
    }
    return options.container
  }

  const tag = options.containerTag ?? 'div'
  const container = document.createElement(tag)
  if (options.containerId) {
    container.setAttribute('id', options.containerId)
  }
  if (options.containerAttributes) {
    for (const [name, value] of Object.entries(options.containerAttributes)) {
      if (value === null || value === undefined || value === false) continue
      container.setAttribute(name, value === true ? '' : String(value))
    }
  }

  if (document.body) {
    document.body.appendChild(container)
  }

  return container
}

function serializeOutput(
  document: Document,
  container: HTMLElement,
  options: RenderToStringOptions,
): string {
  if (options.fullDocument) {
    const doctype = serializeDoctype(document, options.doctype)
    const html = document.documentElement ? document.documentElement.outerHTML : container.outerHTML
    return doctype ? `${doctype}${html}` : html
  }

  if (options.includeContainer) {
    return container.outerHTML
  }

  return container.innerHTML
}

function injectSnapshot(
  document: Document,
  container: HTMLElement,
  state: ReturnType<typeof __fictSerializeSSRState>,
  options: RenderToStringOptions,
): void {
  const script = document.createElement('script')
  script.type = 'application/json'
  script.id = options.snapshotScriptId ?? '__FICT_SNAPSHOT__'
  script.textContent = JSON.stringify(state)

  if (options.fullDocument) {
    if (options.snapshotTarget === 'head' && document.head) {
      document.head.appendChild(script)
      return
    }
    if (document.body) {
      document.body.appendChild(script)
      return
    }
  }

  const target = options.snapshotTarget ?? 'container'
  if (target === 'body' && document.body) {
    document.body.appendChild(script)
    return
  }
  if (target === 'head' && document.head) {
    document.head.appendChild(script)
    return
  }

  container.appendChild(script)
}

function serializeDoctype(document: Document, override?: string | null): string {
  if (override === null) return ''
  if (override !== undefined) return override

  const doctype = document.doctype
  if (!doctype) return ''

  const name = doctype.name || 'html'
  const publicId = doctype.publicId
  const systemId = doctype.systemId

  let id = ''
  if (publicId) {
    id = ` PUBLIC "${publicId}"`
    if (systemId) {
      id += ` "${systemId}"`
    }
  } else if (systemId) {
    id = ` SYSTEM "${systemId}"`
  }

  return `<!DOCTYPE ${name}${id}>`
}

function installGlobals(window: Window, document: Document): () => void {
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

interface GlobalSnapshot {
  key: string
  exists: boolean
  value: unknown
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

function installManifest(manifest?: Record<string, string> | string): () => void {
  if (!manifest) return () => {}

  let resolved: Record<string, string>
  if (typeof manifest === 'string') {
    const raw = readFileSync(manifest, 'utf8')
    resolved = JSON.parse(raw) as Record<string, string>
  } else {
    resolved = manifest
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
