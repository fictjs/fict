import type { HookContext } from './hooks'
import { registerRootCleanup } from './lifecycle'
import { materializePropsForSnapshot, unwrapProps } from './props'
import { batch, createSignal, isSignal } from './signal'
import {
  __fictCreateSSRSession,
  __fictGetCurrentSSRSession,
  __fictResetSSRSession,
  type FictSSRSession,
} from './ssr-session'
import { __fictGetCurrentSSRBoundary } from './ssr-stream'
import { createStore, isStoreProxy, unwrapStore } from './store'

// ============================================================================
// Serialization Types
// ============================================================================

/**
 * Type markers for serialized values.
 * These allow us to preserve type information through JSON serialization.
 */
type SerializedMarker =
  | { __t: 'd'; v: number | 'invalid' } // Date (as timestamp or invalid marker)
  | { __t: 'm'; v: [unknown, unknown][] } // Map (as entries array)
  | { __t: 's'; v: unknown[] } // Set (as array)
  | { __t: 'r'; v: { s: string; f: string; l?: number } } // RegExp (source + flags + lastIndex)
  | { __t: 'sym'; v: { k: 'g' | 'w'; n: string } } // Symbol.for / well-known Symbol
  | { __t: 'o'; v: [unknown, unknown][]; p?: 'n' } // Object with symbol keys/null prototype
  | { __t: 'h' } // Array hole
  | { __t: 'u' } // undefined
  | { __t: 'n' } // NaN
  | { __t: '-0' } // Negative zero
  | { __t: '+i' } // Infinity
  | { __t: '-i' } // -Infinity
  | { __t: 'b'; v: string } // BigInt (as string)
  | { __t: 'ref'; v: string } // Circular reference (path)

interface SerializeOptions {
  omitFunctionProperties?: boolean
  omitCurrentFunction?: boolean
}

export type SlotSnapshot =
  | [index: number, type: 'sig', value: unknown]
  | [index: number, type: 'store', value: unknown]
  | [index: number, type: 'raw', value: unknown]

export interface ScopeSnapshot {
  id: string
  t?: string
  slots: SlotSnapshot[]
  props?: Record<string, unknown>
  vars?: Record<string, number>
}

export const FICT_SSR_SNAPSHOT_SCHEMA_VERSION = 2

export interface SSRState {
  v: number
  scopes: Record<string, ScopeSnapshot>
}

export interface ScopeRecord {
  id: string
  ctx: HookContext
  host: Element
  boundaryId?: string
  type?: string
  props?: Record<string, unknown>
}

export interface ComponentMeta {
  id?: string
  resume?: string
}

let resumableEnabled = false
let hydrationDepth = 0
const defaultSSRSession = __fictCreateSSRSession()

type StoreSetter = (fn: (state: object) => void | object) => void

interface ResumedScopeEntry {
  ctx: HookContext
  host: Element
  props?: Record<string, unknown>
  signalAccessors: Map<number, unknown>
  storeProxies: Map<number, unknown>
  storeSetters: Map<number, StoreSetter>
  storeTopologies: Map<number, Map<string, object>>
  /** Last server revision observed for three-way ownership checks. */
  serverBaseline?: ScopeSnapshot
  /** Client ownership is sticky for the lifetime of a resumed scope. */
  clientOwned: boolean
}

const resumedScopes = new Map<string, ResumedScopeEntry>()
const componentMetaRegistry = new WeakMap<object, ComponentMeta>()
const COMMITTED_SSR_STATE_ERROR = Symbol('fict:committed-ssr-state-error')

export function __fictIsCommittedSSRStateError(
  error: unknown,
): error is Error & { readonly cause: unknown } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { [COMMITTED_SSR_STATE_ERROR]?: boolean })[COMMITTED_SSR_STATE_ERROR] === true
  )
}

function createCommittedSSRStateError(cause: unknown): Error & { readonly cause: unknown } {
  const message = cause instanceof Error ? cause.message : String(cause)
  const error = new Error(message) as Error & { readonly cause: unknown }
  Object.defineProperties(error, {
    cause: { value: cause, configurable: true },
    [COMMITTED_SSR_STATE_ERROR]: { value: true },
  })
  error.name = 'CommittedSSRStateError'
  return error
}

const WELL_KNOWN_SYMBOLS = new Map<symbol, string>([
  [Symbol.asyncIterator, 'asyncIterator'],
  [Symbol.hasInstance, 'hasInstance'],
  [Symbol.isConcatSpreadable, 'isConcatSpreadable'],
  [Symbol.iterator, 'iterator'],
  [Symbol.match, 'match'],
  [Symbol.matchAll, 'matchAll'],
  [Symbol.replace, 'replace'],
  [Symbol.search, 'search'],
  [Symbol.species, 'species'],
  [Symbol.split, 'split'],
  [Symbol.toPrimitive, 'toPrimitive'],
  [Symbol.toStringTag, 'toStringTag'],
  [Symbol.unscopables, 'unscopables'],
])

const resourceManagementSymbols = Symbol as typeof Symbol & {
  readonly dispose?: symbol
  readonly asyncDispose?: symbol
}
if (resourceManagementSymbols.dispose !== undefined) {
  WELL_KNOWN_SYMBOLS.set(resourceManagementSymbols.dispose, 'dispose')
}
if (resourceManagementSymbols.asyncDispose !== undefined) {
  WELL_KNOWN_SYMBOLS.set(resourceManagementSymbols.asyncDispose, 'asyncDispose')
}

const WELL_KNOWN_SYMBOL_BY_NAME = new Map(
  Array.from(WELL_KNOWN_SYMBOLS, ([symbol, name]) => [name, symbol] as const),
)

function getSSRSession(): FictSSRSession {
  return __fictGetCurrentSSRSession() ?? defaultSSRSession
}

function getScopeRegistry(): Map<string, ScopeRecord> {
  return getSSRSession().scopeRegistry as Map<string, ScopeRecord>
}

function getBoundaryScopes(): Map<string, Set<string>> {
  return getSSRSession().boundaryScopes
}

function getSnapshotState(): SSRState | null {
  return getSSRSession().snapshotState as SSRState | null
}

function copySnapshotScopes(scopes: Record<string, ScopeSnapshot>): Record<string, ScopeSnapshot> {
  const copy = Object.create(null) as Record<string, ScopeSnapshot>
  for (const [scopeId, snapshot] of Object.entries(scopes)) {
    copy[scopeId] = snapshot
  }
  return copy
}

function setSnapshotState(state: SSRState | null): void {
  getSSRSession().snapshotState = state
    ? { v: state.v, scopes: copySnapshotScopes(state.scopes) }
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`[fict] Invalid SSR snapshot ${label}: expected an object.`)
  }
}

function assertScopeSnapshot(value: unknown, scopeId: string): asserts value is ScopeSnapshot {
  assertRecord(value, `scope "${scopeId}"`)
  if (typeof value.id !== 'string') {
    throw new Error(`[fict] Invalid SSR snapshot scope "${scopeId}": expected string id.`)
  }
  if (value.t !== undefined && typeof value.t !== 'string') {
    throw new Error(`[fict] Invalid SSR snapshot scope "${scopeId}": expected string type.`)
  }
  if (!Array.isArray(value.slots)) {
    throw new Error(`[fict] Invalid SSR snapshot scope "${scopeId}": expected slots array.`)
  }
  for (let i = 0; i < value.slots.length; i++) {
    const slot = value.slots[i]
    if (
      !Array.isArray(slot) ||
      !Number.isInteger(slot[0]) ||
      (slot[1] !== 'sig' && slot[1] !== 'store' && slot[1] !== 'raw') ||
      slot.length < 3
    ) {
      throw new Error(`[fict] Invalid SSR snapshot scope "${scopeId}" slot ${i}.`)
    }
  }
  if (value.props !== undefined) {
    assertRecord(value.props, `scope "${scopeId}" props`)
  }
  if (value.vars !== undefined) {
    assertRecord(value.vars, `scope "${scopeId}" vars`)
    for (const [name, index] of Object.entries(value.vars)) {
      if (typeof index !== 'number' || !Number.isInteger(index)) {
        throw new Error(
          `[fict] Invalid SSR snapshot scope "${scopeId}" var "${name}": expected integer slot index.`,
        )
      }
    }
  }
}

