import { DelegatedEvents } from './constants'
import {
  FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
  type SSRState,
  __fictEnableResumable,
  __fictEnsureScope,
  __fictGetResume,
  __fictGetSSRScope,
  __fictMergeSSRState,
  __fictSetSSRState,
  __fictUseLexicalScope,
} from './resume'

// ============================================================================
// Module Resolution
// ============================================================================

/**
 * Resolve a module URL through the manifest if available.
 * In production, virtual module URLs (virtual:fict-handler:...) are mapped
 * to their built chunk URLs through the manifest.
 */
function resolveModuleUrl(url: string): string {
  const manifest = (globalThis as Record<string, unknown>).__FICT_MANIFEST__ as
    | Record<string, string>
    | undefined

  if (manifest) {
    // Check if the URL (without #fragment) is in the manifest
    const resolved = manifest[url]
    if (resolved) {
      return resolved
    }
  }

  return url
}

function resolveAbsoluteModuleUrl(url: string, ownerDocument?: Document): string {
  const baseUrl =
    ownerDocument?.baseURI ?? (typeof document !== 'undefined' ? document.baseURI : undefined)
  if (!baseUrl) return url

  try {
    return new URL(url, baseUrl).href
  } catch {
    return url
  }
}

function normalizeImportUrl(url: string): string {
  if (!url.startsWith('data:')) {
    return url
  }

  const dataSeparatorIndex = url.indexOf(',')
  if (dataSeparatorIndex === -1) {
    return url
  }

  const metadata = url.slice(0, dataSeparatorIndex)
  const payload = url.slice(dataSeparatorIndex + 1)
  if (metadata.includes(';base64')) {
    return url
  }

  try {
    return `${metadata},${encodeURIComponent(decodeURIComponent(payload))}`
  } catch {
    return `${metadata},${encodeURIComponent(payload)}`
  }
}

interface PreservedControlState {
  value?: string
  checked?: boolean
  selectedIndex?: number
  selectedValues?: string[]
}

function captureControlState(node: Element, event: Event): PreservedControlState | null {
  if (event.type !== 'input' && event.type !== 'change') return null

  if (node instanceof HTMLInputElement) {
    if (node.type === 'file') return null
    if (node.type === 'checkbox' || node.type === 'radio') {
      return { checked: node.checked }
    }
    return { value: node.value }
  }

  if (node instanceof HTMLTextAreaElement) {
    return { value: node.value }
  }

  if (node instanceof HTMLSelectElement) {
    return node.multiple
      ? {
          selectedValues: Array.from(node.selectedOptions).map(option => option.value),
        }
      : {
          value: node.value,
          selectedIndex: node.selectedIndex,
        }
  }

  return null
}

function restoreControlState(node: Element, state: PreservedControlState | null): void {
  if (!state) return

  if (node instanceof HTMLInputElement) {
    if (typeof state.checked === 'boolean') {
      node.checked = state.checked
    }
    if (typeof state.value === 'string' && node.type !== 'file') {
      node.value = state.value
    }
    return
  }

  if (node instanceof HTMLTextAreaElement) {
    if (typeof state.value === 'string') {
      node.value = state.value
    }
    return
  }

  if (node instanceof HTMLSelectElement) {
    if (Array.isArray(state.selectedValues) && node.multiple) {
      const selected = new Set(state.selectedValues)
      for (const option of Array.from(node.options)) {
        option.selected = selected.has(option.value)
      }
      return
    }

    if (typeof state.selectedIndex === 'number') {
      node.selectedIndex = state.selectedIndex
    }
    if (typeof state.value === 'string') {
      node.value = state.value
    }
  }
}

// ============================================================================
// Types
// ============================================================================

