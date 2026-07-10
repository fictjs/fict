import { DelegatedEvents } from './constants'
import { isElementLike } from './dom-guards'
import {
  FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
  type SSRState,
  __fictDeleteResumedScopes,
  __fictDisableResumable,
  __fictEnableResumable,
  __fictEnsureScope,
  __fictGetResume,
  __fictSetSSRState,
  __fictUseLexicalScope,
  serializeValue,
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

function getControlTagName(node: Element): string {
  return (node.localName || node.tagName || '').toLowerCase()
}

function captureControlState(node: Element, event: Event): PreservedControlState | null {
  if (event.type !== 'input' && event.type !== 'change') return null

  const tagName = getControlTagName(node)

  if (tagName === 'input') {
    const input = node as HTMLInputElement
    if (input.type === 'file') return null
    if (input.type === 'checkbox' || input.type === 'radio') {
      return { checked: input.checked }
    }
    return { value: input.value }
  }

  if (tagName === 'textarea') {
    return { value: (node as HTMLTextAreaElement).value }
  }

  if (tagName === 'select') {
    const select = node as HTMLSelectElement
    return select.multiple
      ? {
          selectedValues: Array.from(select.options)
            .filter(option => option.selected)
            .map(option => option.value),
        }
      : {
          value: select.value,
          selectedIndex: select.selectedIndex,
        }
  }

  return null
}

function restoreControlState(node: Element, state: PreservedControlState | null): void {
  if (!state) return

  const tagName = getControlTagName(node)

  if (tagName === 'input') {
    const input = node as HTMLInputElement
    if (typeof state.checked === 'boolean') {
      input.checked = state.checked
    }
    if (typeof state.value === 'string' && input.type !== 'file') {
      input.value = state.value
    }
    return
  }

  if (tagName === 'textarea') {
    if (typeof state.value === 'string') {
      ;(node as HTMLTextAreaElement).value = state.value
    }
    return
  }

  if (tagName === 'select') {
    const select = node as HTMLSelectElement
    if (Array.isArray(state.selectedValues) && select.multiple) {
      const selected = new Set(state.selectedValues)
      for (const option of Array.from(select.options)) {
        option.selected = selected.has(option.value)
      }
      return
    }

    if (typeof state.selectedIndex === 'number') {
      select.selectedIndex = state.selectedIndex
    }
    if (typeof state.value === 'string') {
      select.value = state.value
    }
  }
}

interface PreemptiveDefaultControl {
  replayIfNeeded(): void
  restore(): void
}

const noopPreemptiveDefaultControl: PreemptiveDefaultControl = {
  replayIfNeeded() {},
  restore() {},
}

interface PreemptiveDefaultOptions {
  mayPreventDefault?: boolean
}

function isSubmitButton(node: Element): boolean {
  const tag = getControlTagName(node)
  if (tag === 'button') {
    const type = (node as HTMLButtonElement).type || 'submit'
    return type === 'submit'
  }
  if (tag !== 'input') return false
  const type = ((node as HTMLInputElement).type || 'text').toLowerCase()
  return type === 'submit' || type === 'image'
}

function hasPreemptiveDefaultOwner(node: Element, event: Event): boolean {
  if (event.type === 'submit') {
    return !!node.closest('form')
  }
  if (event.type !== 'click') {
    return false
  }
  if (node.closest('a[href], area[href]')) {
    return true
  }
  const submitControl = node.closest('button, input')
  return !!submitControl && isSubmitButton(submitControl)
}

function preemptivelyPreventDefault(
  node: Element,
  event: Event,
  options: PreemptiveDefaultOptions = {},
): PreemptiveDefaultControl {
  if (!event.cancelable || (event.type !== 'click' && event.type !== 'submit')) {
    return noopPreemptiveDefaultControl
  }

  if (options.mayPreventDefault && hasPreemptiveDefaultOwner(node, event)) {
    event.preventDefault()
    return noopPreemptiveDefaultControl
  }

  const tag = getControlTagName(node)
  if (event.type !== 'click' || tag !== 'input') {
    return noopPreemptiveDefaultControl
  }

  const input = node as HTMLInputElement
  if (input.type !== 'checkbox' && input.type !== 'radio') {
    return noopPreemptiveDefaultControl
  }

  const checkedAfterDefault = input.checked
  const originalPreventDefault = event.preventDefault.bind(event)
  const ownPreventDefault = Object.getOwnPropertyDescriptor(event, 'preventDefault')
  let userPreventedDefault = false

  Object.defineProperty(event, 'preventDefault', {
    configurable: true,
    value() {
      userPreventedDefault = true
      originalPreventDefault()
    },
  })
  originalPreventDefault()

  return {
    replayIfNeeded() {
      if (!userPreventedDefault) {
        input.checked = checkedAfterDefault
      }
    },
    restore() {
      if (ownPreventDefault) {
        Object.defineProperty(event, 'preventDefault', ownPreventDefault)
      } else {
        delete (event as { preventDefault?: Event['preventDefault'] }).preventDefault
      }
    },
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
   * Called once after a rejected snapshot has made resumability unsafe.
   * The loader first removes its listeners and clears the affected resumable
   * state; applications should mount their client-rendered root here.
   */
  onSnapshotRejected?: (issue: SnapshotIssue) => void | Promise<void>
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

/**
 * Sentinel key for opting an unversioned pre-v1 snapshot into migration.
 * Unversioned payloads are rejected unless this migration is provided.
 */
export const UNVERSIONED_SNAPSHOT_MIGRATION_KEY = 0

/**
 * Historical v1 snapshots used two incompatible props encodings. Applications
 * must select the format that matches the cached/deployed writer; the loader
 * cannot infer it from the payload bytes.
 */
export type LegacySnapshotFormat = 'raw-props' | 'encoded-props'

/**
 * Create an explicit migration for a known legacy snapshot writer.
 *
 * `raw-props` covers unversioned and v1 writers through v0.21, where props
 * were handed directly to JSON.stringify. `encoded-props` covers the later v1
 * contract where props already use Fict serialization markers. This helper
 * deliberately does not attempt heuristic format detection.
 */
export function createLegacySnapshotMigration(format: LegacySnapshotFormat): SnapshotMigration {
  if (format !== 'raw-props' && format !== 'encoded-props') {
    throw new Error(`[fict/loader] Unknown legacy snapshot format: ${String(format)}.`)
  }

  return (snapshot, context) => {
    const migrated = copyRecord(snapshot)
    migrated.v = context.toVersion
    if (format === 'raw-props') {
      migrated.scopes = migrateRawLegacyProps(snapshot.scopes)
    }
    return migrated
  }
}

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
  | 'snapshot_fallback_failed'
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

interface LoaderInstallation {
  id: number
  active: boolean
  cancelWaiters: Set<() => void>
  document: Document
  state: SSRState
  scopeIds: Map<string, string>
  hydratedScopes: Set<string>
  pendingScopeResumes: Map<string, Promise<boolean>>
  pendingScopeHandlers: Map<string, Promise<void>>
  prefetchedUrls: Set<string>
  processedSnapshots: Set<HTMLScriptElement>
  emittedIssueKeys: Set<string>
  snapshotIssueHandler: ((issue: SnapshotIssue) => void) | null
  snapshotRejectedHandler: ((issue: SnapshotIssue) => void | Promise<void>) | null
  snapshotRejection: SnapshotIssue | null
  snapshotFallbackStarted: boolean
  initialized: boolean
  snapshotMigrations: Record<number, SnapshotMigration> | null
  eventListenerCleanup: (() => void) | null
  prefetchCleanup: (() => void) | null
  snapshotObserver: MutationObserver | null
}

const loaderInstallations = new Map<Document, LoaderInstallation>()
let nextLoaderInstallationId = 0
const INACTIVE_INSTALLATION = Symbol('inactive loader installation')

function isLoaderInstallationActive(installation: LoaderInstallation): boolean {
  return (
    installation.active &&
    !installation.snapshotFallbackStarted &&
    loaderInstallations.get(installation.document) === installation
  )
}

async function waitForActiveInstallation<T>(
  installation: LoaderInstallation,
  value: T | PromiseLike<T>,
): Promise<Awaited<T> | typeof INACTIVE_INSTALLATION> {
  if (!isLoaderInstallationActive(installation)) return INACTIVE_INSTALLATION

  return new Promise<Awaited<T> | typeof INACTIVE_INSTALLATION>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      installation.cancelWaiters.delete(cancel)
      callback()
    }
    const cancel = () => finish(() => resolve(INACTIVE_INSTALLATION))

    installation.cancelWaiters.add(cancel)
    void Promise.resolve(value).then(
      resolved =>
        finish(() =>
          resolve(isLoaderInstallationActive(installation) ? resolved : INACTIVE_INSTALLATION),
        ),
      error => finish(() => reject(error)),
    )

    if (!isLoaderInstallationActive(installation)) cancel()
  })
}

