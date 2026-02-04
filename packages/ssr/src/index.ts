import { render } from '@fictjs/runtime'
import type { FictNode } from '@fictjs/runtime'
import {
  __fictDisableSSR,
  __fictEnableSSR,
  __fictGetScopeRegistry,
  __fictGetScopesForBoundary,
  __fictSerializeSSRState,
  __fictSerializeSSRStateForScopes,
  __fictSetSSRStreamHooks,
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
   * File path mode requires Node.js or Deno filesystem access.
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

export interface RenderToStreamOptions extends RenderToStringOptions {
  /**
   * Streaming mode:
   * - 'shell': send fallback shell first, then patch resolved boundaries
   * - 'all': wait for all suspense boundaries, then send full HTML
   */
  mode?: 'shell' | 'all'
  /**
   * Called once the initial shell has been written.
   */
  onShellReady?: () => void
  /**
   * Called once all pending boundaries resolve and the stream completes.
   */
  onAllReady?: () => void
  /**
   * Called when an error occurs during streaming.
   */
  onError?: (err: unknown) => void
  /**
   * Abort signal to cancel the stream.
   */
  signal?: AbortSignal
}

export interface PipeableStream {
  pipe: (writable: NodeJS.WritableStream) => void
  abort: (reason?: unknown) => void
  shellReady: Promise<void>
  allReady: Promise<void>
}

export interface PartialPrerenderResult {
  /**
   * Complete shell HTML (fallbacks + markers + initial snapshot scripts).
   */
  shell: string
  /**
   * Stream of deferred patch chunks and incremental snapshots.
   */
  stream: ReadableStream<Uint8Array>
  shellReady: Promise<void>
  allReady: Promise<void>
  abort: (reason?: unknown) => void
}

export interface RenderToDocumentResult extends SSRDom {
  html: string
  container: HTMLElement
  dispose: () => void
}

interface StreamingControlOptions {
  includeTailInShell?: boolean
  onShellFlushed?: () => void
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

  // Always enable SSR mode during server rendering.
  // This ensures SSR-specific code paths (list rendering, etc.) work correctly
  // regardless of whether state snapshots are included.
  __fictEnableSSR()

  let dom: SSRDom
  let restoreGlobals = () => {}
  let restoreManifest = () => {}
  let container: HTMLElement
  let teardown = () => {}

  try {
    dom = resolveDom(options)
    const { document, window } = dom

    const shouldExpose = options.exposeGlobals !== false
    restoreGlobals = shouldExpose ? installGlobals(window, document) : () => {}
    restoreManifest = installManifest(options.manifest)

    container = resolveContainer(document, options)
    teardown = render(view, container)

    if (includeSnapshot) {
      const state = __fictSerializeSSRState()
      injectSnapshot(document, container, state, options)
    }
  } catch (error) {
    // Clean up SSR state and globals on any error
    __fictDisableSSR()
    restoreGlobals()
    restoreManifest()
    throw error
  }

  // SSR rendering complete - disable SSR mode
  __fictDisableSSR()

  const html = serializeOutput(dom.document, container!, options)

  const dispose = () => {
    try {
      teardown()
    } finally {
      restoreGlobals()
      restoreManifest()
    }
  }

  return { html, document: dom.document, window: dom.window, container: container!, dispose }
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

export function renderToStream(
  view: () => FictNode,
  options: RenderToStreamOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl
      const started = startStreamingRender(view, options, {
        write(chunk) {
          if (!controller) return
          controller.enqueue(encoder.encode(chunk))
        },
        close() {
          controller?.close()
        },
        abort(reason?: unknown) {
          controller?.error(reason)
        },
      })
      // renderToStream doesn't expose readiness promises, so consume rejections
      // to avoid unhandled promise noise when streaming aborts.
      started.allReady.catch(() => undefined)
    },
  })

  return stream
}