export interface PrefetchStrategy {
  /**
   * Enable visibility-based prefetch using IntersectionObserver.
   * Prefetches modules when interactive elements come into view.
   * @default true
   */
  visibility?: boolean
  /**
   * Root margin for IntersectionObserver (e.g., '200px' to prefetch earlier).
   * @default '200px'
   */
  visibilityMargin?: string
  /**
   * Enable hover-based prefetch using pointerover events.
   * Prefetches modules when user hovers over interactive elements.
   * @default true
   */
  hover?: boolean
  /**
   * Delay in ms before prefetching on hover (debounce rapid movements).
   * @default 50
   */
  hoverDelay?: number
}

export interface ResumableLoaderOptions {
  document?: Document
  snapshotScriptId?: string
  events?: string[]
  /**
   * Explicit snapshot schema migrations keyed by source version.
   * Missing migrations keep the loader fail-closed for unsupported versions.
   */
  snapshotMigrations?: Record<number, SnapshotMigration> | undefined
  /**
   * Receives structured snapshot/resume issues detected by the loader.
   * Useful for telemetry and fail-safe fallback orchestration.
   */
  onSnapshotIssue?: (issue: SnapshotIssue) => void
  /**
   * Prefetch strategy configuration.
   * Set to false to disable all prefetching.
   * @default { visibility: true, hover: true }
   */
  prefetch?: PrefetchStrategy | false
}

export type SnapshotMigration = (
  snapshot: Record<string, unknown>,
  context: SnapshotMigrationContext,
) => unknown

export interface SnapshotMigrationContext {
  fromVersion: number
  toVersion: number
  source: string
}

export type SnapshotIssueCode =
  | 'snapshot_parse_error'
  | 'snapshot_invalid_shape'
  | 'snapshot_unsupported_version'
  | 'snapshot_migration_failed'
  | 'scope_snapshot_missing'
  | 'resume_import_failed'
  | 'resume_function_missing'
  | 'resume_failed'
  | 'handler_import_failed'
  | 'handler_missing'
  | 'handler_failed'

export interface SnapshotIssue {
  code: SnapshotIssueCode
  message: string
  source: string
  expectedVersion: number
  actualVersion?: number | undefined
  scopeId?: string | undefined
  qrl?: string | undefined
  url?: string | undefined
  exportName?: string | undefined
  eventType?: string | undefined
  error?: unknown
}

// ============================================================================
// State
// ============================================================================

const hydratedScopes = new Set<string>()
const prefetchedUrls = new Set<string>()
let prefetchCleanup: (() => void) | null = null
let eventListenerCleanup: (() => void) | null = null
let snapshotObserver: MutationObserver | null = null
const processedSnapshots = new Set<HTMLScriptElement>()
let snapshotIssueHandler: ((issue: SnapshotIssue) => void) | null = null
let snapshotMigrations: Record<number, SnapshotMigration> | null = null
const emittedIssueKeys = new Set<string>()

/**
 * Reset the hydrated scopes set. Useful for testing.
 */
export function resetHydratedScopes(): void {
  hydratedScopes.clear()
}

/**
 * Reset the prefetched URLs set. Useful for testing.
 */
export function resetPrefetchedUrls(): void {
  prefetchedUrls.clear()
}

/**
 * Set of pending handler promises. Used for testing to wait for all handlers to complete.
 */
const pendingHandlers = new Set<Promise<void>>()

/**
 * Wait for all pending event handlers to complete. Useful for testing.
 */
export async function waitForPendingHandlers(): Promise<void> {
  if (pendingHandlers.size === 0) return
  await Promise.allSettled([...pendingHandlers])
}

/**
 * Clean up all registered event listeners. Useful for testing.
 */