function validateSSRState(state: SSRState, operation: string): SSRState {
  assertRecord(state, operation)
  if (state.v !== FICT_SSR_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `[fict] Unsupported SSR snapshot schema version for ${operation}: ${String(state.v)}.`,
    )
  }
  assertRecord(state.scopes, `${operation} scopes`)
  for (const [scopeId, scope] of Object.entries(state.scopes)) {
    assertScopeSnapshot(scope, scopeId)
  }
  return state
}

function resetSSRTrackingState(session = getSSRSession()): void {
  __fictResetSSRSession(session)
  resumedScopes.clear()
}

export function __fictEnableSSR(): void {
  const session = getSSRSession()
  resetSSRTrackingState(session)
  session.ssrEnabled = true
}

export function __fictDisableSSR(): void {
  const session = getSSRSession()
  session.ssrEnabled = false
  resetSSRTrackingState(session)
}

export function __fictEnableResumable(): void {
  resumableEnabled = true
}

export function __fictDisableResumable(): void {
  resumableEnabled = false
  resumedScopes.clear()
}

export function __fictDeleteResumedScopes(scopeIds: Iterable<string>): void {
  for (const scopeId of scopeIds) {
    resumedScopes.delete(scopeId)
  }
}

export function __fictIsResumable(): boolean {
  return getSSRSession().ssrEnabled || resumableEnabled
}

export function __fictIsSSR(): boolean {
  return getSSRSession().ssrEnabled
}

export function __fictSetSSRScopeIdentifierPrefix(prefix: string): void {
  getSSRSession().scopeIdentifierPrefix = prefix
}

export function __fictEnterHydration(): void {
  hydrationDepth++
}

export function __fictExitHydration(): void {
  hydrationDepth = Math.max(0, hydrationDepth - 1)
}

export function __fictIsHydrating(): boolean {
  return hydrationDepth > 0
}

export function __fictRegisterScope(
  ctx: HookContext,
  host: Element,
  type?: string,
  props?: Record<string, unknown>,
): string {
  if (!__fictIsResumable()) return ''

  const session = getSSRSession()
  const scopeRegistry = getScopeRegistry()
  const boundaryScopes = getBoundaryScopes()
  const localId = `s${++session.scopeCounter}`
  const id = session.scopeIdentifierPrefix ? `${session.scopeIdentifierPrefix}:${localId}` : localId
  ctx.scopeId = id
  if (type !== undefined) {
    ctx.scopeType = type
  }
  host.setAttribute('data-fict-s', id)
  if (type) {
    host.setAttribute('data-fict-t', type)
  }

  const record: ScopeRecord = { id, ctx, host }
  if (type !== undefined) {
    record.type = type
  }
  if (props !== undefined) {
    record.props = props
  }
  const boundaryId = __fictGetCurrentSSRBoundary()
  if (boundaryId) {
    record.boundaryId = boundaryId
    let scopes = boundaryScopes.get(boundaryId)
    if (!scopes) {
      scopes = new Set()
      boundaryScopes.set(boundaryId, scopes)
    }
    scopes.add(id)
  }
  scopeRegistry.set(id, record)
  registerRootCleanup(() => {
    if (scopeRegistry.get(id) === record) {
      scopeRegistry.delete(id)
    }
    if (record.boundaryId) {
      const scopes = boundaryScopes.get(record.boundaryId)
      scopes?.delete(id)
      if (scopes?.size === 0) {
        boundaryScopes.delete(record.boundaryId)
      }
    }
  })
  return id
}

export function __fictGetScopeRegistry(): Map<string, ScopeRecord> {
  return getScopeRegistry()
}

export function __fictGetScopesForBoundary(boundaryId: string): string[] {
  const scopes = getBoundaryScopes().get(boundaryId)
  if (!scopes) return []
  return Array.from(scopes)
}

export function __fictSerializeSSRState(): SSRState {
  const scopes: Record<string, ScopeSnapshot> = {}

  for (const [id, record] of getScopeRegistry().entries()) {
    scopes[id] = serializeScopeRecord(record)
  }

  return { v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION, scopes }
}

export function __fictSerializeSSRStateForScopes(scopeIds: Iterable<string>): SSRState {
  const scopes: Record<string, ScopeSnapshot> = {}

  for (const id of scopeIds) {
    const record = getScopeRegistry().get(id)
    if (!record) continue
    scopes[id] = serializeScopeRecord(record)
  }

  return { v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION, scopes }
}

export function __fictSetSSRState(state: SSRState | null): void {
  if (!state) {
    setSnapshotState(null)
    resumedScopes.clear()
    return
  }

  const validated = validateSSRState(state, '__fictSetSSRState')
  reconcileResumedScopeRevisions(validated.scopes, () => setSnapshotState(validated))
}

export function __fictMergeSSRState(state: SSRState | null): void {
  if (!state) return
  const validated = validateSSRState(state, '__fictMergeSSRState')
  const snapshotState = getSnapshotState()
  reconcileResumedScopeRevisions(validated.scopes, () => {
    if (!snapshotState) {
      setSnapshotState(validated)
    } else {
      Object.assign(snapshotState.scopes, validated.scopes)
    }
  })
}

export function __fictGetSSRScope(id: string): ScopeSnapshot | undefined {
  const scopes = getSnapshotState()?.scopes
  if (!scopes || !Object.prototype.hasOwnProperty.call(scopes, id)) return undefined
  return scopes[id]
}

export function __fictEnsureScope(
  scopeId: string,
  host: Element,
  snapshot?: ScopeSnapshot,
): HookContext {
  const existing = resumedScopes.get(scopeId)
  if (existing) return existing.ctx

  const refs = new Map<string, unknown>()
  const signalAccessors = new Map<number, unknown>()
  const storeProxies = new Map<number, unknown>()
  const storeSetters = new Map<number, StoreSetter>()
  const ctx = createContextFromSnapshot(snapshot, refs, signalAccessors, storeProxies, storeSetters)
  ctx.scopeId = scopeId
  if (snapshot?.t !== undefined) {
    ctx.scopeType = snapshot.t
  }
  const entry: ResumedScopeEntry = {
    ctx,
    host,
    signalAccessors,
    storeProxies,
    storeSetters,
    storeTopologies: new Map(),
    clientOwned: false,
  }
  if (snapshot !== undefined) {
    entry.serverBaseline = snapshot
  }
  if (snapshot?.props !== undefined) {
    entry.props = deserializeValue(snapshot.props, refs, '$.props') as Record<string, unknown>
  }
  captureAcceptedStoreTopologies(entry)
  resumedScopes.set(scopeId, entry)
  return ctx
}

export function __fictUseLexicalScope(scopeId: string, names: string[]): unknown[] {
  const record = resumedScopes.get(scopeId)
  if (!record) {
    throw new Error(`[fict] Missing resumed scope for ${scopeId}`)
  }
  const ctx = record.ctx
  const map = ctx.slotMap ?? {}
  return names.map(name => {
    const index = Object.prototype.hasOwnProperty.call(map, name) ? map[name]! : -1
    return ctx.slots[index]
  })
}

export function __fictGetScopeProps(scopeId: string): Record<string, unknown> | undefined {
  return resumedScopes.get(scopeId)?.props
}