export function renderToPipeableStream(
  view: () => FictNode,
  options: RenderToStreamOptions = {},
): PipeableStream {
  const bridge = createPipeBridge()
  const { shellReady, allReady, abort } = startStreamingRender(view, options, {
    write(chunk) {
      bridge.write(chunk)
    },
    close() {
      bridge.close()
    },
    abort(reason?: unknown) {
      bridge.abort(reason)
    },
  })

  return {
    pipe(writable) {
      bridge.pipe(writable)
    },
    abort,
    shellReady,
    allReady,
  }
}

export function renderToPartial(
  view: () => FictNode,
  options: RenderToStreamOptions = {},
): PartialPrerenderResult {
  const partialOptions: RenderToStreamOptions = {
    ...options,
    mode: 'shell',
    fullDocument: options.fullDocument ?? true,
  }

  let shell = ''
  let shellPhase = true
  const queued = createQueuedTextStream()

  const { shellReady, allReady, abort } = startStreamingRender(
    view,
    partialOptions,
    {
      write(chunk) {
        if (shellPhase) {
          shell += chunk
          return
        }
        queued.writer.write(chunk)
      },
      close() {
        queued.writer.close()
      },
      abort(reason?: unknown) {
        queued.writer.abort(reason)
      },
    },
    {
      includeTailInShell: true,
      onShellFlushed() {
        shellPhase = false
      },
    },
  )

  return {
    shell,
    stream: queued.stream,
    shellReady,
    allReady,
    abort,
  }
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

interface StreamWriter {
  write: (chunk: string) => void
  close: () => void
  abort: (reason?: unknown) => void
}

interface QueuedTextStream {
  stream: ReadableStream<Uint8Array>
  writer: StreamWriter
}

function createQueuedTextStream(): QueuedTextStream {
  const encoder = new TextEncoder()
  const queue: Uint8Array[] = []
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  let aborted: unknown

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl
      for (const chunk of queue) {
        ctrl.enqueue(chunk)
      }
      queue.length = 0
      if (aborted !== undefined) {
        ctrl.error(aborted)
        return
      }
      if (closed) {
        ctrl.close()
      }
    },
  })

  const writer: StreamWriter = {
    write(chunk) {
      if (closed || aborted !== undefined) return
      const data = encoder.encode(chunk)
      if (controller) {
        controller.enqueue(data)
      } else {
        queue.push(data)
      }
    },
    close() {
      if (closed || aborted !== undefined) return
      closed = true
      controller?.close()
    },
    abort(reason?: unknown) {
      if (closed || aborted !== undefined) return
      aborted = reason ?? new Error('Stream aborted')
      controller?.error(aborted)
    },
  }

  return { stream, writer }
}

interface PipeBridge {
  pipe: (writable: NodeJS.WritableStream) => void
  write: (chunk: string) => void
  close: () => void
  abort: (reason?: unknown) => void
}

function createPipeBridge(): PipeBridge {
  const nodeBridge = createNodePipeBridge()
  if (nodeBridge) return nodeBridge

  const targets = new Set<NodeJS.WritableStream>()
  const buffer: string[] = []
  let state: 'open' | 'closed' | 'aborted' = 'open'
  let abortReason: Error | null = null

  const safeWrite = (target: NodeJS.WritableStream, chunk: string) => {
    try {
      target.write(chunk)
    } catch {
      // Ignore target write errors to keep stream lifecycle deterministic.
    }
  }

  const safeEnd = (target: NodeJS.WritableStream) => {
    try {
      target.end()
    } catch {
      // Ignore end errors from downstream writable.
    }
  }

  const safeDestroy = (target: NodeJS.WritableStream, reason: Error) => {
    const withDestroy = target as NodeJS.WritableStream & { destroy?: (error?: Error) => void }
    if (typeof withDestroy.destroy === 'function') {
      try {
        withDestroy.destroy(reason)
      } catch {
        // Ignore destroy errors from downstream writable.
      }
      return
    }
    safeEnd(target)
  }

  return {
    pipe(writable) {
      targets.add(writable)
      if (buffer.length > 0) {
        for (const chunk of buffer) {
          safeWrite(writable, chunk)
        }
        buffer.length = 0
      }
      if (state === 'closed') {
        safeEnd(writable)
      } else if (state === 'aborted') {
        safeDestroy(writable, abortReason ?? new Error('Stream aborted'))
      }
    },
    write(chunk) {
      if (state !== 'open') return
      if (targets.size === 0) {
        buffer.push(chunk)
        return
      }
      for (const target of targets) {
        safeWrite(target, chunk)
      }
    },
    close() {
      if (state !== 'open') return
      state = 'closed'
      for (const target of targets) {
        safeEnd(target)
      }
      if (targets.size > 0) {
        buffer.length = 0
      }
    },
    abort(reason?: unknown) {
      if (state !== 'open') return
      state = 'aborted'
      abortReason = reason instanceof Error ? reason : new Error('Stream aborted')
      for (const target of targets) {
        safeDestroy(target, abortReason)
      }
      buffer.length = 0
    },
  }
}