export function cleanupEventListeners(): void {
  if (eventListenerCleanup) {
    eventListenerCleanup()
    eventListenerCleanup = null
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

export function installResumableLoader(options: ResumableLoaderOptions = {}): void {
  const doc = options.document ?? window.document
  const scriptId = options.snapshotScriptId ?? '__FICT_SNAPSHOT__'
  snapshotIssueHandler = options.onSnapshotIssue ?? null
  snapshotMigrations = options.snapshotMigrations ?? null

  // Reset hydrated scopes for fresh loader installation
  hydratedScopes.clear()
  prefetchedUrls.clear()
  processedSnapshots.clear()
  emittedIssueKeys.clear()
  __fictSetSSRState(null)

  // Clean up previous event listeners
  if (eventListenerCleanup) {
    eventListenerCleanup()
    eventListenerCleanup = null
  }

  // Clean up previous prefetch handlers
  if (prefetchCleanup) {
    prefetchCleanup()
    prefetchCleanup = null
  }

  if (snapshotObserver) {
    snapshotObserver.disconnect()
    snapshotObserver = null
  }

  const snapshotEl = doc.getElementById(scriptId)
  if (snapshotEl?.textContent) {
    const state = parseSnapshotText(snapshotEl.textContent, `#${scriptId}`)
    if (state) {
      __fictSetSSRState(state)
    }
  }

  const snapshotScripts = doc.querySelectorAll(
    'script[type="application/json"][data-fict-snapshot]',
  )
  for (const script of Array.from(snapshotScripts)) {
    parseSnapshotScript(script as HTMLScriptElement)
  }

  if (typeof MutationObserver !== 'undefined') {
    snapshotObserver = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (!(node instanceof Element)) continue
          if (node.tagName === 'SCRIPT') {
            const script = node as HTMLScriptElement
            if (isSnapshotScript(script)) {
              parseSnapshotScript(script)
            }
          }
          const nested = node.querySelectorAll?.(
            'script[type="application/json"][data-fict-snapshot]',
          )
          if (nested && nested.length) {
            for (const script of Array.from(nested)) {
              parseSnapshotScript(script as HTMLScriptElement)
            }
          }
        }
      }
    })
    snapshotObserver.observe(doc.documentElement ?? doc, { childList: true, subtree: true })
  }

  __fictEnableResumable()

  const events = options.events ?? Array.from(DelegatedEvents)
  for (const eventName of events) {
    doc.addEventListener(eventName, handleResumableEvent, true)
  }

  // Store cleanup function for event listeners
  eventListenerCleanup = () => {
    for (const eventName of events) {
      doc.removeEventListener(eventName, handleResumableEvent, true)
    }
  }

  // Setup prefetch if enabled
  if (options.prefetch !== false) {
    prefetchCleanup = setupPrefetch(doc, options.prefetch ?? {})
  }
}

function isSnapshotScript(script: HTMLScriptElement): boolean {
  return script.type === 'application/json' && script.hasAttribute('data-fict-snapshot')
}

function parseSnapshotScript(script: HTMLScriptElement): void {
  if (processedSnapshots.has(script)) return
  processedSnapshots.add(script)
  const text = script.textContent
  if (!text) return
  const source = script.id ? `#${script.id}` : '<script[data-fict-snapshot]>'
  const state = parseSnapshotText(text, source)
  if (state) {
    __fictMergeSSRState(state)
  }
}

function parseSnapshotText(text: string, source: string): SSRState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    emitSnapshotIssue({
      code: 'snapshot_parse_error',
      message: '[fict/loader] Failed to parse SSR snapshot JSON.',
      source,
      expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
    })
    return null
  }

  return normalizeSnapshotState(parsed, source)
}

function normalizeSnapshotState(value: unknown, source: string): SSRState | null {
  if (!isRecord(value)) {
    emitSnapshotIssue({
      code: 'snapshot_invalid_shape',
      message: '[fict/loader] Snapshot payload must be an object.',
      source,
      expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
    })
    return null
  }

  const rawVersion = value.v
  const version = rawVersion === undefined ? FICT_SSR_SNAPSHOT_SCHEMA_VERSION : rawVersion
  if (!Number.isInteger(version) || version !== FICT_SSR_SNAPSHOT_SCHEMA_VERSION) {
    if (Number.isInteger(version) && typeof version === 'number') {
      const migrated = migrateSnapshotState(value, version, source)
      if (migrated !== undefined) return migrated
    }
    const versionIssue: SnapshotIssue = {
      code: 'snapshot_unsupported_version',
      message: `[fict/loader] Snapshot schema version ${String(version)} is not supported by this runtime.`,
      source,
      expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
    }
    if (typeof version === 'number') {
      versionIssue.actualVersion = version
    }
    emitSnapshotIssue({
      ...versionIssue,
    })
    return null
  }

  const scopes = value.scopes
  if (!isRecord(scopes)) {
    emitSnapshotIssue({
      code: 'snapshot_invalid_shape',
      message: '[fict/loader] Snapshot payload is missing a valid `scopes` object.',
      source,
      expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
    })
    return null
  }

  return { v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION, scopes: scopes as SSRState['scopes'] }
}