interface DeserializedScopeSlot {
  index: number
  type: SlotSnapshot[1]
  value: unknown
}

interface DeserializedScopeRevision {
  slots: DeserializedScopeSlot[]
  hasProps: boolean
  props?: Record<string, unknown>
}

interface PreparedScopeRevision {
  entry: ResumedScopeEntry
  snapshot: ScopeSnapshot
  deserialized: DeserializedScopeRevision
  serverOwned: boolean
  hasServerChanges: boolean
  clientOwned: boolean
  initializing: boolean
}

/**
 * Treat streamed snapshots for a scope as ordered server revisions. A live scope
 * remains server-owned while its complete serializable state equals the previous
 * server revision. Once client code changes any part of that state, ownership of
 * the whole scope permanently moves to the client: later revisions advance the
 * comparison baseline, but never roll the live scope back or reclaim ownership
 * merely because values happen to converge again.
 */
function reconcileResumedScopeRevisions(
  scopes: Record<string, ScopeSnapshot>,
  publishSnapshot: () => void,
): void {
  const prepared: PreparedScopeRevision[] = []

  // Deserialize and validate every affected live scope before mutating any of
  // them, so a malformed incremental payload cannot leave a partial revision.
  for (const [scopeId, snapshot] of Object.entries(scopes)) {
    const entry = resumedScopes.get(scopeId)
    if (!entry) continue
    prepared.push(prepareScopeRevision(scopeId, entry, snapshot))
  }

  let fullyApplied = false
  const commit = () => {
    // Publish the global snapshot and every ownership/baseline decision before
    // applying reactive writes. The enclosing batch cannot flush effects until
    // all observable representations point at the same revision.
    publishSnapshot()
    for (const revision of prepared) {
      revision.entry.serverBaseline = revision.snapshot
      revision.entry.clientOwned = revision.clientOwned
      if (revision.clientOwned) releaseCapturedServerState(revision.entry)
    }
    for (const revision of prepared) {
      applyScopeRevision(revision)
    }
    fullyApplied = true
  }

  try {
    if (prepared.some(revision => revision.serverOwned && revision.hasServerChanges)) {
      batch(commit)
    } else {
      commit()
    }
  } catch (error) {
    if (fullyApplied) throw createCommittedSSRStateError(error)
    throw error
  }
}

function releaseCapturedServerState(entry: ResumedScopeEntry): void {
  // A client-owned scope can never be reclaimed by later server revisions.
  // Drop identity snapshots and setter closures so replaced server objects do
  // not stay strongly reachable for the remainder of the scope lifetime.
  entry.signalAccessors.clear()
  entry.storeProxies.clear()
  entry.storeSetters.clear()
  entry.storeTopologies.clear()
}

function prepareScopeRevision(
  scopeId: string,
  entry: ResumedScopeEntry,
  snapshot: ScopeSnapshot,
): PreparedScopeRevision {
  const deserialized = deserializeScopeRevision(snapshot, scopeId)
  const baseline = entry.serverBaseline
  if (!baseline) {
    assertUninitializedScopeCanInstall(scopeId, entry)
    return {
      entry,
      snapshot,
      deserialized,
      serverOwned: true,
      hasServerChanges: true,
      clientOwned: false,
      initializing: true,
    }
  }

  assertCompatibleScopeRevision(scopeId, baseline, snapshot)

  const matchesCapturedIdentities =
    !entry.clientOwned && capturedSlotIdentitiesMatch(entry, snapshot)
  const matchesBaseline = matchesCapturedIdentities && isScopeAtServerBaseline(entry, baseline)
  const matchesStoreTopology = matchesBaseline && acceptedStoreTopologiesMatch(entry)
  const clientOwned = entry.clientOwned || !matchesBaseline || !matchesStoreTopology
  const serverOwned = !clientOwned
  const hasServerChanges = !serializedValuesEqual(baseline, snapshot)
  if (serverOwned && hasServerChanges) {
    // Generated event handlers fetch entry.props on every invocation, but the
    // generated component resume function passes snapshot.props into hydration
    // once. A host with a resume QRL may therefore have captured the old object.
    if (
      entry.host.hasAttribute('data-fict-h') &&
      !serializedValuesEqual(baseline.props, snapshot.props)
    ) {
      throw new Error(
        `[fict] Cannot merge SSR snapshot scope "${scopeId}": component props identity may already be captured by hydration.`,
      )
    }
    for (const slot of deserialized.slots) {
      const current = entry.ctx.slots[slot.index]
      if (slot.type === 'sig' && !isSignal(current)) {
        throw new Error(
          `[fict] Cannot merge SSR snapshot scope "${scopeId}" slot ${slot.index}: live signal identity was lost.`,
        )
      }
      if (slot.type === 'store' && !entry.storeSetters.has(slot.index)) {
        throw new Error(
          `[fict] Cannot merge SSR snapshot scope "${scopeId}" slot ${slot.index}: live store identity was lost.`,
        )
      }
      if (slot.type === 'store') {
        assertCompatibleStoreRevision(scopeId, slot.index, current, slot.value as object)
      }
    }
    assertSafeStoreAliasTopology(scopeId, deserializeScopeRevision(baseline, scopeId), 'current')
    assertSafeStoreAliasTopology(scopeId, deserialized, 'incoming')
  }

  return {
    entry,
    snapshot,
    deserialized,
    serverOwned,
    hasServerChanges,
    clientOwned,
    initializing: false,
  }
}

function applyScopeRevision(revision: PreparedScopeRevision): void {
  const { entry, deserialized, serverOwned, hasServerChanges, initializing } = revision
  if (!serverOwned || !hasServerChanges) return
  if (initializing) {
    installInitialScopeRevision(revision)
    return
  }

  // All roots came from one refs map. Installing signal/raw/props values from
  // this graph together preserves aliases (including topology changes) between
  // those runtime-owned roots; store roots are separately rejected unless safely
  // reconcilable. References copied into arbitrary user closures are outside the
  // snapshot graph and cannot be retargeted by an incremental revision.
  for (const slot of deserialized.slots) {
    if (slot.type === 'sig') {
      ;(entry.signalAccessors.get(slot.index)! as (value: unknown) => void)(slot.value)
    } else if (slot.type === 'store') {
      entry.storeSetters.get(slot.index)!(() => slot.value as object)
    } else {
      entry.ctx.slots[slot.index] = slot.value
    }
  }

  if (deserialized.hasProps) {
    entry.props = deserialized.props!
  } else {
    delete entry.props
  }
  captureAcceptedStoreTopologies(entry)
}

function capturedSlotIdentitiesMatch(entry: ResumedScopeEntry, snapshot: ScopeSnapshot): boolean {
  for (const [index, type] of snapshot.slots) {
    const current = entry.ctx.slots[index]
    if (
      type === 'sig' &&
      (!entry.signalAccessors.has(index) || current !== entry.signalAccessors.get(index))
    ) {
      return false
    }
    if (
      type === 'store' &&
      (!entry.storeProxies.has(index) ||
        current !== entry.storeProxies.get(index) ||
        !entry.storeSetters.has(index))
    ) {
      return false
    }
  }
  return true
}

