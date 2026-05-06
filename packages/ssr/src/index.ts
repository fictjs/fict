import { render } from '@fictjs/runtime'
import type { FictNode } from '@fictjs/runtime'
import {
  __fictDisableSSR,
  __fictEnableSSR,
  __fictCreateSSRSession,
  __fictGetScopeRegistry,
  __fictGetScopesForBoundary,
  __fictRunWithSSRSession,
  __fictSerializeSSRState,
  __fictSerializeSSRStateForScopes,
  __fictSetSSRStreamHooks,
} from '@fictjs/runtime/internal'
import { parseHTML } from 'linkedom'

import { installGlobals, installManifest } from './globals'
import { createPipeBridge, createQueuedTextStream, type StreamWriter } from './stream-bridge'
import { createStreamRuntimeCode } from './stream-runtime'

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
  /**
   * Nonce applied to generated <script> tags for CSP compatibility.
   */
  scriptNonce?: string
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
  /**
   * How to load the streaming patch runtime.
   * Defaults to 'inline'. Use 'external' with streamRuntimeSrc for strict CSP.
   */
  streamRuntime?: 'inline' | 'external'
  /**
   * External streaming patch runtime URL when streamRuntime is 'external'.
   */
  streamRuntimeSrc?: string
  /**
   * How resolved Suspense patch chunks are applied.
   * Defaults to 'inline' for inline runtimes and 'observer' for external runtimes.
   */
  streamPatchMode?: 'inline' | 'observer'
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
  const session = __fictCreateSSRSession()
  return __fictRunWithSSRSession(session, () => renderToDocumentInSession(view, options))
}