function migrateSnapshotState(
  value: Record<string, unknown>,
  version: number,
  source: string,
): SSRState | null | undefined {
  if (!snapshotMigrations) return undefined
  let current: Record<string, unknown> = value
  let currentVersion = version
  const seen = new Set<number>()

  while (currentVersion !== FICT_SSR_SNAPSHOT_SCHEMA_VERSION) {
    if (seen.has(currentVersion)) {
      emitSnapshotMigrationFailed(source, version, currentVersion, 'Migration produced a cycle.')
      return null
    }
    seen.add(currentVersion)

    const migration = snapshotMigrations[currentVersion]
    if (!migration) return undefined

    let migrated: unknown
    try {
      migrated = migration(current, {
        fromVersion: currentVersion,
        toVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        source,
      })
    } catch (error) {
      emitSnapshotMigrationFailed(source, version, currentVersion, formatImportError(error), error)
      return null
    }

    if (!isRecord(migrated)) {
      emitSnapshotMigrationFailed(
        source,
        version,
        currentVersion,
        'Migration must return a snapshot object.',
      )
      return null
    }

    const nextVersionRaw = migrated.v
    const nextVersion =
      nextVersionRaw === undefined ? FICT_SSR_SNAPSHOT_SCHEMA_VERSION : nextVersionRaw
    if (!Number.isInteger(nextVersion) || typeof nextVersion !== 'number') {
      emitSnapshotMigrationFailed(
        source,
        version,
        currentVersion,
        `Migration returned invalid schema version ${String(nextVersion)}.`,
      )
      return null
    }
    if (nextVersion === currentVersion) {
      emitSnapshotMigrationFailed(
        source,
        version,
        currentVersion,
        'Migration did not advance the schema version.',
      )
      return null
    }

    current = migrated
    currentVersion = nextVersion
  }

  return normalizeSnapshotState(current, source)
}

function emitSnapshotMigrationFailed(
  source: string,
  originalVersion: number,
  failedVersion: number,
  reason: string,
  error?: unknown,
): void {
  emitSnapshotIssue({
    code: 'snapshot_migration_failed',
    message: `[fict/loader] Failed to migrate snapshot schema from version ${originalVersion} at step ${failedVersion}: ${reason}`,
    source,
    expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
    actualVersion: originalVersion,
    error,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function emitSnapshotIssue(issue: SnapshotIssue): void {
  const key =
    `${issue.code}|${issue.source}|${issue.scopeId ?? ''}|` +
    `${issue.actualVersion ?? ''}|${issue.expectedVersion}|${issue.qrl ?? ''}|` +
    `${issue.eventType ?? ''}|${issue.exportName ?? ''}`
  if (emittedIssueKeys.has(key)) return
  emittedIssueKeys.add(key)

  snapshotIssueHandler?.(issue)

  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(issue.message)
  }
}

function formatImportError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ============================================================================
// Prefetch Implementation
// ============================================================================

function setupPrefetch(doc: Document, strategy: PrefetchStrategy): () => void {
  const cleanupFns: (() => void)[] = []

  // Visibility-based prefetch
  if (strategy.visibility !== false) {
    const cleanup = setupVisibilityPrefetch(doc, strategy.visibilityMargin ?? '200px')
    cleanupFns.push(cleanup)
  }

  // Hover-based prefetch
  if (strategy.hover !== false) {
    const cleanup = setupHoverPrefetch(doc, strategy.hoverDelay ?? 50)
    cleanupFns.push(cleanup)
  }

  return () => {
    for (const cleanup of cleanupFns) {
      cleanup()
    }
  }
}

function setupVisibilityPrefetch(doc: Document, rootMargin: string): () => void {
  // Check if IntersectionObserver is available
  if (typeof IntersectionObserver === 'undefined') {
    return () => {}
  }

  const observer = new IntersectionObserver(
    entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const el = entry.target as Element
          prefetchElementQrls(el)
          // Stop observing after prefetch
          observer.unobserve(el)
        }
      }
    },
    { rootMargin },
  )

  // Observe all elements with on:* attributes
  const interactiveElements = doc.querySelectorAll(
    '[on\\:click], [on\\:input], [on\\:change], [on\\:submit], [on\\:keydown], [on\\:keyup]',
  )
  interactiveElements.forEach(el => observer.observe(el))

  // Also observe elements with data-fict-h (resumable components)
  const resumableHosts = doc.querySelectorAll('[data-fict-h]')
  resumableHosts.forEach(el => observer.observe(el))

  return () => {
    observer.disconnect()
  }
}