function assertUninitializedScopeCanInstall(scopeId: string, entry: ResumedScopeEntry): void {
  const contextKeys = Reflect.ownKeys(entry.ctx)
  const slotsDescriptor = Object.getOwnPropertyDescriptor(entry.ctx, 'slots')
  const cursorDescriptor = Object.getOwnPropertyDescriptor(entry.ctx, 'cursor')
  const scopeIdDescriptor = Object.getOwnPropertyDescriptor(entry.ctx, 'scopeId')
  const pristineContext =
    Object.getPrototypeOf(entry.ctx) === Object.prototype &&
    Object.isExtensible(entry.ctx) &&
    contextKeys.length === 3 &&
    contextKeys.every(key => key === 'slots' || key === 'cursor' || key === 'scopeId') &&
    isCanonicalWritableDataDescriptor(slotsDescriptor) &&
    isCanonicalWritableDataDescriptor(cursorDescriptor) &&
    isCanonicalWritableDataDescriptor(scopeIdDescriptor) &&
    cursorDescriptor.value === 0 &&
    scopeIdDescriptor.value === scopeId
  const slots = slotsDescriptor && 'value' in slotsDescriptor ? slotsDescriptor.value : undefined
  const lengthDescriptor = Array.isArray(slots)
    ? Object.getOwnPropertyDescriptor(slots, 'length')
    : undefined
  const pristineSlots =
    Array.isArray(slots) &&
    Object.getPrototypeOf(slots) === Array.prototype &&
    Object.isExtensible(slots) &&
    slots.length === 0 &&
    Reflect.ownKeys(slots).every(key => key === 'length') &&
    !!lengthDescriptor &&
    'value' in lengthDescriptor &&
    lengthDescriptor.writable === true
  if (
    !pristineContext ||
    !pristineSlots ||
    entry.props !== undefined ||
    entry.signalAccessors.size !== 0 ||
    entry.storeProxies.size !== 0 ||
    entry.storeSetters.size !== 0 ||
    entry.storeTopologies.size !== 0
  ) {
    throw new Error(
      `[fict] Cannot install first SSR snapshot scope "${scopeId}": live scope is no longer empty.`,
    )
  }
}

function isCanonicalWritableDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return (
    !!descriptor &&
    'value' in descriptor &&
    descriptor.writable === true &&
    descriptor.enumerable === true &&
    descriptor.configurable === true
  )
}

function installInitialScopeRevision(revision: PreparedScopeRevision): void {
  const { entry, snapshot, deserialized } = revision
  for (const slot of deserialized.slots) {
    if (slot.type === 'sig') {
      const signal = createSignal(slot.value)
      entry.ctx.slots[slot.index] = signal
      entry.signalAccessors.set(slot.index, signal)
    } else if (slot.type === 'store') {
      const [store, setStore] = createStore(slot.value as object)
      entry.ctx.slots[slot.index] = store
      entry.storeProxies.set(slot.index, store)
      entry.storeSetters.set(slot.index, setStore)
    } else {
      entry.ctx.slots[slot.index] = slot.value
    }
  }

  if (snapshot.vars) {
    entry.ctx.slotMap = Object.assign(Object.create(null) as Record<string, number>, snapshot.vars)
  }
  if (snapshot.t !== undefined) entry.ctx.scopeType = snapshot.t
  if (deserialized.hasProps) entry.props = deserialized.props!
  captureAcceptedStoreTopologies(entry)
}

function captureAcceptedStoreTopologies(entry: ResumedScopeEntry): void {
  const topologies = new Map<number, Map<string, object>>()
  for (const [index, store] of entry.storeProxies) {
    topologies.set(index, captureStorePlainNodeTopology(store))
  }
  entry.storeTopologies = topologies
}

function acceptedStoreTopologiesMatch(entry: ResumedScopeEntry): boolean {
  if (entry.storeTopologies.size !== entry.storeProxies.size) return false
  for (const [index, store] of entry.storeProxies) {
    const accepted = entry.storeTopologies.get(index)
    if (!accepted) return false
    const current = captureStorePlainNodeTopology(store)
    if (current.size !== accepted.size) return false
    for (const [path, value] of accepted) {
      if (current.get(path) !== value) return false
    }
  }
  return true
}

function captureStorePlainNodeTopology(value: unknown): Map<string, object> {
  const topology = new Map<string, object>()
  const seen = new WeakSet<object>()

  const visit = (currentValue: unknown, path: string): void => {
    const current = unwrapStore(currentValue)
    if (current === null || typeof current !== 'object') return
    const prototype = Object.getPrototypeOf(current)
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) return

    topology.set(path, current)
    if (seen.has(current)) return
    seen.add(current)
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) continue
      visit(descriptor.value, storeChildPath(path, key))
    }
  }

  visit(value, '$')
  return topology
}

function assertCompatibleStoreRevision(
  scopeId: string,
  slotIndex: number,
  liveValue: unknown,
  nextValue: object,
): void {
  assertCanonicalStoreReconcileTree(
    scopeId,
    slotIndex,
    unwrapStore(liveValue),
    nextValue,
    '$',
    new WeakSet<object>(),
  )
}

function assertCanonicalStoreReconcileTree(
  scopeId: string,
  slotIndex: number,
  currentValue: unknown,
  nextValue: unknown,
  path: string,
  seen: WeakSet<object>,
): void {
  const current = unwrapStore(currentValue)
  const next = unwrapStore(nextValue)
  if (
    current === null ||
    next === null ||
    typeof current !== 'object' ||
    typeof next !== 'object'
  ) {
    failUnsafeStoreReconcile(scopeId, slotIndex, path, 'store node is not an object')
  }

  const currentIsArray = Array.isArray(current)
  const nextIsArray = Array.isArray(next)
  const currentPrototype = Object.getPrototypeOf(current)
  const nextPrototype = Object.getPrototypeOf(next)
  const hasCanonicalPrototype = currentIsArray
    ? currentPrototype === Array.prototype
    : currentPrototype === Object.prototype || currentPrototype === null
  if (
    !hasCanonicalPrototype ||
    currentIsArray !== nextIsArray ||
    currentPrototype !== nextPrototype
  ) {
    failUnsafeStoreReconcile(scopeId, slotIndex, path, 'store prototype is not canonical')
  }

  if (seen.has(current)) return
  seen.add(current)

  if (!Object.isExtensible(current)) {
    failUnsafeStoreReconcile(scopeId, slotIndex, path, 'store node is not extensible')
  }

  if (currentIsArray) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(current, 'length')
    if (
      !lengthDescriptor ||
      !('value' in lengthDescriptor) ||
      lengthDescriptor.value !== current.length ||
      lengthDescriptor.writable !== true ||
      lengthDescriptor.enumerable !== false ||
      lengthDescriptor.configurable !== false
    ) {
      failUnsafeStoreReconcile(scopeId, slotIndex, `${path}.length`, 'array length is not writable')
    }
  }

  for (const key of Reflect.ownKeys(current)) {
    if (currentIsArray && key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (
      !descriptor ||
      !('value' in descriptor) ||
      descriptor.writable !== true ||
      descriptor.enumerable !== true ||
      descriptor.configurable !== true
    ) {
      failUnsafeStoreReconcile(
        scopeId,
        slotIndex,
        storeChildPath(path, key),
        'store property descriptor is not canonical',
      )
    }
    if (currentIsArray && (typeof key !== 'string' || !isArrayIndexKey(key))) {
      failUnsafeStoreReconcile(
        scopeId,
        slotIndex,
        storeChildPath(path, key),
        'array store contains a non-index property',
      )
    }
  }

  for (const key of enumerableStoreKeys(next)) {
    const currentDescriptor = Object.getOwnPropertyDescriptor(current, key)
    const nextDescriptor = Object.getOwnPropertyDescriptor(next, key)!
    if (!currentDescriptor) {
      if (key === '__proto__') {
        failUnsafeStoreReconcile(
          scopeId,
          slotIndex,
          storeChildPath(path, key),
          'adding __proto__ would invoke an inherited setter',
        )
      }
      const inherited = getInheritedPropertyDescriptor(current, key)
      if (inherited && (!('value' in inherited) || inherited.writable !== true)) {
        failUnsafeStoreReconcile(
          scopeId,
          slotIndex,
          storeChildPath(path, key),
          'adding the property would invoke or violate an inherited descriptor',
        )
      }
      continue
    }

    const currentChild = (currentDescriptor as PropertyDescriptor & { value: unknown }).value
    const nextChild = (nextDescriptor as PropertyDescriptor & { value: unknown }).value
    if (areStoreNodesRecursivelyReconciled(currentChild, nextChild)) {
      assertCanonicalStoreReconcileTree(
        scopeId,
        slotIndex,
        currentChild,
        nextChild,
        storeChildPath(path, key),
        seen,
      )
    }
  }
}