/**
 * Reset the hydrated scopes set. Useful for testing.
 */
export function resetHydratedScopes(): void {
  for (const installation of loaderInstallations.values()) {
    installation.hydratedScopes.clear()
    installation.pendingScopeResumes.clear()
    installation.pendingScopeHandlers.clear()
  }
}

/**
 * Reset the prefetched URLs set. Useful for testing.
 */
export function resetPrefetchedUrls(): void {
  for (const installation of loaderInstallations.values()) {
    installation.prefetchedUrls.clear()
  }
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

/** Return active cancellation waiters for leak regression tests. */
export function getPendingLoaderWaiterCountForTests(): number {
  let count = 0
  for (const installation of loaderInstallations.values()) {
    count += installation.cancelWaiters.size
  }
  return count
}

/**
 * Clean up all registered event listeners. Useful for testing.
 */
export function cleanupEventListeners(): void {
  for (const installation of loaderInstallations.values()) {
    cleanupLoaderInstallation(installation, false)
  }
  loaderInstallations.clear()
  __fictSetSSRState(null)
  __fictDisableResumable()
}

// ============================================================================
// Main Entry Point
// ============================================================================

export function installResumableLoader(options: ResumableLoaderOptions = {}): void {
  const doc = resolveLoaderDocument(options.document)
  const scriptId = options.snapshotScriptId ?? '__FICT_SNAPSHOT__'
  const previousInstallation = loaderInstallations.get(doc)
  if (previousInstallation) {
    cleanupLoaderInstallation(previousInstallation)
  }

  const installation: LoaderInstallation = {
    id: ++nextLoaderInstallationId,
    active: true,
    cancelWaiters: new Set(),
    document: doc,
    state: { v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION, scopes: {} },
    scopeIds: new Map(),
    hydratedScopes: new Set(),
    pendingScopeResumes: new Map(),
    pendingScopeHandlers: new Map(),
    prefetchedUrls: new Set(),
    processedSnapshots: new Set(),
    emittedIssueKeys: new Set(),
    snapshotIssueHandler: options.onSnapshotIssue ?? null,
    snapshotRejectedHandler: options.onSnapshotRejected ?? null,
    snapshotRejection: null,
    snapshotFallbackStarted: false,
    initialized: false,
    snapshotMigrations: options.snapshotMigrations ?? null,
    eventListenerCleanup: null,
    prefetchCleanup: null,
    snapshotObserver: null,
  }
  loaderInstallations.set(doc, installation)

  const snapshotEl = doc.getElementById(scriptId)
  if (snapshotEl?.textContent) {
    const state = parseSnapshotText(installation, snapshotEl.textContent, `#${scriptId}`)
    if (state) {
      applySnapshotState(installation, state, `#${scriptId}`, 'replace')
    }
  }

  const snapshotScripts = doc.querySelectorAll(
    'script[type="application/json"][data-fict-snapshot]',
  )
  for (const script of Array.from(snapshotScripts)) {
    parseSnapshotScript(installation, script as HTMLScriptElement)
    if (installation.snapshotRejection) break
  }

  if (installation.snapshotRejection) {
    activateSnapshotFallback(installation)
    return
  }

  const SnapshotObserver = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver
  if (typeof SnapshotObserver !== 'undefined') {
    installation.snapshotObserver = new SnapshotObserver(mutations => {
      if (!isLoaderInstallationActive(installation)) return
      for (const mutation of mutations) {
        if (isSnapshotScriptElement(mutation.target, doc)) {
          parseSnapshotScript(installation, mutation.target)
        }
        for (const node of Array.from(mutation.addedNodes)) {
          if (!isElementLike(node, doc)) {
            const parent = node.parentElement
            if (parent && isSnapshotScriptElement(parent, doc)) {
              parseSnapshotScript(installation, parent)
            }
            continue
          }
          if (node.tagName === 'SCRIPT') {
            const script = node as HTMLScriptElement
            if (isSnapshotScript(script)) {
              parseSnapshotScript(installation, script)
            }
          }
          const nested = node.querySelectorAll?.(
            'script[type="application/json"][data-fict-snapshot]',
          )
          if (nested && nested.length) {
            for (const script of Array.from(nested)) {
              parseSnapshotScript(installation, script as HTMLScriptElement)
            }
          }
        }
      }
    })
    installation.snapshotObserver.observe(doc.documentElement ?? doc, {
      childList: true,
      subtree: true,
    })
  }

  __fictEnableResumable()

  const events = options.events ?? Array.from(DelegatedEvents)
  const eventListener = (event: Event) => handleResumableEvent(installation, event)
  for (const eventName of events) {
    doc.addEventListener(eventName, eventListener, true)
  }

  // Store cleanup function for event listeners
  installation.eventListenerCleanup = () => {
    for (const eventName of events) {
      doc.removeEventListener(eventName, eventListener, true)
    }
  }

  // Setup prefetch if enabled
  if (options.prefetch !== false) {
    installation.prefetchCleanup = setupPrefetch(installation, options.prefetch ?? {})
  }
  installation.initialized = true
}

function cleanupLoaderInstallation(
  installation: LoaderInstallation,
  synchronizeState = true,
): void {
  installation.active = false
  for (const cancel of Array.from(installation.cancelWaiters)) cancel()
  installation.cancelWaiters.clear()
  installation.eventListenerCleanup?.()
  installation.prefetchCleanup?.()
  installation.snapshotObserver?.disconnect()
  installation.eventListenerCleanup = null
  installation.prefetchCleanup = null
  installation.snapshotObserver = null
  installation.initialized = false
  installation.pendingScopeResumes.clear()
  installation.pendingScopeHandlers.clear()
  installation.hydratedScopes.clear()
  __fictDeleteResumedScopes(Object.keys(installation.state.scopes))
  loaderInstallations.delete(installation.document)
  if (synchronizeState) {
    synchronizeSnapshotState()
  }
  if (loaderInstallations.size === 0) {
    __fictDisableResumable()
  }
}

function resolveLoaderDocument(doc: Document | undefined): Document {
  if (doc) return doc
  if (typeof window === 'undefined' || !window.document) {
    throw new Error('[fict/loader] installResumableLoader requires a browser document.')
  }
  return window.document
}

function isSnapshotScript(script: HTMLScriptElement): boolean {
  return script.type === 'application/json' && script.hasAttribute('data-fict-snapshot')
}

function isSnapshotScriptElement(node: Node, doc: Document): node is HTMLScriptElement {
  return (
    isElementLike(node, doc) &&
    node.tagName === 'SCRIPT' &&
    isSnapshotScript(node as HTMLScriptElement)
  )
}

function parseSnapshotScript(installation: LoaderInstallation, script: HTMLScriptElement): void {
  if (installation.processedSnapshots.has(script)) return
  const text = script.textContent
  if (!text) return
  const source = script.id ? `#${script.id}` : '<script[data-fict-snapshot]>'
  const state = parseSnapshotText(installation, text, source)
  if (state && applySnapshotState(installation, state, source, 'merge')) {
    installation.processedSnapshots.add(script)
  }
}

function applySnapshotState(
  installation: LoaderInstallation,
  state: SSRState,
  source: string,
  mode: 'replace' | 'merge',
): boolean {
  const nextScopeIds = new Map(installation.scopeIds)
  const nextScopes: SSRState['scopes'] = Object.assign(
    Object.create(null) as SSRState['scopes'],
    mode === 'replace' ? undefined : installation.state.scopes,
  )
  const occupiedScopeIds = collectOccupiedScopeIds(installation)

  for (const [sourceScopeId, snapshot] of Object.entries(state.scopes)) {
    let scopeId = nextScopeIds.get(sourceScopeId)
    if (!scopeId) {
      scopeId = allocateScopeId(installation, sourceScopeId, occupiedScopeIds)
      nextScopeIds.set(sourceScopeId, scopeId)
      occupiedScopeIds.add(scopeId)
    }
    nextScopes[scopeId] = { ...snapshot, id: scopeId }
  }

  const nextState: SSRState = {
    v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
    scopes: nextScopes,
  }
  try {
    synchronizeSnapshotState(installation, nextState)
    installation.state = nextState
    installation.scopeIds = nextScopeIds
    return true
  } catch (error) {
    emitSnapshotIssue(installation, {
      code: 'snapshot_invalid_shape',
      message: `[fict/loader] Snapshot payload contains invalid scope data: ${formatImportError(error)}`,
      source,
      expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
      error,
    })
    return false
  }
}

function collectOccupiedScopeIds(excluded: LoaderInstallation): Set<string> {
  const occupied = new Set<string>()
  for (const installation of loaderInstallations.values()) {
    if (installation === excluded) continue
    for (const scopeId of Object.keys(installation.state.scopes)) {
      occupied.add(scopeId)
    }
  }
  return occupied
}

function allocateScopeId(
  installation: LoaderInstallation,
  sourceScopeId: string,
  occupied: Set<string>,
): string {
  if (!occupied.has(sourceScopeId)) return sourceScopeId
  const prefix = `__fict_d${installation.id}_`
  let candidate = `${prefix}${sourceScopeId}`
  let suffix = 1
  while (occupied.has(candidate)) {
    candidate = `${prefix}${suffix++}_${sourceScopeId}`
  }
  return candidate
}

function synchronizeSnapshotState(
  replacement?: LoaderInstallation,
  replacementState?: SSRState,
): void {
  const scopes = Object.create(null) as SSRState['scopes']
  for (const installation of loaderInstallations.values()) {
    const state = installation === replacement ? replacementState : installation.state
    if (state) {
      Object.assign(scopes, state.scopes)
    }
  }
  __fictSetSSRState(
    loaderInstallations.size === 0 ? null : { v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION, scopes },
  )
}

function parseSnapshotText(
  installation: LoaderInstallation,
  text: string,
  source: string,
): SSRState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    emitSnapshotIssue(installation, {
      code: 'snapshot_parse_error',
      message: '[fict/loader] Failed to parse SSR snapshot JSON.',
      source,
      expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
    })
    return null
  }

  return normalizeSnapshotState(installation, parsed, source)
}