function setupHoverPrefetch(doc: Document, delay: number): () => void {
  let hoverTimeout: ReturnType<typeof setTimeout> | null = null
  let lastHoveredElement: Element | null = null

  const handlePointerOver = (event: Event) => {
    const target = event.target
    if (!(target instanceof Element)) return

    // Find the closest element with interactive attributes
    const interactiveEl =
      target.closest('[on\\:click]') ||
      target.closest('[on\\:input]') ||
      target.closest('[on\\:change]') ||
      target.closest('[on\\:submit]') ||
      target.closest('[data-fict-h]')

    if (!interactiveEl || interactiveEl === lastHoveredElement) return

    lastHoveredElement = interactiveEl

    // Clear previous timeout
    if (hoverTimeout) {
      clearTimeout(hoverTimeout)
    }

    // Debounce prefetch
    hoverTimeout = setTimeout(() => {
      prefetchElementQrls(interactiveEl)
    }, delay)
  }

  const handlePointerOut = () => {
    if (hoverTimeout) {
      clearTimeout(hoverTimeout)
      hoverTimeout = null
    }
    lastHoveredElement = null
  }

  doc.addEventListener('pointerover', handlePointerOver, { passive: true })
  doc.addEventListener('pointerout', handlePointerOut, { passive: true })

  return () => {
    doc.removeEventListener('pointerover', handlePointerOver)
    doc.removeEventListener('pointerout', handlePointerOut)
    if (hoverTimeout) {
      clearTimeout(hoverTimeout)
    }
  }
}

function prefetchElementQrls(el: Element): void {
  const ownerDocument = el.ownerDocument ?? (typeof document !== 'undefined' ? document : undefined)
  // Prefetch event handler QRLs
  const eventAttrs = ['on:click', 'on:input', 'on:change', 'on:submit', 'on:keydown', 'on:keyup']
  for (const attr of eventAttrs) {
    const qrl = el.getAttribute(attr)
    if (qrl) {
      prefetchQrl(qrl, ownerDocument)
    }
  }

  // Prefetch resume handler QRL
  const resumeQrl = el.getAttribute('data-fict-h')
  if (resumeQrl) {
    prefetchQrl(resumeQrl, ownerDocument)
  }

  // Also check children for nested QRLs
  const children = el.querySelectorAll(
    '[on\\:click], [on\\:input], [on\\:change], [on\\:submit], [data-fict-h]',
  )
  children.forEach(child => {
    for (const attr of eventAttrs) {
      const qrl = child.getAttribute(attr)
      if (qrl) {
        prefetchQrl(qrl, ownerDocument)
      }
    }
    const childResumeQrl = child.getAttribute('data-fict-h')
    if (childResumeQrl) {
      prefetchQrl(childResumeQrl, ownerDocument)
    }
  })
}