function areStoreNodesRecursivelyReconciled(currentValue: unknown, nextValue: unknown): boolean {
  const current = unwrapStore(currentValue)
  const next = unwrapStore(nextValue)
  if (
    current === null ||
    next === null ||
    typeof current !== 'object' ||
    typeof next !== 'object'
  ) {
    return false
  }
  const currentPrototype = Object.getPrototypeOf(current)
  const nextPrototype = Object.getPrototypeOf(next)
  const currentPlain = currentPrototype === Object.prototype || currentPrototype === null
  const nextPlain = nextPrototype === Object.prototype || nextPrototype === null
  return (
    (Array.isArray(current) && Array.isArray(next)) ||
    (!Array.isArray(current) && !Array.isArray(next) && currentPlain && nextPlain)
  )
}

function enumerableStoreKeys(value: object): (string | symbol)[] {
  return Reflect.ownKeys(value).filter(key => {
    return Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
  })
}

function getInheritedPropertyDescriptor(
  value: object,
  key: string | symbol,
): PropertyDescriptor | undefined {
  let prototype = Object.getPrototypeOf(value)
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
    if (descriptor) return descriptor
    prototype = Object.getPrototypeOf(prototype)
  }
  return undefined
}

function storeChildPath(path: string, key: string | symbol): string {
  return typeof key === 'symbol' ? `${path}[${String(key)}]` : `${path}[${JSON.stringify(key)}]`
}

function failUnsafeStoreReconcile(
  scopeId: string,
  slotIndex: number,
  path: string,
  reason: string,
): never {
  throw new Error(
    `[fict] Cannot merge SSR snapshot scope "${scopeId}" slot ${slotIndex} at ${path}: ${reason}.`,
  )
}

/**
 * Store reconciliation preserves the live proxy/root identity by mutating its
 * object tree. It cannot safely create or remove aliases/cycles within that tree,
 * or preserve an alias shared with another slot/props root. Reject such revisions
 * before any live state changes instead of silently corrupting reference topology.
 */
function assertSafeStoreAliasTopology(
  scopeId: string,
  revision: DeserializedScopeRevision,
  label: 'current' | 'incoming',
): void {
  const storeObjects = new Set<object>()
  const storeSlots = revision.slots.filter(slot => slot.type === 'store')
  if (storeSlots.length === 0) return

  const fail = (slotIndex: number) => {
    throw new Error(
      `[fict] Cannot merge SSR snapshot scope "${scopeId}" slot ${slotIndex}: ${label} store aliases or cycles cannot be reconciled safely.`,
    )
  }

  for (const slot of storeSlots) {
    const seenInStore = new Set<object>()
    walkObjectGraph(slot.value, value => {
      if (seenInStore.has(value) || storeObjects.has(value)) fail(slot.index)
      seenInStore.add(value)
      storeObjects.add(value)
    })
  }

  const nonStoreRoots: unknown[] = revision.slots
    .filter(slot => slot.type !== 'store')
    .map(slot => slot.value)
  if (revision.hasProps) nonStoreRoots.push(revision.props)

  for (const root of nonStoreRoots) {
    const seen = new Set<object>()
    walkObjectGraph(root, value => {
      if (storeObjects.has(value)) fail(storeSlots[0]!.index)
      if (seen.has(value)) return false
      seen.add(value)
      return true
    })
  }
}

function walkObjectGraph(value: unknown, visit: (value: object) => boolean | void): void {
  if (value === null || typeof value !== 'object') return
  if (visit(value) === false) return

  if (value instanceof Map) {
    for (const [key, entryValue] of value) {
      walkObjectGraph(key, visit)
      walkObjectGraph(entryValue, visit)
    }
    return
  }

  if (value instanceof Set) {
    for (const entryValue of value) walkObjectGraph(entryValue, visit)
    return
  }

  if (value instanceof Date || value instanceof RegExp) return

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) continue
    walkObjectGraph(descriptor.value, visit)
  }
}

function deserializeScopeRevision(
  snapshot: ScopeSnapshot,
  scopeId: string,
): DeserializedScopeRevision {
  const refs = new Map<string, unknown>()
  const seenSlots = new Set<number>()
  const slots: DeserializedScopeSlot[] = []

  for (const [index, type, value] of snapshot.slots) {
    if (seenSlots.has(index)) {
      throw new Error(`[fict] Invalid SSR snapshot scope "${scopeId}": duplicate slot ${index}.`)
    }
    seenSlots.add(index)
    const restored = deserializeValue(value, refs, `$[${index}]`)
    if (type === 'store' && (restored === null || typeof restored !== 'object')) {
      throw new Error(
        `[fict] Invalid SSR snapshot scope "${scopeId}" slot ${index}: store value must be an object.`,
      )
    }
    slots.push({ index, type, value: restored })
  }

  if (snapshot.props === undefined) {
    return { slots, hasProps: false }
  }

  return {
    slots,
    hasProps: true,
    props: deserializeValue(snapshot.props, refs, '$.props') as Record<string, unknown>,
  }
}

function assertCompatibleScopeRevision(
  scopeId: string,
  baseline: ScopeSnapshot,
  snapshot: ScopeSnapshot,
): void {
  if (baseline.id !== snapshot.id || baseline.t !== snapshot.t) {
    throw new Error(
      `[fict] Cannot merge SSR snapshot scope "${scopeId}": component identity changed.`,
    )
  }

  const baselineLayout = baseline.slots.map(([index, type]) => [index, type])
  const nextLayout = snapshot.slots.map(([index, type]) => [index, type])
  if (
    !serializedValuesEqual(baselineLayout, nextLayout) ||
    !serializedValuesEqual(baseline.vars, snapshot.vars)
  ) {
    throw new Error(`[fict] Cannot merge SSR snapshot scope "${scopeId}": hook layout changed.`)
  }
}

function isScopeAtServerBaseline(entry: ResumedScopeEntry, baseline: ScopeSnapshot): boolean {
  try {
    const record: ScopeRecord = {
      id: baseline.id,
      ctx: entry.ctx,
      host: entry.host,
    }
    if (entry.ctx.scopeType !== undefined) {
      record.type = entry.ctx.scopeType
    }
    if (entry.props !== undefined) {
      record.props = entry.props
    }
    return serializedValuesEqual(serializeScopeRecord(record), baseline)
  } catch {
    // Values that can no longer be serialized are necessarily client-owned.
    return false
  }
}

interface SerializedComparisonState {
  leftToRight: WeakMap<object, object>
  rightToLeft: WeakMap<object, object>
}

function serializedValuesEqual(
  left: unknown,
  right: unknown,
  compared: SerializedComparisonState = {
    leftToRight: new WeakMap<object, object>(),
    rightToLeft: new WeakMap<object, object>(),
  },
): boolean {
  if (Object.is(left, right) && (left === null || typeof left !== 'object')) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }

  const mappedRight = compared.leftToRight.get(left)
  if (mappedRight !== undefined) return mappedRight === right
  const mappedLeft = compared.rightToLeft.get(right)
  if (mappedLeft !== undefined) return mappedLeft === left
  compared.leftToRight.set(left, right)
  compared.rightToLeft.set(right, left)

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index++) {
      if (
        Object.prototype.hasOwnProperty.call(left, index) !==
        Object.prototype.hasOwnProperty.call(right, index)
      ) {
        return false
      }
      if (
        Object.prototype.hasOwnProperty.call(left, index) &&
        !serializedValuesEqual(left[index], right[index], compared)
      ) {
        return false
      }
    }
    return true
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false
    if (!serializedValuesEqual(leftRecord[key], rightRecord[key], compared)) return false
  }
  return true
}