function normalizeSnapshotState(
  installation: LoaderInstallation,
  value: unknown,
  source: string,
): SSRState | null {
  if (!isRecord(value)) {
    emitSnapshotIssue(installation, {
      code: 'snapshot_invalid_shape',
      message: '[fict/loader] Snapshot payload must be an object.',
      source,
      expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
    })
    return null
  }

  const version = value.v
  if (version === undefined) {
    const migrated = migrateSnapshotState(
      installation,
      value,
      UNVERSIONED_SNAPSHOT_MIGRATION_KEY,
      source,
    )
    if (migrated !== undefined) return migrated
  }
  if (!Number.isInteger(version) || version !== FICT_SSR_SNAPSHOT_SCHEMA_VERSION) {
    if (Number.isInteger(version) && typeof version === 'number') {
      const migrated = migrateSnapshotState(installation, value, version, source)
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
    emitSnapshotIssue(installation, {
      ...versionIssue,
    })
    return null
  }

  const scopes = value.scopes
  if (!isRecord(scopes)) {
    emitSnapshotIssue(installation, {
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
  installation: LoaderInstallation,
  value: Record<string, unknown>,
  version: number,
  source: string,
): SSRState | null | undefined {
  if (!installation.snapshotMigrations) return undefined
  let current: Record<string, unknown> = value
  let currentVersion = version
  const seen = new Set<number>()

  while (currentVersion !== FICT_SSR_SNAPSHOT_SCHEMA_VERSION) {
    if (seen.has(currentVersion)) {
      emitSnapshotMigrationFailed(
        installation,
        source,
        version,
        currentVersion,
        'Migration produced a cycle.',
      )
      return null
    }
    seen.add(currentVersion)

    const migration = installation.snapshotMigrations[currentVersion]
    if (!migration) return undefined

    let migrated: unknown
    try {
      migrated = migration(current, {
        fromVersion: currentVersion,
        toVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        source,
      })
    } catch (error) {
      emitSnapshotMigrationFailed(
        installation,
        source,
        version,
        currentVersion,
        formatImportError(error),
        error,
      )
      return null
    }

    if (!isRecord(migrated)) {
      emitSnapshotMigrationFailed(
        installation,
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
        installation,
        source,
        version,
        currentVersion,
        `Migration returned invalid schema version ${String(nextVersion)}.`,
      )
      return null
    }
    if (nextVersion === currentVersion) {
      emitSnapshotMigrationFailed(
        installation,
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

  return normalizeSnapshotState(installation, current, source)
}

function emitSnapshotMigrationFailed(
  installation: LoaderInstallation,
  source: string,
  originalVersion: number,
  failedVersion: number,
  reason: string,
  error?: unknown,
): void {
  emitSnapshotIssue(installation, {
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

function copyRecord(value: Record<string, unknown>): Record<string, unknown> {
  const copy = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value)) {
    copy[key] = value[key]
  }
  return copy
}

function migrateRawLegacyProps(scopes: unknown): unknown {
  if (!isRecord(scopes)) return scopes

  const migratedScopes = Object.create(null) as Record<string, unknown>
  for (const [scopeId, value] of Object.entries(scopes)) {
    if (!isRecord(value)) {
      migratedScopes[scopeId] = value
      continue
    }

    const scope = copyRecord(value)
    if (Object.prototype.hasOwnProperty.call(scope, 'props')) {
      scope.props = serializeValue(scope.props, new Map<object, string>(), '$.props')
    }
    migratedScopes[scopeId] = scope
  }
  return migratedScopes
}

function emitSnapshotIssue(installation: LoaderInstallation, issue: SnapshotIssue): void {
  if (!isLoaderInstallationActive(installation)) return
  const key =
    `${issue.code}|${issue.source}|${issue.scopeId ?? ''}|` +
    `${issue.actualVersion ?? ''}|${issue.expectedVersion}|${issue.qrl ?? ''}|` +
    `${issue.eventType ?? ''}|${issue.exportName ?? ''}`
  if (installation.emittedIssueKeys.has(key)) return
  installation.emittedIssueKeys.add(key)

  notifySnapshotIssueHandler(installation, issue)

  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(issue.message)
  }

  if (isSnapshotRejection(installation, issue) && installation.snapshotRejection === null) {
    installation.snapshotRejection = issue
    if (installation.initialized) {
      activateSnapshotFallback(installation)
    }
  }
}

function notifySnapshotIssueHandler(installation: LoaderInstallation, issue: SnapshotIssue): void {
  try {
    installation.snapshotIssueHandler?.(issue)
  } catch (error) {
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error('[fict/loader] onSnapshotIssue callback failed.', error)
    }
  }
}

function isSnapshotRejection(installation: LoaderInstallation, issue: SnapshotIssue): boolean {
  if (installation.snapshotRejectedHandler === null) return false
  return (
    issue.code === 'snapshot_parse_error' ||
    issue.code === 'snapshot_invalid_shape' ||
    issue.code === 'snapshot_unsupported_version' ||
    issue.code === 'snapshot_migration_failed' ||
    issue.code === 'scope_snapshot_missing'
  )
}

function activateSnapshotFallback(installation: LoaderInstallation): void {
  if (installation.snapshotFallbackStarted) return
  const issue = installation.snapshotRejection
  if (!issue) return

  installation.snapshotFallbackStarted = true
  const fallback = installation.snapshotRejectedHandler
  cleanupLoaderInstallation(installation)
  if (!fallback) return

  let result: void | Promise<void>
  try {
    result = fallback(issue)
  } catch (error) {
    reportSnapshotFallbackFailure(installation, issue, error)
    return
  }

  if (!isPromiseLikeValue(result)) return
  const pending = Promise.resolve(result)
    .catch(error => reportSnapshotFallbackFailure(installation, issue, error))
    .then(() => undefined)
  pendingHandlers.add(pending)
  void pending.finally(() => pendingHandlers.delete(pending))
}

function isPromiseLikeValue(value: unknown): value is PromiseLike<void> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<void>).then === 'function'
  )
}

function reportSnapshotFallbackFailure(
  installation: LoaderInstallation,
  rejectedIssue: SnapshotIssue,
  error: unknown,
): void {
  const issue: SnapshotIssue = {
    code: 'snapshot_fallback_failed',
    message: `[fict/loader] Client-render fallback failed: ${formatImportError(error)}`,
    source: rejectedIssue.source,
    expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
    error,
  }
  notifySnapshotIssueHandler(installation, issue)
  if (typeof console !== 'undefined' && typeof console.error === 'function') {
    console.error(issue.message)
  }
}

function formatImportError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ============================================================================
// Prefetch Implementation
// ============================================================================

function setupPrefetch(installation: LoaderInstallation, strategy: PrefetchStrategy): () => void {
  const cleanupFns: (() => void)[] = []

  // Visibility-based prefetch
  if (strategy.visibility !== false) {
    const cleanup = setupVisibilityPrefetch(installation, strategy.visibilityMargin ?? '200px')
    cleanupFns.push(cleanup)
  }

  // Hover-based prefetch
  if (strategy.hover !== false) {
    const cleanup = setupHoverPrefetch(installation, strategy.hoverDelay ?? 50)
    cleanupFns.push(cleanup)
  }

  return () => {
    for (const cleanup of cleanupFns) {
      cleanup()
    }
  }
}

function setupVisibilityPrefetch(installation: LoaderInstallation, rootMargin: string): () => void {
  const doc = installation.document
  // Check if IntersectionObserver is available
  if (typeof IntersectionObserver === 'undefined') {
    return () => {}
  }

  const observer = new IntersectionObserver(
    entries => {
      if (!isLoaderInstallationActive(installation)) return
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const el = entry.target as Element
          prefetchElementQrls(installation, el)
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

function setupHoverPrefetch(installation: LoaderInstallation, delay: number): () => void {
  const doc = installation.document
  let hoverTimeout: ReturnType<typeof setTimeout> | null = null
  let lastHoveredElement: Element | null = null

  const handlePointerOver = (event: Event) => {
    const target = event.target
    if (!isElementLike(target, doc)) return

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
      if (!isLoaderInstallationActive(installation)) return
      prefetchElementQrls(installation, interactiveEl)
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

function prefetchElementQrls(installation: LoaderInstallation, el: Element): void {
  if (!isLoaderInstallationActive(installation)) return
  const ownerDocument = el.ownerDocument ?? (typeof document !== 'undefined' ? document : undefined)
  // Prefetch event handler QRLs
  const eventAttrs = ['on:click', 'on:input', 'on:change', 'on:submit', 'on:keydown', 'on:keyup']
  for (const attr of eventAttrs) {
    const qrl = el.getAttribute(attr)
    if (qrl) {
      prefetchQrl(installation, qrl, ownerDocument)
    }
  }

  // Prefetch resume handler QRL
  const resumeQrl = el.getAttribute('data-fict-h')
  if (resumeQrl) {
    prefetchQrl(installation, resumeQrl, ownerDocument)
  }

  // Also check children for nested QRLs
  const children = el.querySelectorAll(
    '[on\\:click], [on\\:input], [on\\:change], [on\\:submit], [data-fict-h]',
  )
  children.forEach(child => {
    for (const attr of eventAttrs) {
      const qrl = child.getAttribute(attr)
      if (qrl) {
        prefetchQrl(installation, qrl, ownerDocument)
      }
    }
    const childResumeQrl = child.getAttribute('data-fict-h')
    if (childResumeQrl) {
      prefetchQrl(installation, childResumeQrl, ownerDocument)
    }
  })
}

function prefetchQrl(
  installation: LoaderInstallation,
  qrl: string,
  ownerDocument?: Document,
): void {
  if (!isLoaderInstallationActive(installation)) return
  const { url } = parseQrl(qrl)
  if (!url || installation.prefetchedUrls.has(url)) return

  installation.prefetchedUrls.add(url)

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
function handleResumableEvent(installation: LoaderInstallation, event: Event): void {
  if (!isLoaderInstallationActive(installation)) return
  const promise = handleResumableEventAsync(installation, event)
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

async function resumeScopeForEvent(
  installation: LoaderInstallation,
  scopeId: string,
  host: Element,
  event: Event,
): Promise<{ canRunHandler: boolean; hydratedDuringEvent: boolean }> {
  if (!isLoaderInstallationActive(installation)) {
    return { canRunHandler: false, hydratedDuringEvent: false }
  }
  if (installation.hydratedScopes.has(scopeId)) {
    return { canRunHandler: true, hydratedDuringEvent: false }
  }

  const resumeQrl = host.getAttribute('data-fict-h')
  if (!resumeQrl) {
    return { canRunHandler: true, hydratedDuringEvent: false }
  }

  let resumePromise = installation.pendingScopeResumes.get(scopeId)
  if (!resumePromise) {
    const resumeOperation = resumeScope(installation, scopeId, host, event, resumeQrl)
    resumePromise = resumeOperation.finally(() => {
      if (installation.pendingScopeResumes.get(scopeId) === resumePromise) {
        installation.pendingScopeResumes.delete(scopeId)
      }
    })
    installation.pendingScopeResumes.set(scopeId, resumePromise)
  }

  const resumed = await waitForActiveInstallation(installation, resumePromise)
  if (resumed === INACTIVE_INSTALLATION) {
    return { canRunHandler: false, hydratedDuringEvent: false }
  }
  return { canRunHandler: resumed, hydratedDuringEvent: resumed }
}

async function resumeScope(
  installation: LoaderInstallation,
  scopeId: string,
  host: Element,
  event: Event,
  resumeQrl: string,
): Promise<boolean> {
  if (!isLoaderInstallationActive(installation)) return false
  const { url: resumeUrl, exportName: resumeExport } = parseQrl(resumeQrl)
  const resolvedResumeUrl = resolveModuleUrl(resumeUrl)
  const resolvedAbsoluteResumeUrl = resolveAbsoluteModuleUrl(
    resolvedResumeUrl,
    host.ownerDocument ?? undefined,
  )
  const resolvedResumeQrl = `${resolvedResumeUrl}#${resumeExport}`
  const resolvedAbsoluteResumeQrl = `${resolvedAbsoluteResumeUrl}#${resumeExport}`
  const normalizedResumeImportUrl = normalizeImportUrl(resolvedResumeUrl)

  try {
    const imported = await waitForActiveInstallation(
      installation,
      import(/* @vite-ignore */ normalizedResumeImportUrl),
    )
    if (imported === INACTIVE_INSTALLATION) return false
  } catch (error) {
    emitSnapshotIssue(installation, {
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
    return false
  }

  const resumeFn =
    __fictGetResume(resumeQrl) ??
    __fictGetResume(resolvedResumeQrl) ??
    __fictGetResume(resolvedAbsoluteResumeQrl) ??
    __fictGetResume(resumeExport)
  if (typeof resumeFn !== 'function') {
    emitSnapshotIssue(installation, {
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
    return false
  }

  try {
    const resumed = await waitForActiveInstallation(
      installation,
      (resumeFn as (scopeId: string, host: Element) => unknown)(scopeId, host),
    )
    if (resumed === INACTIVE_INSTALLATION) return false
  } catch (error) {
    emitSnapshotIssue(installation, {
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
    return false
  }

  installation.hydratedScopes.add(scopeId)
  return true
}

function enqueueScopeHandler<T>(
  installation: LoaderInstallation,
  scopeId: string,
  handler: () => Promise<T>,
): Promise<T> {
  const previousHandler = installation.pendingScopeHandlers.get(scopeId) ?? Promise.resolve()
  const result = previousHandler.then(handler)
  const settled = result.then(
    () => undefined,
    () => undefined,
  )
  installation.pendingScopeHandlers.set(scopeId, settled)
  void settled.then(() => {
    if (installation.pendingScopeHandlers.get(scopeId) === settled) {
      installation.pendingScopeHandlers.delete(scopeId)
    }
  })
  return result
}

async function runScopeHandler(
  installation: LoaderInstallation,
  scopeId: string,
  node: Element,
  event: Event,
  qrl: string,
  url: string,
  exportName: string,
  resumePromise: ReturnType<typeof resumeScopeForEvent>,
  preservedControlState: PreservedControlState | null,
  preemptiveDefault: PreemptiveDefaultControl,
): Promise<boolean> {
  let replayDefault = false
  try {
    if (!isLoaderInstallationActive(installation)) return false
    const resumeResult = await waitForActiveInstallation(installation, resumePromise)
    if (resumeResult === INACTIVE_INSTALLATION) return false
    if (!resumeResult.canRunHandler) {
      return false
    }

    if (resumeResult.hydratedDuringEvent) {
      restoreControlState(node, preservedControlState)
    }

    const resolvedUrl = resolveModuleUrl(url)
    const normalizedImportUrl = normalizeImportUrl(resolvedUrl)
    let mod: Record<string, unknown>
    try {
      const imported = await waitForActiveInstallation(
        installation,
        import(/* @vite-ignore */ normalizedImportUrl),
      )
      if (imported === INACTIVE_INSTALLATION) return false
      mod = imported as Record<string, unknown>
    } catch (error) {
      emitSnapshotIssue(installation, {
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
      return false
    }

    const handler = mod[exportName]
    if (typeof handler !== 'function') {
      emitSnapshotIssue(installation, {
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
      return false
    }

    const currentTargetDescriptor = Object.getOwnPropertyDescriptor(event, 'currentTarget')
    let handlerFailed = false
    Object.defineProperty(event, 'currentTarget', {
      configurable: true,
      get() {
        return node
      },
    })
    try {
      const handled = await waitForActiveInstallation(
        installation,
        (handler as (scopeId: string, ev: Event, el: Element) => unknown)(scopeId, event, node),
      )
      if (handled === INACTIVE_INSTALLATION) return false
    } catch (error) {
      emitSnapshotIssue(installation, {
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
      handlerFailed = true
    } finally {
      if (currentTargetDescriptor) {
        Object.defineProperty(event, 'currentTarget', currentTargetDescriptor)
      } else {
        Reflect.deleteProperty(event, 'currentTarget')
      }
    }
    if (handlerFailed) {
      return false
    }

    replayDefault = true
    return event.cancelBubble
  } finally {
    if (replayDefault) {
      preemptiveDefault.replayIfNeeded()
    }
    preemptiveDefault.restore()
  }
}

async function handleResumableEventAsync(
  installation: LoaderInstallation,
  event: Event,
): Promise<void> {
  if (!isLoaderInstallationActive(installation)) return
  const path =
    typeof event.composedPath === 'function' ? event.composedPath() : buildEventPath(event)

  for (const node of path) {
    if (!isLoaderInstallationActive(installation)) return
    if (!isElementLike(node)) continue
    const qrl = node.getAttribute(`on:${event.type}`)
    if (!qrl) continue

    const host = node.closest('[data-fict-s]') as Element | null
    if (!host) continue
    const sourceScopeId = host.getAttribute('data-fict-s')
    if (!sourceScopeId) continue
    const scopeId = installation.scopeIds.get(sourceScopeId) ?? sourceScopeId

    const snapshot = installation.state.scopes[scopeId]
    if (!snapshot) {
      emitSnapshotIssue(installation, {
        code: 'scope_snapshot_missing',
        message: `[fict/loader] Missing scope snapshot for ${sourceScopeId}; skipping resumable handler execution.`,
        source: 'event',
        expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopeId: sourceScopeId,
      })
      if (installation.snapshotFallbackStarted) return
      continue
    }
    try {
      __fictEnsureScope(scopeId, host, snapshot)
    } catch (error) {
      emitSnapshotIssue(installation, {
        code: 'snapshot_invalid_shape',
        message: `[fict/loader] Invalid serialized state for scope ${sourceScopeId}; skipping resumable handler execution: ${formatImportError(error)}`,
        source: 'event',
        expectedVersion: FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
        scopeId: sourceScopeId,
        eventType: event.type,
        error,
      })
      return
    }

    const { url, exportName, flags } = parseQrl(qrl)

    const preemptiveDefault = preemptivelyPreventDefault(node, event, {
      mayPreventDefault: flags.includes('pd'),
    })

    const preservedControlState = captureControlState(node, event)
    const resumePromise = resumeScopeForEvent(installation, scopeId, host, event)
    const shouldStop = await enqueueScopeHandler(installation, scopeId, () =>
      runScopeHandler(
        installation,
        scopeId,
        node,
        event,
        qrl,
        url,
        exportName,
        resumePromise,
        preservedControlState,
        preemptiveDefault,
      ),
    )
    if (!isLoaderInstallationActive(installation)) return
    if (shouldStop) {
      return
    }
  }
}

function parseQrl(qrl: string): { url: string; exportName: string; flags: string[] } {
  if (!qrl) {
    return { url: '', exportName: 'default', flags: [] }
  }
  const hashIndex = qrl.lastIndexOf('#')
  if (hashIndex === -1) {
    return { url: qrl, exportName: 'default', flags: [] }
  }

  let exportName = qrl.slice(hashIndex + 1)
  const flags: string[] = []
  const metadataStart = exportName.indexOf('[')
  if (metadataStart !== -1 && exportName.endsWith(']')) {
    const metadata = exportName.slice(metadataStart + 1, -1)
    exportName = exportName.slice(0, metadataStart)
    for (const flag of metadata.split(',')) {
      if (flag) flags.push(flag)
    }
  }

  return { url: qrl.slice(0, hashIndex), exportName, flags }
}

function buildEventPath(event: Event): EventTarget[] {
  const path: EventTarget[] = []
  let node: EventTarget | null = event.target
  while (node) {
    path.push(node)
    node = (node as Node).parentNode ?? null
  }
  const doc = getEventDocument(event.target) ?? getEventDocument(event.currentTarget)
  const view = doc?.defaultView ?? (typeof window !== 'undefined' ? window : undefined)
  if (view && !path.includes(view)) {
    path.push(view)
  }
  return path
}

function getEventDocument(target: EventTarget | null): Document | undefined {
  if (!target || typeof (target as Node).nodeType !== 'number') return undefined
  const node = target as Node
  return node.nodeType === 9 ? (node as Document) : (node.ownerDocument ?? undefined)
}

// Re-export for handler authors (optional)
export { __fictUseLexicalScope } from './resume'