function prefetchQrl(qrl: string, ownerDocument?: Document): void {
  const { url } = parseQrl(qrl)
  if (!url || prefetchedUrls.has(url)) return

  prefetchedUrls.add(url)

  // Resolve through manifest for production builds
  const resolvedUrl = resolveModuleUrl(url)

  // Use modulepreload link for best browser support
  const doc = ownerDocument ?? (typeof document !== 'undefined' ? document : undefined)
  if (doc) {
    const link = doc.createElement('link')
    link.rel = 'modulepreload'
    link.href = resolvedUrl
    link.crossOrigin = 'anonymous'
    doc.head?.appendChild(link)
  }
}

// ============================================================================

/**
 * Wrapper that tracks the async handler promise for testing.
 */
function handleResumableEvent(event: Event): void {
  const promise = handleResumableEventAsync(event)
  pendingHandlers.add(promise)
  void promise
    .catch(error => {
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error('[fict/loader] Failed to handle resumable event.', error)
      }
    })
    .finally(() => {
      pendingHandlers.delete(promise)
    })
}

async function handleResumableEventAsync(event: Event): Promise<void> {
  const path =
    typeof event.composedPath === 'function' ? event.composedPath() : buildEventPath(event)

  for (const node of path) {
    if (!(node instanceof Element)) continue
    const qrl = node.getAttribute(`on:${event.type}`)
    if (!qrl) continue

    const host = node.closest('[data-fict-s]') as Element | null
    if (!host) continue
    const scopeId = host.getAttribute('data-fict-s')
    if (!scopeId) continue

    const snapshot = __fictGetSSRScope(scopeId)
    if (!snapshot) {
      emitSnapshotIssue({
        code: 'scope_snapshot_missing',
        message: `[fict/loader] Missing scope snapshot for ${scopeId}; skipping resumable handler execution.`,
        source: 'event',
        expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopeId,
      })
      continue
    }
    __fictEnsureScope(scopeId, host, snapshot)

    const { url, exportName } = parseQrl(qrl)

    // Pre-emptively prevent default on navigations/forms while we await modules
    if (event.cancelable && (event.type === 'click' || event.type === 'submit')) {
      const tag = node.tagName.toLowerCase()
      if (tag === 'a' || tag === 'form') {
        event.preventDefault()
      }
    }

    const preservedControlState = captureControlState(node, event)
    let resumedDuringEvent = false

    // Resume FIRST to set up reactive bindings BEFORE the handler runs
    if (!hydratedScopes.has(scopeId)) {
      const resumeQrl = host.getAttribute('data-fict-h')
      if (resumeQrl) {
        const { url: resumeUrl, exportName: resumeExport } = parseQrl(resumeQrl)
        const resolvedResumeUrl = resolveModuleUrl(resumeUrl)
        const resolvedAbsoluteResumeUrl = resolveAbsoluteModuleUrl(
          resolvedResumeUrl,
          host.ownerDocument ?? undefined,
        )
        const resolvedResumeQrl = `${resolvedResumeUrl}#${resumeExport}`
        const resolvedAbsoluteResumeQrl = `${resolvedAbsoluteResumeUrl}#${resumeExport}`
        const normalizedResumeImportUrl = normalizeImportUrl(resolvedResumeUrl)
        // Load the module to ensure resume functions are registered
        try {
          await import(/* @vite-ignore */ normalizedResumeImportUrl)
        } catch (error) {
          emitSnapshotIssue({
            code: 'resume_import_failed',
            message: `[fict/loader] Failed to import resume module ${resolvedResumeUrl}: ${formatImportError(error)}`,
            source: 'event',
            expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
            scopeId,
            qrl: resumeQrl,
            url: resolvedResumeUrl,
            exportName: resumeExport,
            eventType: event.type,
            error,
          })
          return
        }
        // Get resume function from registry (not module exports)
        const resumeFn =
          __fictGetResume(resumeQrl) ??
          __fictGetResume(resolvedResumeQrl) ??
          __fictGetResume(resolvedAbsoluteResumeQrl) ??
          __fictGetResume(resumeExport)
        if (typeof resumeFn === 'function') {
          try {
            await (resumeFn as (scopeId: string, host: Element) => unknown)(scopeId, host)
          } catch (error) {
            emitSnapshotIssue({
              code: 'resume_failed',
              message: `[fict/loader] Resume function ${resumeExport} failed for scope ${scopeId}: ${formatImportError(error)}`,
              source: 'event',
              expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
              scopeId,
              qrl: resumeQrl,
              url: resolvedResumeUrl,
              exportName: resumeExport,
              eventType: event.type,
              error,
            })
            return
          }
          hydratedScopes.add(scopeId)
          resumedDuringEvent = true
        } else {
          emitSnapshotIssue({
            code: 'resume_function_missing',
            message: `[fict/loader] Resume function ${resumeExport} was not registered for scope ${scopeId}.`,
            source: 'event',
            expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
            scopeId,
            qrl: resumeQrl,
            url: resolvedResumeUrl,
            exportName: resumeExport,
            eventType: event.type,
          })
        }
      }
    }

    if (resumedDuringEvent) {
      restoreControlState(node, preservedControlState)
    }

    // THEN run the handler - now signal updates will trigger DOM updates
    const resolvedUrl = resolveModuleUrl(url)
    const normalizedImportUrl = normalizeImportUrl(resolvedUrl)
    let mod: Record<string, unknown>
    try {
      mod = (await import(/* @vite-ignore */ normalizedImportUrl)) as Record<string, unknown>
    } catch (error) {
      emitSnapshotIssue({
        code: 'handler_import_failed',
        message: `[fict/loader] Failed to import handler module ${resolvedUrl}: ${formatImportError(error)}`,
        source: 'event',
        expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopeId,
        qrl,
        url: resolvedUrl,
        exportName,
        eventType: event.type,
        error,
      })
      return
    }
    const handler = (mod as Record<string, unknown>)[exportName]
    if (typeof handler === 'function') {
      const originalCurrentTarget = event.currentTarget
      Object.defineProperty(event, 'currentTarget', {
        configurable: true,
        get() {
          return node
        },
      })
      try {
        await (handler as (scopeId: string, ev: Event, el: Element) => unknown)(
          scopeId,
          event,
          node,
        )
      } catch (error) {
        emitSnapshotIssue({
          code: 'handler_failed',
          message: `[fict/loader] Resumable handler ${exportName} failed for scope ${scopeId}: ${formatImportError(error)}`,
          source: 'event',
          expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
          scopeId,
          qrl,
          url: resolvedUrl,
          exportName,
          eventType: event.type,
          error,
        })
      } finally {
        Object.defineProperty(event, 'currentTarget', {
          configurable: true,
          get() {
            return originalCurrentTarget
          },
        })
      }
    } else {
      emitSnapshotIssue({
        code: 'handler_missing',
        message: `[fict/loader] Resumable handler export ${exportName} was not found in ${resolvedUrl}.`,
        source: 'event',
        expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopeId,
        qrl,
        url: resolvedUrl,
        exportName,
        eventType: event.type,
      })
    }

    return
  }
}

function parseQrl(qrl: string): { url: string; exportName: string } {
  const [ref] = qrl.split('[')
  if (!ref) {
    return { url: '', exportName: 'default' }
  }
  const hashIndex = ref.lastIndexOf('#')
  if (hashIndex === -1) {
    return { url: ref, exportName: 'default' }
  }
  return { url: ref.slice(0, hashIndex), exportName: ref.slice(hashIndex + 1) }
}

function buildEventPath(event: Event): EventTarget[] {
  const path: EventTarget[] = []
  let node: EventTarget | null = event.target
  while (node) {
    path.push(node)
    node = (node as Node).parentNode
  }
  path.push(window)
  return path
}

// Re-export for handler authors (optional)
export { __fictUseLexicalScope } from './resume'