function isComponentMetaTarget(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

export function __fictSetComponentMeta(component: unknown, meta: ComponentMeta): void {
  if (!isComponentMetaTarget(component)) return
  componentMetaRegistry.set(component, meta)
}

export function __fictGetComponentMeta(component: unknown): ComponentMeta | undefined {
  if (!isComponentMetaTarget(component)) return undefined
  return (
    componentMetaRegistry.get(component) ?? (component as { __fictMeta?: ComponentMeta }).__fictMeta
  )
}

function appendQrlFlags(qrl: string, flags?: string | string[]): string {
  const flagList = Array.isArray(flags) ? flags : flags ? [flags] : []
  if (flagList.length === 0) return qrl
  return `${qrl}[${flagList.join(',')}]`
}

function decodeFileModulePath(moduleId: string): string {
  try {
    const url = new URL(moduleId)
    if (url.protocol !== 'file:') return moduleId.slice('file://'.length)
    const hostPrefix = url.hostname ? `//${url.hostname}` : ''
    return decodeURIComponent(`${hostPrefix}${url.pathname}`)
  } catch {
    return moduleId.slice('file://'.length)
  }
}

function normalizeFsPathForQrl(value: string): string {
  let normalized = value.replace(/\\/g, '/')
  if (/^\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(1)
  }
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

function stripQrlBase(filePath: string, ssrBase: string): string | null {
  const normalizedFilePath = normalizeFsPathForQrl(filePath)
  const normalizedBase = normalizeFsPathForQrl(ssrBase)
  if (normalizedBase === '/') {
    return normalizedFilePath.startsWith('/') ? normalizedFilePath : null
  }
  if (normalizedFilePath === normalizedBase) return '/'
  if (normalizedFilePath.startsWith(`${normalizedBase}/`)) {
    return normalizedFilePath.slice(normalizedBase.length)
  }
  return null
}

function encodeQrlPath(pathname: string): string {
  return encodeURI(pathname).replace(/#/g, '%23').replace(/\?/g, '%3F')
}

export function __fictQrl(moduleId: string, exportName: string, flags?: string | string[]): string {
  const sessionManifest = __fictGetCurrentSSRSession()?.manifest
  const manifest =
    sessionManifest ??
    ((globalThis as Record<string, unknown>).__FICT_MANIFEST__ as
      | Record<string, string>
      | undefined)

  // Check manifest first (production builds)
  if (manifest?.[moduleId]) {
    return appendQrlFlags(`${manifest[moduleId]}#${exportName}`, flags)
  }

  // Handle file:// URLs for Vite dev mode SSR
  if (moduleId.startsWith('file://')) {
    const filePath = decodeFileModulePath(moduleId)

    // Check for configured SSR base path (project root)
    const ssrBase = (globalThis as Record<string, unknown>).__FICT_SSR_BASE__ as string | undefined
    if (ssrBase) {
      // Strip base to get relative path (e.g., /src/App.tsx)
      const relativePath = stripQrlBase(filePath, ssrBase)
      if (relativePath) {
        return appendQrlFlags(`${encodeQrlPath(relativePath)}#${exportName}`, flags)
      }
    }

    // Fallback: use Vite's /@fs/ convention for direct file system access
    return appendQrlFlags(
      `/@fs${encodeQrlPath(normalizeFsPathForQrl(filePath))}#${exportName}`,
      flags,
    )
  }

  return appendQrlFlags(`${moduleId}#${exportName}`, flags)
}

// Registry for resume functions to prevent tree-shaking.
const resumeFunctionRegistry = new Map<string, (...args: unknown[]) => unknown>()

/**
 * Register a resume function to prevent it from being tree-shaken.
 * This is called at module load time by compiled component code.
 */
export function __fictRegisterResume(key: string, fn: (...args: unknown[]) => unknown): void {
  resumeFunctionRegistry.set(key, fn)
}

/**
 * Get a registered resume function by name.
 * Used by the loader to find resume functions.
 */
export function __fictGetResume(key: string): ((...args: unknown[]) => unknown) | undefined {
  return resumeFunctionRegistry.get(key)
}

function serializeScopeRecord(record: ScopeRecord): ScopeSnapshot {
  const seen = new Map<object, string>()
  const snapshot: ScopeSnapshot = {
    id: record.id,
    slots: serializeSlots(record.ctx, seen),
  }
  if (record.type !== undefined) {
    snapshot.t = record.type
  }
  if (record.props !== undefined) {
    const rawProps = unwrapProps(record.props)
    const existingPath = seen.get(record.props) ?? seen.get(rawProps)
    if (existingPath !== undefined) {
      snapshot.props = { __t: 'ref', v: existingPath }
    } else {
      // The materialized object is a shallow snapshot view. Alias both forms of
      // the live props object to its snapshot path so self/circular references
      // still resolve to the restored outer props object.
      seen.set(record.props, '$.props')
      seen.set(rawProps, '$.props')
      snapshot.props = serializeValue(materializePropsForSnapshot(rawProps), seen, '$.props', {
        omitFunctionProperties: true,
      }) as Record<string, unknown>
    }
  }
  if (record.ctx.slotMap !== undefined) {
    snapshot.vars = record.ctx.slotMap
  }
  return snapshot
}

function serializeSlots(ctx: HookContext, seen = new Map<object, string>()): SlotSnapshot[] {
  const slots: SlotSnapshot[] = []
  const values = ctx.slots ?? []

  for (let i = 0; i < values.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(values, i)) {
      continue
    }

    const value = values[i]
    if (isSignal(value)) {
      let raw: unknown
      try {
        raw = (value as () => unknown)()
      } catch {
        // ignore signal read errors during SSR
        continue
      }
      slots.push([i, 'sig', serializeValue(raw, seen, `$[${i}]`)])
      continue
    }

    if (isStoreProxy(value)) {
      const raw = unwrapStore(value)
      slots.push([i, 'store', serializeValue(raw, seen, `$[${i}]`)])
      continue
    }

    if (typeof value === 'function') {
      continue
    }

    // Note: we don't skip undefined anymore since we can serialize it
    if (value === undefined) {
      slots.push([i, 'raw', serializeValue(undefined, seen, `$[${i}]`)])
      continue
    }

    // Fallback: serialize raw slot value with complex type support
    slots.push([i, 'raw', serializeValue(value, seen, `$[${i}]`)])
  }

  return slots
}

function createContextFromSnapshot(
  snapshot?: ScopeSnapshot,
  refs = new Map<string, unknown>(),
  signalAccessors = new Map<number, unknown>(),
  storeProxies = new Map<number, unknown>(),
  storeSetters = new Map<number, StoreSetter>(),
): HookContext {
  const ctx: HookContext = { slots: [], cursor: 0 }
  if (!snapshot) return ctx

  for (const slot of snapshot.slots) {
    const [index, type, value] = slot
    const path = `$[${index}]`
    const restored = deserializeValue(value, refs, path)
    if (type === 'sig') {
      const signal = createSignal(restored)
      ctx.slots[index] = signal
      signalAccessors.set(index, signal)
    } else if (type === 'store') {
      const [store, setStore] = createStore(restored as object)
      ctx.slots[index] = store
      storeProxies.set(index, store)
      storeSetters.set(index, setStore)
    } else {
      ctx.slots[index] = restored
    }
  }
  if (snapshot.vars) {
    ctx.slotMap = Object.assign(Object.create(null) as Record<string, number>, snapshot.vars)
  }

  return ctx
}

// ============================================================================
// Value Serialization - Complex Type Support
// ============================================================================

/**
 * Check if value has a serialization marker
 */
function isSerializedMarker(value: unknown): value is SerializedMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, '__t') &&
    typeof (value as SerializedMarker).__t === 'string'
  )
}