interface NodePassThroughLike {
  pipe: (destination: NodeJS.WritableStream) => unknown
  write: (chunk: string | Uint8Array) => boolean
  end: (...args: unknown[]) => unknown
  destroy?: (error?: Error) => void
}

function createNodePipeBridge(): PipeBridge | null {
  const nodeRequire = getNodeRequire()
  if (!nodeRequire) return null
  try {
    const streamModule = nodeRequire('node:stream') as {
      PassThrough?: new (...args: unknown[]) => NodePassThroughLike
    }
    if (!streamModule.PassThrough) return null
    const passThrough = new streamModule.PassThrough()

    return {
      pipe(writable) {
        passThrough.pipe(writable)
      },
      write(chunk) {
        passThrough.write(chunk)
      },
      close() {
        passThrough.end()
      },
      abort(reason?: unknown) {
        const error = reason instanceof Error ? reason : new Error('Stream aborted')
        if (typeof passThrough.destroy === 'function') {
          passThrough.destroy(error)
        } else {
          passThrough.end()
        }
      },
    }
  } catch {
    return null
  }
}

function startStreamingRender(
  view: () => FictNode,
  options: RenderToStreamOptions,
  writer: StreamWriter,
  control: StreamingControlOptions = {},
): { shellReady: Promise<void>; allReady: Promise<void>; abort: (reason?: unknown) => void } {
  const resolvedOptions: RenderToStringOptions = {
    ...options,
    // Streaming requires a real document; default to fullDocument when unspecified.
    fullDocument: options.fullDocument ?? true,
  }

  let resolveShell!: () => void
  let resolveAll!: () => void
  let rejectAll!: (err: unknown) => void

  const shellReady = new Promise<void>(res => {
    resolveShell = res
  })
  const allReady = new Promise<void>((res, rej) => {
    resolveAll = res
    rejectAll = rej
  })

  let dom: SSRDom | null = null
  let restoreGlobals = () => {}
  let restoreManifest = () => {}
  let teardown = () => {}
  let container: HTMLElement | null = null
  let closed = false
  let tailHtml = ''
  let wroteShell = false
  let shellCarriesTail = false

  const mode = options.mode ?? 'shell'
  const includeSnapshot = options.includeSnapshot !== false
  const sentScopes = new Set<string>()

  const boundaryMap = new Map<string, { start: Comment; end: Comment; pending: boolean }>()
  let boundaryId = 0
  let pendingCount = 0

  const writeSnapshotForScopes = (scopeIds: string[]): void => {
    if (!includeSnapshot || scopeIds.length === 0) return
    const registry = __fictGetScopeRegistry()
    const pending = scopeIds.filter(id => registry.has(id) && !sentScopes.has(id))
    if (pending.length === 0) return
    const snapshot = __fictSerializeSSRStateForScopes(pending)
    const ids = Object.keys(snapshot.scopes)
    if (ids.length === 0) return
    const chunk = buildIncrementalSnapshotChunk(snapshot, resolvedOptions)
    if (chunk) {
      writer.write(chunk)
    }
    for (const id of ids) {
      sentScopes.add(id)
    }
  }

  const writeSnapshotForBoundary = (boundary: string): void => {
    const scopes = __fictGetScopesForBoundary(boundary)
    writeSnapshotForScopes(scopes)
  }

  const writeRemainingSnapshots = (): void => {
    const scopes = Array.from(__fictGetScopeRegistry().keys())
    writeSnapshotForScopes(scopes)
  }

  const cleanup = () => {
    __fictSetSSRStreamHooks(null)
    __fictDisableSSR()
    restoreGlobals()
    restoreManifest()
    try {
      teardown()
    } catch {
      // ignore cleanup errors
    }
  }

  const finalize = () => {
    if (closed) return
    closed = true

    if (mode === 'all' && dom && container && !wroteShell) {
      if (includeSnapshot) {
        const snapshot = __fictSerializeSSRState()
        injectSnapshot(dom.document, container, snapshot, resolvedOptions)
      }
      const fullHtml = serializeOutput(dom.document, container, resolvedOptions)
      writer.write(fullHtml)
      writer.close()
      cleanup()
      resolveShell()
      resolveAll()
      options.onShellReady?.()
      options.onAllReady?.()
      return
    }

    writeRemainingSnapshots()

    if (tailHtml) {
      writer.write(tailHtml)
    }

    writer.close()
    cleanup()
    resolveAll()
    options.onAllReady?.()
  }

  const maybeFinalize = () => {
    if (pendingCount === 0) {
      finalize()
    }
  }

  const hooks = {
    registerBoundary(start: Comment, end: Comment) {
      const id = `s${++boundaryId}`
      boundaryMap.set(id, { start, end, pending: false })
      return id
    },
    boundaryPending(id: string) {
      const entry = boundaryMap.get(id)
      if (!entry || entry.pending) return
      entry.pending = true
      pendingCount++
    },
    boundaryResolved(id: string) {
      const entry = boundaryMap.get(id)
      if (!entry) return
      if (entry.pending) {
        entry.pending = false
        pendingCount = Math.max(0, pendingCount - 1)
      }
      if (mode === 'shell') {
        writeSnapshotForBoundary(id)
        if (dom) {
          const html = serializeBetween(dom.document, entry.start, entry.end)
          writer.write(buildPatchChunk(id, html))
        }
      }
      maybeFinalize()
    },
    onError(err: unknown) {
      options.onError?.(err)
      abort(err)
    },
  }

  const abort = (reason?: unknown) => {
    if (closed) return
    closed = true
    writer.abort(reason)
    cleanup()
    rejectAll(reason ?? new Error('Stream aborted'))
  }

  if (options.signal) {
    if (options.signal.aborted) {
      abort(options.signal.reason)
    } else {
      options.signal.addEventListener('abort', () => abort(options.signal?.reason), { once: true })
    }
  }

  try {
    __fictEnableSSR()
    __fictSetSSRStreamHooks(hooks)

    dom = resolveDom(resolvedOptions)
    restoreGlobals =
      resolvedOptions.exposeGlobals !== false ? installGlobals(dom.window, dom.document) : () => {}
    restoreManifest = installManifest(resolvedOptions.manifest)

    container = resolveContainer(dom.document, resolvedOptions)
    teardown = render(view, container)

    if (mode === 'all') {
      if (pendingCount === 0) {
        finalize()
      }
      return { shellReady, allReady, abort }
    }

    // shell-first mode
    const shellHtml = serializeOutput(dom.document, container, resolvedOptions)
    const streamRuntime = boundaryMap.size > 0 ? buildStreamRuntimeScript() : ''
    if (resolvedOptions.fullDocument) {
      const split = splitDocumentHtml(shellHtml)
      if (!split) {
        throw new Error('[fict/ssr] Failed to locate </body> for streaming output.')
      }
      if (control.includeTailInShell) {
        writer.write(split.head + streamRuntime)
        tailHtml = split.tail
        shellCarriesTail = true
      } else {
        writer.write(split.head + streamRuntime)
        tailHtml = split.tail
      }
    } else {
      writer.write(shellHtml + streamRuntime)
    }
    wroteShell = true
    writeSnapshotForScopes(Array.from(__fictGetScopeRegistry().keys()))
    if (shellCarriesTail && tailHtml) {
      writer.write(tailHtml)
      tailHtml = ''
      shellCarriesTail = false
    }
    control.onShellFlushed?.()
    resolveShell()
    options.onShellReady?.()

    // If no pending boundaries, finalize immediately.
    maybeFinalize()
  } catch (err) {
    options.onError?.(err)
    abort(err)
  }

  return { shellReady, allReady, abort }
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

function buildStreamRuntimeScript(): string {
  return (
    '<script>(function(){' +
    'if(window.__FICT_STREAM)return;' +
    'var cache=new Map();' +
    'function find(id){' +
    'var hit=cache.get(id);if(hit)return hit;' +
    'var start=null,end=null;' +
    'var w=document.createTreeWalker(document,NodeFilter.SHOW_COMMENT);' +
    'while(w.nextNode()){' +
    'var n=w.currentNode;var d=n.data;' +
    'if(d==="fict:suspense-start:"+id)start=n;' +
    'else if(d==="fict:suspense-end:"+id)end=n;' +
    'if(start&&end)break;' +
    '}' +
    'if(start&&end){hit={start:start,end:end};cache.set(id,hit);}return hit;' +
    '}' +
    'function apply(id){' +
    "var tpl=document.querySelector('template[data-fict-suspense=\"' + id + '\"]');" +
    'if(!tpl)return;' +
    'var b=find(id);if(!b)return;' +
    'var node=b.start.nextSibling;' +
    'while(node&&node!==b.end){var next=node.nextSibling;node.parentNode&&node.parentNode.removeChild(node);node=next;}' +
    'b.end.parentNode&&b.end.parentNode.insertBefore(tpl.content,b.end);' +
    'tpl.parentNode&&tpl.parentNode.removeChild(tpl);' +
    '}' +
    'window.__FICT_STREAM={apply:apply};' +
    '})();</script>'
  )
}

function buildPatchChunk(id: string, html: string): string {
  return (
    `<template data-fict-suspense="${id}">` +
    html +
    `</template><script>__FICT_STREAM.apply("${id}")</script>`
  )
}

function serializeBetween(document: Document, start: Comment, end: Comment): string {
  const wrapper = document.createElement('div')
  let node = start.nextSibling
  while (node && node !== end) {
    wrapper.appendChild(node.cloneNode(true) as Node)
    node = node.nextSibling
  }
  return wrapper.innerHTML
}

function splitDocumentHtml(html: string): { head: string; tail: string } | null {
  const lower = html.toLowerCase()
  const idx = lower.lastIndexOf('</body>')
  if (idx === -1) return null
  return { head: html.slice(0, idx), tail: html.slice(idx) }
}

function buildIncrementalSnapshotChunk(
  state: ReturnType<typeof __fictSerializeSSRState>,
  options: RenderToStringOptions,
): string {
  const json = JSON.stringify(state)
  if (options.snapshotTarget === 'head') {
    const jsonLiteral = JSON.stringify(json)
    return `<script>(function(){var s=document.createElement('script');s.type='application/json';s.setAttribute('data-fict-snapshot','');s.textContent=${jsonLiteral};(document.head||document.documentElement).appendChild(s);}())</script>`
  }
  return `<script type="application/json" data-fict-snapshot>${json}</script>`
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
    '[fict/ssr] `manifest` as file path is only supported in Node.js or Deno. ' +
      'Pass a manifest object in edge runtimes.',
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

function installManifest(manifest?: Record<string, string> | string): () => void {
  if (!manifest) return () => {}

  let resolved: Record<string, string>
  if (typeof manifest === 'string') {
    const raw = readTextFileFromPath(manifest)
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