function renderToDocumentInSession(
  view: () => FictNode,
  options: RenderToStringOptions,
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
  const readyResolvers: (() => void)[] = []

  const resolveBackpressure = () => {
    if (!controller || (controller.desiredSize ?? 1) <= 0) return
    while (readyResolvers.length > 0) {
      readyResolvers.shift()?.()
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl
      const started = startStreamingRender(view, options, {
        write(chunk) {
          if (!controller) return
          controller.enqueue(encoder.encode(chunk))
          if ((controller.desiredSize ?? 1) <= 0) {
            return new Promise<void>(resolve => {
              readyResolvers.push(resolve)
            })
          }
          return undefined
        },
        close() {
          while (readyResolvers.length > 0) {
            readyResolvers.shift()?.()
          }
          controller?.close()
        },
        abort(reason?: unknown) {
          while (readyResolvers.length > 0) {
            readyResolvers.shift()?.()
          }
          controller?.error(reason)
        },
      })
      // renderToStream doesn't expose readiness promises, so consume rejections
      // to avoid unhandled promise noise when streaming aborts.
      started.shellReady.catch(() => undefined)
      started.allReady.catch(() => undefined)
    },
    pull() {
      resolveBackpressure()
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
      return bridge.write(chunk)
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
        return queued.writer.write(chunk)
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

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  )
}

function startStreamingRender(
  view: () => FictNode,
  options: RenderToStreamOptions,
  writer: StreamWriter,
  control: StreamingControlOptions = {},
): { shellReady: Promise<void>; allReady: Promise<void>; abort: (reason?: unknown) => void } {
  const session = __fictCreateSSRSession()
  return __fictRunWithSSRSession(session, () =>
    startStreamingRenderInSession(session, view, options, writer, control),
  )
}

type SSRSession = ReturnType<typeof __fictCreateSSRSession>

function startStreamingRenderInSession(
  session: SSRSession,
  view: () => FictNode,
  options: RenderToStreamOptions,
  writer: StreamWriter,
  control: StreamingControlOptions = {},
): { shellReady: Promise<void>; allReady: Promise<void>; abort: (reason?: unknown) => void } {
  const runInSession = <T>(fn: () => T): T => __fictRunWithSSRSession(session, fn)
  const resolvedOptions: RenderToStreamOptions = {
    ...options,
    // Streaming requires a real document; default to fullDocument when unspecified.
    fullDocument: options.fullDocument ?? true,
  }

  let resolveShell!: () => void
  let rejectShell!: (err: unknown) => void
  let resolveAll!: () => void
  let rejectAll!: (err: unknown) => void
  let shellSettled = false

  const shellReady = new Promise<void>((res, rej) => {
    resolveShell = () => {
      if (shellSettled) return
      shellSettled = true
      res()
    }
    rejectShell = err => {
      if (shellSettled) return
      shellSettled = true
      rej(err)
    }
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
  let writeChain: Promise<void> | null = null
  let writeFailed = false
  let removeAbortListener = () => {}

  const mode = options.mode ?? 'shell'
  const includeSnapshot = options.includeSnapshot !== false
  const sentScopes = new Set<string>()

  const boundaryMap = new Map<string, { start: Comment; end: Comment; pending: boolean }>()
  let boundaryId = 0
  let pendingCount = 0

  const handleWriteError = (error: unknown) => {
    if (writeFailed) return
    writeFailed = true
    options.onError?.(error)
    writer.abort(error)
    cleanup()
    rejectShell(error)
    rejectAll(error)
  }

  const enqueueWrite = (chunk: string): void => {
    if (writeFailed) return
    const trackWrite = (promise: Promise<void>) => {
      const tracked = promise.then(
        () => {
          if (writeChain === tracked) {
            writeChain = null
          }
        },
        error => {
          if (writeChain === tracked) {
            writeChain = null
          }
          handleWriteError(error)
        },
      )
      writeChain = tracked
    }
    const writeAsync = () => Promise.resolve(writer.write(chunk)).then(() => undefined)

    if (writeChain) {
      trackWrite(writeChain.then(writeAsync))
      return
    }

    try {
      const result = writer.write(chunk)
      if (isPromiseLike(result)) {
        trackWrite(
          result.then(
            () => undefined,
            error => {
              throw error
            },
          ),
        )
      }
    } catch (error) {
      handleWriteError(error)
    }
  }

  const afterWrites = (fn: () => void): void => {
    const pending = writeChain
    if (!pending) {
      if (!writeFailed) {
        fn()
      }
      return
    }
    void pending.then(() => {
      if (!writeFailed) {
        fn()
      }
    })
  }

  const markShellReady = (): void => {
    afterWrites(() => {
      control.onShellFlushed?.()
      resolveShell()
      options.onShellReady?.()
    })
  }

  const writeSnapshotForScopes = (scopeIds: string[]): void => {
    runInSession(() => {
      if (!includeSnapshot || scopeIds.length === 0) return
      const registry = __fictGetScopeRegistry()
      const pending = scopeIds.filter(id => registry.has(id) && !sentScopes.has(id))
      if (pending.length === 0) return
      const snapshot = __fictSerializeSSRStateForScopes(pending)
      const ids = Object.keys(snapshot.scopes)
      if (ids.length === 0) return
      const chunk = buildIncrementalSnapshotChunk(snapshot, resolvedOptions)
      if (chunk) {
        enqueueWrite(chunk)
      }
      for (const id of ids) {
        sentScopes.add(id)
      }
    })
  }

  const writeSnapshotForBoundary = (boundary: string): void => {
    runInSession(() => {
      const scopes = __fictGetScopesForBoundary(boundary)
      writeSnapshotForScopes(scopes)
    })
  }

  const writeRemainingSnapshots = (): void => {
    runInSession(() => {
      const scopes = Array.from(__fictGetScopeRegistry().keys())
      writeSnapshotForScopes(scopes)
    })
  }

  const cleanup = () => {
    removeAbortListener()
    removeAbortListener = () => {}
    runInSession(() => {
      __fictSetSSRStreamHooks(null)
      __fictDisableSSR()
    })
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
      enqueueWrite(fullHtml)
      afterWrites(() => {
        writer.close()
        cleanup()
        resolveShell()
        resolveAll()
        options.onShellReady?.()
        options.onAllReady?.()
      })
      return
    }

    writeRemainingSnapshots()

    if (tailHtml) {
      enqueueWrite(tailHtml)
    }

    afterWrites(() => {
      writer.close()
      cleanup()
      resolveAll()
      options.onAllReady?.()
    })
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
          enqueueWrite(buildPatchChunk(id, html, resolvedOptions))
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
    writeFailed = true
    writer.abort(reason)
    cleanup()
    const abortReason = reason ?? new Error('Stream aborted')
    rejectShell(abortReason)
    rejectAll(abortReason)
  }

  if (options.signal) {
    if (options.signal.aborted) {
      abort(options.signal.reason)
      return { shellReady, allReady, abort }
    } else {
      const onAbort = () => abort(options.signal?.reason)
      options.signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort)
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
    const streamRuntime = boundaryMap.size > 0 ? buildStreamRuntimeScript(resolvedOptions) : ''
    if (resolvedOptions.fullDocument) {
      const split = splitDocumentHtml(shellHtml)
      if (!split) {
        throw new Error('[fict/ssr] Failed to locate </body> for streaming output.')
      }
      if (control.includeTailInShell) {
        enqueueWrite(split.head + streamRuntime)
        tailHtml = split.tail
        shellCarriesTail = true
      } else {
        enqueueWrite(split.head + streamRuntime)
        tailHtml = split.tail
      }
    } else {
      enqueueWrite(shellHtml + streamRuntime)
    }
    wroteShell = true
    writeSnapshotForScopes(Array.from(__fictGetScopeRegistry().keys()))
    if (shellCarriesTail && tailHtml) {
      enqueueWrite(tailHtml)
      tailHtml = ''
      shellCarriesTail = false
    }
    markShellReady()

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

function buildStreamRuntimeScript(options: RenderToStreamOptions): string {
  const nonce = renderNonceAttribute(options)
  if (options.streamRuntime === 'external') {
    if (!options.streamRuntimeSrc) {
      throw new Error('[fict/ssr] streamRuntimeSrc is required when streamRuntime is "external".')
    }
    return `<script${nonce} src="${escapeAttribute(options.streamRuntimeSrc)}" data-fict-stream-runtime data-fict-stream-observer></script>`
  }

  return `<script${nonce}>${createStreamRuntimeCode({
    observerMode: resolveStreamPatchMode(options) === 'observer',
  })}</script>`
}

function buildPatchChunk(id: string, html: string, options: RenderToStreamOptions): string {
  const template = `<template data-fict-suspense="${escapeAttribute(id)}">${html}</template>`
  if (resolveStreamPatchMode(options) === 'observer') {
    return template
  }
  return `${template}<script${renderNonceAttribute(options)}>__FICT_STREAM.apply("${escapeScriptString(id)}")</script>`
}

function resolveStreamPatchMode(options: RenderToStreamOptions): 'inline' | 'observer' {
  if (options.streamPatchMode) return options.streamPatchMode
  return options.streamRuntime === 'external' ? 'observer' : 'inline'
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
  const json = serializeSnapshotForScript(state)
  const nonce = renderNonceAttribute(options)
  if (options.snapshotTarget === 'head') {
    const jsonLiteral = JSON.stringify(json)
    const setNonce =
      options.scriptNonce !== undefined
        ? `s.setAttribute('nonce',${serializeScriptStringLiteral(options.scriptNonce)});`
        : ''
    return `<script${nonce}>(function(){var s=document.createElement('script');s.type='application/json';s.setAttribute('data-fict-snapshot','');${setNonce}s.textContent=${jsonLiteral};(document.head||document.documentElement).appendChild(s);}())</script>`
  }
  return `<script${nonce} type="application/json" data-fict-snapshot>${json}</script>`
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
  if (options.scriptNonce !== undefined) {
    script.setAttribute('nonce', options.scriptNonce)
  }
  script.textContent = serializeSnapshotForScript(state)

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

function serializeSnapshotForScript(state: ReturnType<typeof __fictSerializeSSRState>): string {
  return JSON.stringify(state)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function serializeScriptStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function renderNonceAttribute(options: RenderToStringOptions): string {
  return options.scriptNonce === undefined ? '' : ` nonce="${escapeAttribute(options.scriptNonce)}"`
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeScriptString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
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