function assertSerializedMarkerArray(
  value: unknown,
  marker: 'm' | 's' | 'o',
  path: string,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`[fict] Invalid ${marker} marker at ${path}: expected an array.`)
  }
  assertDenseSerializedArray(value, path, `${marker} marker`)
}

function assertDenseSerializedArray(value: unknown[], path: string, label: string): void {
  const keys = Object.keys(value)
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    throw new Error(`[fict] Invalid ${label} at ${path}: expected a dense array.`)
  }
}

function assertSerializedKeyValueEntry(
  value: unknown,
  marker: 'm' | 'o',
  path: string,
  index: number,
): asserts value is [unknown, unknown] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(
      `[fict] Invalid ${marker} marker entry at ${path}[${index}]: expected a key-value tuple.`,
    )
  }
  assertDenseSerializedArray(value, `${path}[${index}]`, `${marker} marker entry`)
}

function assertSerializedKeyValueEntries(
  value: unknown[],
  marker: 'm' | 'o',
  path: string,
): asserts value is [unknown, unknown][] {
  for (let i = 0; i < value.length; i++) {
    assertSerializedKeyValueEntry(value[i], marker, path, i)
  }
}

function assertSerializedObjectKey(value: unknown, path: string, index: number): void {
  if (typeof value === 'string') return
  if (
    !isRecord(value) ||
    value.__t !== 'sym' ||
    !isRecord(value.v) ||
    (value.v.k !== 'g' && value.v.k !== 'w') ||
    typeof value.v.n !== 'string' ||
    (value.v.k === 'w' && !WELL_KNOWN_SYMBOL_BY_NAME.has(value.v.n))
  ) {
    throw new Error(
      `[fict] Invalid o marker key at ${path}[${index}]: expected a serialized string or symbol.`,
    )
  }
}

function serializeSymbol(value: symbol, path: string): SerializedMarker {
  const globalKey = Symbol.keyFor(value)
  if (globalKey !== undefined) {
    return { __t: 'sym', v: { k: 'g', n: globalKey } }
  }

  const wellKnownName = WELL_KNOWN_SYMBOLS.get(value)
  if (wellKnownName) {
    return { __t: 'sym', v: { k: 'w', n: wellKnownName } }
  }

  throw new Error(
    `[Fict] Cannot serialize local symbol at ${path}. Use Symbol.for(...) or a well-known Symbol for resumable snapshot values.`,
  )
}

function enumerableOwnSymbols(value: object): symbol[] {
  return Object.getOwnPropertySymbols(value).filter(symbol =>
    Object.prototype.propertyIsEnumerable.call(value, symbol),
  )
}

function hasOwnMarkerKey(value: object): boolean {
  return Object.prototype.hasOwnProperty.call(value, '__t')
}

function defineEnumerableDataProperty(target: object, key: string | symbol, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

function objectChildPath(path: string, key: string): string {
  return `${path}.${JSON.stringify(key)}`
}

function symbolChildPath(path: string, key: symbol): string {
  const globalKey = Symbol.keyFor(key)
  if (globalKey !== undefined) {
    return `${path}.@g${JSON.stringify(globalKey)}`
  }

  const wellKnownName = WELL_KNOWN_SYMBOLS.get(key)
  if (wellKnownName !== undefined) {
    return `${path}.@w${JSON.stringify(wellKnownName)}`
  }

  // Local symbols are rejected by serializeSymbol. Keep their diagnostic path
  // disjoint from string-key paths before that validation runs.
  return `${path}.@l${JSON.stringify(String(key))}`
}

function isArrayIndexKey(key: string): boolean {
  const index = Number(key)
  return Number.isInteger(index) && index >= 0 && index < 4294967295 && String(index) === key
}

function assertArraySerializableShape(value: unknown[], path: string): void {
  const extraKey = Object.keys(value).find(key => !isArrayIndexKey(key))
  if (extraKey !== undefined) {
    throw new Error(
      `[Fict] Cannot serialize array with enumerable non-index property at ${objectChildPath(
        path,
        extraKey,
      )}. Array snapshot values only support indexed elements.`,
    )
  }

  const symbolKey = enumerableOwnSymbols(value)[0]
  if (symbolKey !== undefined) {
    throw new Error(
      `[Fict] Cannot serialize array with enumerable symbol property at ${objectChildPath(
        path,
        String(symbolKey),
      )}. Array snapshot values only support indexed elements.`,
    )
  }
}

function assertNoEnumerableOwnExtras(value: object, path: string, typeName: string): void {
  const extraKey = Object.keys(value)[0]
  if (extraKey !== undefined) {
    throw new Error(
      `[Fict] Cannot serialize ${typeName} with enumerable own property at ${objectChildPath(
        path,
        extraKey,
      )}. ${typeName} snapshot values only support their built-in data.`,
    )
  }

  const symbolKey = enumerableOwnSymbols(value)[0]
  if (symbolKey !== undefined) {
    throw new Error(
      `[Fict] Cannot serialize ${typeName} with enumerable symbol property at ${objectChildPath(
        path,
        String(symbolKey),
      )}. ${typeName} snapshot values only support their built-in data.`,
    )
  }
}

function unsupportedObjectName(value: object): string {
  const ctor = (value as { constructor?: { name?: string } }).constructor
  if (ctor?.name) return ctor.name
  return Object.prototype.toString.call(value)
}

function serializeObjectEntries(
  value: object,
  seen: Map<object, string>,
  path: string,
  symbolKeys: symbol[],
  options: SerializeOptions,
): [unknown, unknown][] {
  const entries: [unknown, unknown][] = []
  for (const key of Object.keys(value)) {
    const serialized = serializeValue(
      (value as Record<string, unknown>)[key],
      seen,
      objectChildPath(path, key),
      forObjectProperty(options),
    )
    if (serialized !== undefined) {
      entries.push([key, serialized])
    }
  }
  for (const key of symbolKeys) {
    const keyPath = symbolChildPath(path, key)
    const serialized = serializeValue(
      (value as Record<symbol, unknown>)[key],
      seen,
      keyPath,
      forObjectProperty(options),
    )
    if (serialized !== undefined) {
      entries.push([serializeSymbol(key, keyPath), serialized])
    }
  }
  return entries
}

/**
 * Serialize a value with support for complex types.
 * Handles: Date, Map, Set, RegExp, Symbol.for/well-known Symbol, undefined, NaN, Infinity, -Infinity, BigInt, circular references
 */
export function serializeValue(
  value: unknown,
  seen = new Map<object, string>(),
  path = '$',
  options: SerializeOptions = {},
): unknown {
  // Handle primitives that JSON can't represent correctly
  if (value === undefined) {
    return { __t: 'u' } as SerializedMarker
  }

  if (typeof value === 'number') {
    if (Object.is(value, -0)) {
      return { __t: '-0' } as SerializedMarker
    }
    if (Number.isNaN(value)) {
      return { __t: 'n' } as SerializedMarker
    }
    if (value === Infinity) {
      return { __t: '+i' } as SerializedMarker
    }
    if (value === -Infinity) {
      return { __t: '-i' } as SerializedMarker
    }
    return value
  }

  if (typeof value === 'bigint') {
    return { __t: 'b', v: value.toString() } as SerializedMarker
  }

  if (typeof value === 'symbol') {
    return serializeSymbol(value, path)
  }

  // Primitives that JSON handles correctly
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value
  }

  if (typeof value === 'function') {
    if (options.omitCurrentFunction) {
      return undefined
    }
    throw new Error(
      `[Fict] Cannot serialize function at ${path}. Functions cannot be stored in resumable snapshot values.`,
    )
  }

  // Handle objects - check for circular references first
  if (typeof value === 'object') {
    // Check for circular reference
    if (seen.has(value)) {
      return { __t: 'ref', v: seen.get(value)! } as SerializedMarker
    }

    // Date
    if (value instanceof Date) {
      assertNoEnumerableOwnExtras(value, path, 'Date')
      seen.set(value, path)
      const time = value.getTime()
      return { __t: 'd', v: Number.isNaN(time) ? 'invalid' : time } as SerializedMarker
    }

    // RegExp
    if (value instanceof RegExp) {
      assertNoEnumerableOwnExtras(value, path, 'RegExp')
      seen.set(value, path)
      return {
        __t: 'r',
        v: { s: value.source, f: value.flags, l: value.lastIndex },
      } as SerializedMarker
    }

    // Map
    if (value instanceof Map) {
      assertNoEnumerableOwnExtras(value, path, 'Map')
      seen.set(value, path)
      const entries: [unknown, unknown][] = []
      let i = 0
      for (const [k, v] of value) {
        entries.push([
          serializeValue(k, seen, `${path}.k${i}`, forContainerValue(options)),
          serializeValue(v, seen, `${path}.v${i}`, forContainerValue(options)),
        ])
        i++
      }
      return { __t: 'm', v: entries } as SerializedMarker
    }

    // Set
    if (value instanceof Set) {
      assertNoEnumerableOwnExtras(value, path, 'Set')
      seen.set(value, path)
      const items: unknown[] = []
      let i = 0
      for (const item of value) {
        items.push(serializeValue(item, seen, `${path}[${i}]`, forContainerValue(options)))
        i++
      }
      return { __t: 's', v: items } as SerializedMarker
    }

    // Array
    if (Array.isArray(value)) {
      seen.set(value, path)
      assertArraySerializableShape(value, path)
      return Array.from({ length: value.length }, (_, i) =>
        Object.prototype.hasOwnProperty.call(value, i)
          ? serializeValue(value[i], seen, `${path}[${i}]`, forContainerValue(options))
          : ({ __t: 'h' } as SerializedMarker),
      )
    }

    // Plain object
    seen.set(value, path)
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(
        `[Fict] Cannot serialize unsupported object at ${path}: ${unsupportedObjectName(
          value,
        )}. Use a plain object or a supported built-in resumable type.`,
      )
    }

    const symbolKeys = enumerableOwnSymbols(value)
    if (symbolKeys.length > 0 || proto === null || hasOwnMarkerKey(value)) {
      const marker: Extract<SerializedMarker, { __t: 'o' }> = {
        __t: 'o',
        v: serializeObjectEntries(value, seen, path, symbolKeys, options),
      }
      if (proto === null) marker.p = 'n'
      return marker
    }

    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      const serialized = serializeValue(
        (value as Record<string, unknown>)[key],
        seen,
        objectChildPath(path, key),
        forObjectProperty(options),
      )
      if (serialized !== undefined) {
        defineEnumerableDataProperty(result, key, serialized)
      }
    }
    return result
  }

  return value
}

