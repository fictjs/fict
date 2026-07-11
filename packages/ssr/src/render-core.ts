import { render } from '@fictjs/runtime'
import type { FictNode } from '@fictjs/runtime'
import {
  __fictDisableSSR,
  __fictEnableSSR,
  __fictCreateSSRSession,
  __fictGetScopeRegistry,
  __fictRetainSSRSession,
  __fictRunWithSSRSession,
  __fictSerializeSSRState,
  __fictSerializeSSRStateForScopes,
  __fictSetSSRScopeIdentifierPrefix,
  __fictSetSSRStreamHooks,
  assertValidDOMAttributeName,
  assertValidDOMElementName,
} from '@fictjs/runtime/internal'
import { parseHTML } from 'linkedom'

import { installGlobals, installManifest } from './globals'
import { serializeHtmlChildren, serializeHtmlNode, serializeHtmlNodes } from './html-serializer'
import { createPipeBridge, createQueuedTextStream, type StreamWriter } from './stream-bridge'
import { createStreamRuntimeCode } from './stream-runtime'

const DEFAULT_HTML = '<!doctype html><html><head></head><body></body></html>'
const SVG_HTML_INTEGRATION_POINTS = new Set(['foreignobject', 'title', 'desc'])
const MATHML_TEXT_INTEGRATION_POINTS = new Set(['mi', 'mo', 'mn', 'ms', 'mtext'])
const IDENTIFIER_PREFIX_PATTERN = /^[A-Za-z0-9_.:-]+$/
let streamTailMarkerId = 0
let scopeIdentifierSequence = 0
let streamIdentifierSequence = 0
const ssrIdentifierSeed = createIdentifierSeed()

type StreamPatchNamespace = 'svg' | 'mathml' | null

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
   * Defaults to false. Set to true only for compatibility with components
   * that still read process-global DOM objects during server rendering.
   */
  exposeGlobals?: boolean
  /**
   * Manifest mapping module URLs to built client chunk URLs.
   * Can be an object or a path to a JSON file.
   * File path mode requires Deno sync filesystem access or a CommonJS
   * environment where `require('node:fs')` is available. Pass an object when
   * rendering from Node ESM or edge runtimes.
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
  /**
   * Stable namespace for resumable scope identifiers in `data-fict-s` and
   * snapshot payloads. Set this when independently cached or separately rendered
   * outputs can share a document, and keep it unique within that document.
   * This does not change streaming Suspense patch identifiers.
   *
   * Values must contain 1-128 ASCII letters, digits, `_`, `.`, `:`, or `-`, and
   * must not contain `--`. When omitted, each render gets an automatic edge-safe
   * namespace.
   */
  scopeIdentifierPrefix?: string
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
  /**
   * Stable namespace for Suspense patch identifiers. Set this when independently
   * cached or separately rendered streams can share a document, and keep it unique
   * within that document. This does not change resumable scope identifiers.
   *
   * Values must contain 1-128 ASCII letters, digits, `_`, `.`, `:`, or `-`, and
   * must not contain `--`. When omitted, each shell stream gets an automatic
   * edge-safe namespace.
   */
  streamIdentifierPrefix?: string
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
   *
   * @experimental Preview API for v1.0; the access pattern may change before
   * this becomes stable.
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
  validateScopeIdentifierPrefix(options.scopeIdentifierPrefix)
  const scopeIdentifierPrefix = resolveScopeIdentifierPrefix(options.scopeIdentifierPrefix)
  const includeSnapshot = options.includeSnapshot !== false

  // Always enable SSR mode during server rendering.
  // This ensures SSR-specific code paths (list rendering, etc.) work correctly
  // regardless of whether state snapshots are included.
  __fictEnableSSR()
  __fictSetSSRScopeIdentifierPrefix(scopeIdentifierPrefix)

  let dom: SSRDom
  let restoreGlobals = () => {}
  let restoreManifest = () => {}
  let container: HTMLElement
  let teardown = () => {}

  try {
    dom = resolveDom(options)
    const { document, window } = dom

    const shouldExpose = options.exposeGlobals === true
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
    cleanupRenderResources(teardown, restoreGlobals, restoreManifest, true)
    throw error
  }

  // SSR rendering complete - disable SSR mode
  __fictDisableSSR()

  let html: string
  try {
    html = serializeOutput(dom.document, container!, options)
  } catch (error) {
    cleanupRenderResources(teardown, restoreGlobals, restoreManifest, true)
    throw error
  }

  const dispose = () => cleanupRenderResources(teardown, restoreGlobals, restoreManifest, false)

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
  let html = ''
  const renderResult = startStreamingRender(
    view,
    {
      ...options,
      mode: 'all',
      // Streaming defaults to a full document, while the string APIs default
      // to the rendered container's children. Preserve renderToString's
      // output contract unless the caller explicitly requests a document.
      fullDocument: options.fullDocument ?? false,
    },
    {
      write(chunk) {
        html += chunk
      },
      close() {},
      abort() {},
    },
  )

  // `allReady` is the async stability point: every registered Suspense
  // boundary has resolved and its final DOM has been rendered. Await
  // `shellReady` as well so render failures settle both readiness promises
  // without leaving an unobserved rejection.
  await Promise.all([renderResult.shellReady, renderResult.allReady])
  return html
}