function forObjectProperty(options: SerializeOptions): SerializeOptions {
  if (!options.omitFunctionProperties) return options
  return { ...options, omitCurrentFunction: true }
}

function forContainerValue(options: SerializeOptions): SerializeOptions {
  if (!options.omitCurrentFunction) return options
  return { ...options, omitCurrentFunction: false }
}

/**
 * Deserialize a value, restoring complex types from their serialized form.
 */
export function deserializeValue(
  value: unknown,
  refs = new Map<string, unknown>(),
  path = '$',
): unknown {
  // Handle null
  if (value === null) {
    return null
  }

  // Handle primitives
  if (typeof value !== 'object') {
    return value
  }

  // Check for serialization markers
  if (isSerializedMarker(value)) {
    switch (value.__t) {
      case 'u':
        return undefined
      case 'n':
        return NaN
      case '-0':
        return -0
      case '+i':
        return Infinity
      case '-i':
        return -Infinity
      case 'b':
        return BigInt(value.v)
      case 'd': {
        const date = value.v === 'invalid' ? new Date(NaN) : new Date(value.v)
        refs.set(path, date)
        return date
      }
      case 'r': {
        const regex = new RegExp(value.v.s, value.v.f)
        if (typeof value.v.l === 'number') {
          regex.lastIndex = value.v.l
        }
        refs.set(path, regex)
        return regex
      }
      case 'sym':
        if (value.v.k === 'g') {
          return Symbol.for(value.v.n)
        }
        {
          const symbol = WELL_KNOWN_SYMBOL_BY_NAME.get(value.v.n)
          if (symbol === undefined) {
            throw new Error(`[fict] Unknown well-known symbol marker at ${path}: ${value.v.n}.`)
          }
          return symbol
        }
      case 'o': {
        assertSerializedMarkerArray(value.v, 'o', path)
        assertSerializedKeyValueEntries(value.v, 'o', path)
        if (value.p !== undefined && value.p !== 'n') {
          throw new Error(`[fict] Invalid o marker at ${path}: invalid prototype.`)
        }
        for (let i = 0; i < value.v.length; i++) {
          assertSerializedObjectKey(value.v[i]![0], path, i)
        }
        const obj: Record<string | symbol, unknown> = value.p === 'n' ? Object.create(null) : {}
        refs.set(path, obj)
        for (let i = 0; i < value.v.length; i++) {
          const entry = value.v[i]!
          const [rawKey, rawValue] = entry
          const key = deserializeValue(rawKey, refs, `${path}.key${i}`)
          if (typeof key !== 'string' && typeof key !== 'symbol') {
            throw new Error(`[fict] Invalid o marker key at ${path}[${i}].`)
          }
          defineEnumerableDataProperty(
            obj,
            key,
            deserializeValue(
              rawValue,
              refs,
              typeof key === 'symbol' ? symbolChildPath(path, key) : objectChildPath(path, key),
            ),
          )
        }
        return obj
      }
      case 'm': {
        assertSerializedMarkerArray(value.v, 'm', path)
        assertSerializedKeyValueEntries(value.v, 'm', path)
        const map = new Map<unknown, unknown>()
        refs.set(path, map)
        for (let i = 0; i < value.v.length; i++) {
          const entry = value.v[i]!
          const [k, v] = entry
          map.set(
            deserializeValue(k, refs, `${path}.k${i}`),
            deserializeValue(v, refs, `${path}.v${i}`),
          )
        }
        return map
      }
      case 's': {
        assertSerializedMarkerArray(value.v, 's', path)
        const set = new Set<unknown>()
        refs.set(path, set)
        for (let i = 0; i < value.v.length; i++) {
          set.add(deserializeValue(value.v[i], refs, `${path}[${i}]`))
        }
        return set
      }
      case 'ref':
        if (!refs.has(value.v)) {
          throw new Error(`[fict] Invalid snapshot reference at ${path}: ${value.v}.`)
        }
        return refs.get(value.v)
    }
  }

  // Handle arrays
  if (Array.isArray(value)) {
    assertDenseSerializedArray(value, path, 'serialized array')
    const arr: unknown[] = new Array(value.length)
    refs.set(path, arr)
    for (let i = 0; i < value.length; i++) {
      const item = value[i]
      if (isSerializedMarker(item) && item.__t === 'h') continue
      arr[i] = deserializeValue(item, refs, `${path}[${i}]`)
    }
    return arr
  }

  // Handle plain objects
  const obj: Record<string, unknown> = {}
  refs.set(path, obj)
  for (const key of Object.keys(value)) {
    defineEnumerableDataProperty(
      obj,
      key,
      deserializeValue((value as Record<string, unknown>)[key], refs, objectChildPath(path, key)),
    )
  }
  return obj
}