export function renderToStream(
  view: () => FictNode,
  options: RenderToStreamOptions = {},
): ReadableStream<Uint8Array> {
  validateScopeIdentifierPrefix(options.scopeIdentifierPrefix)
  validateStreamIdentifierPrefix(options.streamIdentifierPrefix)
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let abortRender: ((reason?: unknown) => void) | null = null
  const readyResolvers: (() => void)[] = []

  const drainBackpressure = () => {
    while (readyResolvers.length > 0) {
      readyResolvers.shift()?.()
    }
  }

  const resolveBackpressure = () => {
    if (!controller || (controller.desiredSize ?? 1) <= 0) return
    drainBackpressure()
  }

  const closeController = () => {
    abortRender = null
    drainBackpressure()
    if (!controller) return
    try {
      controller.close()
    } finally {
      controller = null
    }
  }

  const errorController = (reason?: unknown) => {
    abortRender = null
    drainBackpressure()
    if (!controller) return
    try {
      controller.error(reason)
    } finally {
      controller = null
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
          closeController()
        },
        abort(reason?: unknown) {
          errorController(reason)
        },
      })
      abortRender = started.abort
      // renderToStream doesn't expose readiness promises, so consume rejections
      // to avoid unhandled promise noise when streaming aborts.
      started.shellReady.catch(() => undefined)
      started.allReady.catch(() => undefined)
    },
    pull() {
      resolveBackpressure()
    },
    cancel(reason?: unknown) {
      const abort = abortRender
      controller = null
      drainBackpressure()
      abort?.(reason ?? new Error('Stream canceled'))
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
      // Route downstream-sink errors to abort so a failing sink rejects
      // shellReady/allReady and runs cleanup instead of hanging the render.
      bridge.pipe(writable, { onError: abort })
    },
    abort,
    shellReady,
    allReady,
  }
}

/**
 * @experimental Preview API for v1.0; the return shape may change before this
 * becomes stable.
 */
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
  let abortPartial: ((reason?: unknown) => void) | null = null
  const queued = createQueuedTextStream({
    onCancel(reason) {
      abortPartial?.(reason ?? new Error('Stream canceled'))
    },
  })

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
  abortPartial = abort

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

function cleanupRenderResources(
  teardown: () => void,
  restoreGlobals: () => void,
  restoreManifest: () => void,
  suppressErrors: boolean,
): void {
  let failed = false
  let firstError: unknown
  for (const cleanup of [teardown, restoreGlobals, restoreManifest]) {
    try {
      cleanup()
    } catch (error) {
      if (!failed) {
        failed = true
        firstError = error
      }
    }
  }
  if (failed && !suppressErrors) throw firstError
}

function startStreamingRender(
  view: () => FictNode,
  options: RenderToStreamOptions,
  writer: StreamWriter,
  control: StreamingControlOptions = {},
): { shellReady: Promise<void>; allReady: Promise<void>; abort: (reason?: unknown) => void } {
  const session = __fictCreateSSRSession()
  const releaseSession = __fictRetainSSRSession()
  try {
    return __fictRunWithSSRSession(session, () =>
      startStreamingRenderInSession(session, view, options, writer, releaseSession, control),
    )
  } catch (error) {
    releaseSession()
    throw error
  }
}

type SSRSession = ReturnType<typeof __fictCreateSSRSession>

function startStreamingRenderInSession(
  session: SSRSession,
  view: () => FictNode,
  options: RenderToStreamOptions,
  writer: StreamWriter,
  releaseSession: () => void,
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
  let failureReported = false
  let cleaned = false
  let removeAbortListener = () => {}
  let canFinalize = false

  validateScopeIdentifierPrefix(options.scopeIdentifierPrefix)
  validateStreamIdentifierPrefix(options.streamIdentifierPrefix)
  const mode = options.mode ?? 'shell'
  const scopeIdentifierPrefix = resolveScopeIdentifierPrefix(options.scopeIdentifierPrefix)
  const streamIdentifierPrefix =
    mode === 'shell' ? resolveStreamIdentifierPrefix(options.streamIdentifierPrefix) : null
  const includeSnapshot = options.includeSnapshot !== false
  const sentScopeSnapshots = new Map<string, string>()

  const boundaryMap = new Map<string, { start: Comment; end: Comment; pending: boolean }>()
  let boundaryId = 0
  let pendingCount = 0

  const handleWriteError = (error: unknown) => {
    if (writeFailed) return
    reportErrorAndAbort(error)
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
      try {
        control.onShellFlushed?.()
      } catch (error) {
        reportErrorAndAbort(error)
        return
      }
      resolveShell()
      callLifecycleCallback(options.onShellReady)
    })
  }

  const writeSnapshotForScopes = (scopeIds: string[]): void => {
    runInSession(() => {
      if (!includeSnapshot || scopeIds.length === 0) return
      const registry = __fictGetScopeRegistry()
      const pending = Array.from(new Set(scopeIds)).filter(id => registry.has(id))
      if (pending.length === 0) return
      const snapshot = __fictSerializeSSRStateForScopes(pending)
      const changedScopes = Object.create(null) as typeof snapshot.scopes
      const changedSignatures = new Map<string, string>()
      for (const [id, scope] of Object.entries(snapshot.scopes)) {
        const signature = JSON.stringify(scope)
        if (sentScopeSnapshots.get(id) === signature) continue
        changedScopes[id] = scope
        changedSignatures.set(id, signature)
      }
      const ids = Object.keys(changedScopes)
      if (ids.length === 0) return
      const chunk = buildIncrementalSnapshotChunk(
        { ...snapshot, scopes: changedScopes },
        resolvedOptions,
      )
      if (chunk) {
        enqueueWrite(chunk)
      }
      for (const id of ids) {
        sentScopeSnapshots.set(id, changedSignatures.get(id)!)
      }
    })
  }

  const writeSnapshotForBoundary = (start: Comment, end: Comment): void => {
    runInSession(() => {
      // Include scope hosts that become visible in this patch plus the owning
      // ancestor scopes whose state may have changed while resolving it. Avoid
      // publishing unrelated live sibling revisions without a matching DOM patch.
      const scopes = collectPatchScopeIds(start, end)
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
    if (cleaned) return
    cleaned = true
    try {
      removeAbortListener()
    } catch {
      // Cleanup must remain best-effort so readiness promises always settle.
    }
    removeAbortListener = () => {}
    try {
      runInSession(() => {
        __fictSetSSRStreamHooks(null)
        __fictDisableSSR()
      })
    } catch {
      // Continue with owner/global cleanup even if session reset fails.
    }
    try {
      cleanupRenderResources(teardown, restoreGlobals, restoreManifest, true)
    } finally {
      releaseSession()
    }
  }

  const reportErrorAndAbort = (error: unknown) => {
    if (failureReported) {
      abort(error)
      return
    }
    failureReported = true
    let abortReason = error
    try {
      options.onError?.(error)
    } catch (onErrorFailure) {
      abortReason = onErrorFailure
    }
    abort(abortReason)
  }

  const callLifecycleCallback = (callback: (() => void) | undefined): void => {
    try {
      callback?.()
    } catch (error) {
      reportErrorAndAbort(error)
    }
  }

  const finalize = () => {
    if (closed) return

    if (mode === 'all' && dom && container && !wroteShell) {
      let fullHtml: string
      try {
        if (includeSnapshot) {
          const snapshot = __fictSerializeSSRState()
          injectSnapshot(dom.document, container, snapshot, resolvedOptions)
        }
        fullHtml = serializeOutput(dom.document, container, resolvedOptions)
      } catch (error) {
        reportErrorAndAbort(error)
        return
      }

      closed = true
      enqueueWrite(fullHtml)
      afterWrites(() => {
        try {
          writer.close()
        } catch (error) {
          reportErrorAndAbort(error)
          return
        }
        cleanup()
        resolveShell()
        resolveAll()
        callLifecycleCallback(options.onShellReady)
        callLifecycleCallback(options.onAllReady)
      })
      return
    }

    try {
      writeRemainingSnapshots()
    } catch (error) {
      reportErrorAndAbort(error)
      return
    }
    if (writeFailed) return
    closed = true

    if (tailHtml) {
      enqueueWrite(tailHtml)
    }

    afterWrites(() => {
      try {
        writer.close()
      } catch (error) {
        reportErrorAndAbort(error)
        return
      }
      cleanup()
      resolveAll()
      callLifecycleCallback(options.onAllReady)
    })
  }

  const maybeFinalize = () => {
    if (canFinalize && pendingCount === 0) {
      finalize()
    }
  }

  const registerStreamBoundary = (start: Comment, end: Comment): string => {
    const localId = `s${++boundaryId}`
    const id = streamIdentifierPrefix ? `${streamIdentifierPrefix}:${localId}` : localId
    boundaryMap.set(id, { start, end, pending: false })
    return id
  }

  const hooks = {
    registerBoundary: registerStreamBoundary,
    registerErrorBoundary: registerStreamBoundary,
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
      if (mode === 'shell' && wroteShell) {
        try {
          if (dom) {
            writeSnapshotForBoundary(entry.start, entry.end)
            const content = serializeBetween(entry.start, entry.end)
            enqueueWrite(buildPatchChunk(id, content, resolvedOptions))
          }
        } catch (error) {
          reportErrorAndAbort(error)
          return
        }
      }
      maybeFinalize()
    },
    boundaryAbandoned(id: string) {
      const entry = boundaryMap.get(id)
      if (!entry) return
      boundaryMap.delete(id)
      if (entry.pending) {
        pendingCount = Math.max(0, pendingCount - 1)
      }
      maybeFinalize()
    },
    onError(err: unknown) {
      reportErrorAndAbort(err)
    },
  }

  const abort = (reason?: unknown) => {
    const abortReason = reason ?? new Error('Stream aborted')
    if (!cleaned) {
      closed = true
      writeFailed = true
      cleanup()
      try {
        writer.abort(abortReason)
      } catch {
        // A broken sink must not prevent readiness promises from rejecting.
      }
    }
    // Always settle. A late sink error can arrive after finalize() set `closed`
    // but before its (stalled) write chain resolves; rejecting an already-settled
    // promise is a no-op, so this is safe and prevents allReady from hanging.
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
    __fictSetSSRScopeIdentifierPrefix(scopeIdentifierPrefix)
    __fictSetSSRStreamHooks(hooks)

    dom = resolveDom(resolvedOptions)
    restoreGlobals =
      resolvedOptions.exposeGlobals === true ? installGlobals(dom.window, dom.document) : () => {}
    restoreManifest = installManifest(resolvedOptions.manifest)

    container = resolveContainer(dom.document, resolvedOptions)
    teardown = render(view, container)

    if (mode === 'all') {
      canFinalize = true
      maybeFinalize()
      return { shellReady, allReady, abort }
    }

    // shell-first mode
    const streamRuntime = boundaryMap.size > 0 ? buildStreamRuntimeScript(resolvedOptions) : ''
    if (resolvedOptions.fullDocument) {
      const split = serializeStreamingDocument(dom.document, container, resolvedOptions)
      if (!split) {
        throw new Error('[fict/ssr] Failed to locate the document body for streaming output.')
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
      const shellHtml = serializeOutput(dom.document, container, resolvedOptions)
      enqueueWrite(shellHtml + streamRuntime)
    }
    if (writeFailed) return { shellReady, allReady, abort }
    wroteShell = true
    writeSnapshotForScopes(Array.from(__fictGetScopeRegistry().keys()))
    if (shellCarriesTail && tailHtml) {
      enqueueWrite(tailHtml)
      tailHtml = ''
      shellCarriesTail = false
    }
    markShellReady()

    // If no pending boundaries, finalize immediately.
    canFinalize = true
    maybeFinalize()
  } catch (err) {
    reportErrorAndAbort(err)
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
  assertValidDOMElementName(tag)
  const container = document.createElement(tag)
  if (options.containerId) {
    container.setAttribute('id', options.containerId)
  }
  if (options.containerAttributes) {
    for (const [name, value] of Object.entries(options.containerAttributes)) {
      assertValidDOMAttributeName(name)
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

function buildPatchChunk(
  id: string,
  content: { html: string; namespace: StreamPatchNamespace },
  options: RenderToStreamOptions,
): string {
  const namespaceAttribute = content.namespace
    ? ` data-fict-patch-namespace="${content.namespace}"`
    : ''
  const html =
    content.namespace === 'svg'
      ? `<svg>${content.html}</svg>`
      : content.namespace === 'mathml'
        ? `<math>${content.html}</math>`
        : content.html
  const template = `<template data-fict-suspense="${escapeAttribute(id)}"${namespaceAttribute}>${html}</template>`
  if (resolveStreamPatchMode(options) === 'observer') {
    return template
  }
  return `${template}<script${renderNonceAttribute(options)}>__FICT_STREAM.apply("${escapeScriptString(id)}")</script>`
}

function resolveStreamPatchMode(options: RenderToStreamOptions): 'inline' | 'observer' {
  if (options.streamPatchMode) return options.streamPatchMode
  return options.streamRuntime === 'external' ? 'observer' : 'inline'
}

function resolveStreamIdentifierPrefix(configured: string | undefined): string {
  if (configured !== undefined) return configured

  return `f${ssrIdentifierSeed}.${(++streamIdentifierSequence).toString(36)}`
}

function validateStreamIdentifierPrefix(configured: unknown): void {
  validateIdentifierPrefix('streamIdentifierPrefix', configured)
}

function resolveScopeIdentifierPrefix(configured: string | undefined): string {
  if (configured !== undefined) return configured

  return `r${ssrIdentifierSeed}.${(++scopeIdentifierSequence).toString(36)}`
}

function validateScopeIdentifierPrefix(configured: unknown): void {
  validateIdentifierPrefix('scopeIdentifierPrefix', configured)
}

function validateIdentifierPrefix(option: string, configured: unknown): void {
  if (configured === undefined) return
  if (
    typeof configured !== 'string' ||
    configured.length === 0 ||
    configured.length > 128 ||
    !IDENTIFIER_PREFIX_PATTERN.test(configured) ||
    configured.includes('--')
  ) {
    throw new TypeError(
      `[fict/ssr] ${option} must contain 1-128 ASCII letters, digits, "_", ".", ":", or "-", and must not contain "--".`,
    )
  }
}

function createIdentifierSeed(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.()
    const normalized = uuid?.replace(/[^A-Za-z0-9]/g, '')
    if (normalized) return normalized
  } catch {
    // Fall through for edge runtimes that expose a partial or guarded Crypto object.
  }

  const random = Math.random().toString(36).slice(2) || '0'
  return `${Date.now().toString(36)}${random}`
}

function serializeBetween(
  start: Comment,
  end: Comment,
): { html: string; namespace: StreamPatchNamespace } {
  const parentElement =
    start.parentElement ?? (start.parentNode?.nodeType === 1 ? (start.parentNode as Element) : null)
  const nodes: Node[] = []
  let node = start.nextSibling
  while (node && node !== end) {
    nodes.push(node)
    node = node.nextSibling
  }
  const namespace = resolveStreamPatchNamespace(parentElement)
  return { html: serializeHtmlNodes(nodes, parentElement), namespace }
}

function collectPatchScopeIds(start: Comment, end: Comment): string[] {
  const ids = new Set<string>()
  const addScopeId = (element: Element) => {
    const id = element.getAttribute('data-fict-s')
    if (id) ids.add(id)
  }
  const addVisibleSubtree = (element: Element) => {
    addScopeId(element)
    for (const descendant of element.querySelectorAll('[data-fict-s]')) {
      addScopeId(descendant)
    }
  }

  const parentElement =
    start.parentElement ?? (start.parentNode?.nodeType === 1 ? (start.parentNode as Element) : null)
  let ancestor = parentElement
  while (ancestor) {
    addScopeId(ancestor)
    ancestor = ancestor.parentElement
  }

  let node = start.nextSibling
  while (node && node !== end) {
    if (node.nodeType === 1) {
      addVisibleSubtree(node as Element)
    }
    node = node.nextSibling
  }

  return Array.from(ids)
}

function resolveStreamPatchNamespace(parentElement: Element | null): StreamPatchNamespace {
  if (!parentElement) return null

  // linkedom currently reports MathML elements as XHTML. Recover the parser
  // context from tag ancestry. Walking from the boundary outward also lets a
  // nested <svg>/<math> override an older HTML integration point.
  let element: Element | null = parentElement
  let descendantLocalName: string | null = null
  while (element) {
    const localName = element.localName.toLowerCase()
    if (SVG_HTML_INTEGRATION_POINTS.has(localName)) return null
    if (MATHML_TEXT_INTEGRATION_POINTS.has(localName)) {
      if (descendantLocalName === 'mglyph' || descendantLocalName === 'malignmark') {
        return 'mathml'
      }
      return null
    }
    if (isHtmlAnnotationIntegrationPoint(element)) return null
    if (localName === 'svg') return 'svg'
    if (localName === 'math') return 'mathml'
    descendantLocalName = localName
    element = element.parentElement
  }
  return null
}

function isHtmlAnnotationIntegrationPoint(element: Element): boolean {
  if (element.localName.toLowerCase() !== 'annotation-xml') return false
  const encoding = element.getAttribute('encoding')?.toLowerCase()
  return encoding === 'text/html' || encoding === 'application/xhtml+xml'
}

function serializeStreamingDocument(
  document: Document,
  container: HTMLElement,
  options: RenderToStringOptions,
): { head: string; tail: string } | null {
  const body = document.body
  if (!body) return null

  const marker = document.createComment('')
  body.appendChild(marker)
  const markerSeed = `fict:stream-tail:${++streamTailMarkerId}`
  let markerText = markerSeed

  try {
    // A structural marker identifies the actual end of body without mistaking
    // matching text inside raw-text elements or comments for a closing tag.
    // If user HTML already contains the marker, doubling the marker guarantees
    // a unique finite marker after logarithmically many retries.
    while (true) {
      marker.data = markerText
      const html = serializeOutput(document, container, options)
      const serializedMarker = `<!--${markerText}-->`
      const idx = html.indexOf(serializedMarker)
      if (idx !== -1 && html.indexOf(serializedMarker, idx + serializedMarker.length) === -1) {
        return {
          head: html.slice(0, idx),
          tail: html.slice(idx + serializedMarker.length),
        }
      }
      markerText += markerText
    }
  } finally {
    marker.parentNode?.removeChild(marker)
  }
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
    const html = document.documentElement
      ? serializeHtmlNode(document.documentElement)
      : serializeHtmlNode(container)
    return doctype ? `${doctype}${html}` : html
  }

  if (options.includeContainer) {
    return serializeHtmlNode(container)
  }

  return serializeHtmlChildren(container)
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
  return serializeHtmlNode(doctype)
}
