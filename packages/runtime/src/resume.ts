import type { HookContext } from './hooks'
import { createSignal, isSignal } from './signal'
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
  | { __t: 'd'; v: number } // Date (as timestamp)
  | { __t: 'm'; v: [unknown, unknown][] } // Map (as entries array)
  | { __t: 's'; v: unknown[] } // Set (as array)
  | { __t: 'r'; v: { s: string; f: string } } // RegExp (source + flags)
  | { __t: 'u' } // undefined
  | { __t: 'n' } // NaN
  | { __t: '+i' } // Infinity
  | { __t: '-i' } // -Infinity
  | { __t: 'b'; v: string } // BigInt (as string)
  | { __t: 'ref'; v: string } // Circular reference (path)

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

export const FICT_SSR_SNAPSHOT_SCHEMA_VERSION = 1

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

let resumableEnabled = false
let hydrating = false
const defaultSSRSession = __fictCreateSSRSession()
const resumedScopes = new Map<
  string,
  { ctx: HookContext; host: Element; props?: Record<string, unknown> }
>()

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

function setSnapshotState(state: SSRState | null): void {
  getSSRSession().snapshotState = state
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

export function __fictIsResumable(): boolean {
  return getSSRSession().ssrEnabled || resumableEnabled
}

export function __fictIsSSR(): boolean {
  return getSSRSession().ssrEnabled
}

export function __fictEnterHydration(): void {
  hydrating = true
}

export function __fictExitHydration(): void {
  hydrating = false
}

export function __fictIsHydrating(): boolean {
  return hydrating
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
  const id = `s${++session.scopeCounter}`
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
    const snapshot: ScopeSnapshot = {
      id,
      slots: serializeSlots(record.ctx),
    }
    if (record.type !== undefined) {
      snapshot.t = record.type
    }
    if (record.props !== undefined) {
      snapshot.props = record.props
    }
    if (record.ctx.slotMap !== undefined) {
      snapshot.vars = record.ctx.slotMap
    }
    scopes[id] = snapshot
  }

  return { v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION, scopes }
}

export function __fictSerializeSSRStateForScopes(scopeIds: Iterable<string>): SSRState {
  const scopes: Record<string, ScopeSnapshot> = {}

  for (const id of scopeIds) {
    const record = getScopeRegistry().get(id)
    if (!record) continue
    const snapshot: ScopeSnapshot = {
      id,
      slots: serializeSlots(record.ctx),
    }
    if (record.type !== undefined) {
      snapshot.t = record.type
    }
    if (record.props !== undefined) {
      snapshot.props = record.props
    }
    if (record.ctx.slotMap !== undefined) {
      snapshot.vars = record.ctx.slotMap
    }
    scopes[id] = snapshot
  }

  return { v: FICT_SSR_SNAPSHOT_SCHEMA_VERSION, scopes }
}

export function __fictSetSSRState(state: SSRState | null): void {
  setSnapshotState(state)
  if (!state) {
    resumedScopes.clear()
  }
}

export function __fictMergeSSRState(state: SSRState | null): void {
  if (!state) return
  const snapshotState = getSnapshotState()
  if (!snapshotState) {
    setSnapshotState({ v: state.v, scopes: { ...state.scopes } })
    return
  }
  Object.assign(snapshotState.scopes, state.scopes)
}

export function __fictGetSSRScope(id: string): ScopeSnapshot | undefined {
  return getSnapshotState()?.scopes[id]
}

export function __fictEnsureScope(
  scopeId: string,
  host: Element,
  snapshot?: ScopeSnapshot,
): HookContext {
  const existing = resumedScopes.get(scopeId)
  if (existing) return existing.ctx

  const ctx = createContextFromSnapshot(snapshot)
  ctx.scopeId = scopeId
  if (snapshot?.t !== undefined) {
    ctx.scopeType = snapshot.t
  }
  const entry: { ctx: HookContext; host: Element; props?: Record<string, unknown> } = { ctx, host }
  if (snapshot?.props !== undefined) {
    entry.props = snapshot.props
  }
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
  return names.map(name => ctx.slots[map[name] ?? -1])
}

export function __fictGetScopeProps(scopeId: string): Record<string, unknown> | undefined {
  return resumedScopes.get(scopeId)?.props
}

export function __fictQrl(moduleId: string, exportName: string): string {
  const sessionManifest = __fictGetCurrentSSRSession()?.manifest
  const manifest =
    sessionManifest ??
    ((globalThis as Record<string, unknown>).__FICT_MANIFEST__ as
      | Record<string, string>
      | undefined)

  // Check manifest first (production builds)
  if (manifest?.[moduleId]) {
    return `${manifest[moduleId]}#${exportName}`
  }

  // Handle file:// URLs for Vite dev mode SSR
  if (moduleId.startsWith('file://')) {
    const filePath = moduleId.slice(7) // Remove 'file://'

    // Check for configured SSR base path (project root)
    const ssrBase = (globalThis as Record<string, unknown>).__FICT_SSR_BASE__ as string | undefined
    if (ssrBase) {
      // Strip base to get relative path (e.g., /src/App.tsx)
      if (filePath.startsWith(ssrBase)) {
        const relativePath = filePath.slice(ssrBase.length)
        return `${relativePath}#${exportName}`
      }
    }

    // Fallback: use Vite's /@fs/ convention for direct file system access
    return `/@fs${filePath}#${exportName}`
  }

  return `${moduleId}#${exportName}`
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

function serializeSlots(ctx: HookContext): SlotSnapshot[] {
  const slots: SlotSnapshot[] = []
  const values = ctx.slots ?? []
  // Share the 'seen' map across all slots to handle cross-slot circular references
  const seen = new Map<object, string>()

  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    // Note: we don't skip undefined anymore since we can serialize it
    if (value === undefined) {
      slots.push([i, 'raw', serializeValue(undefined, seen, `$[${i}]`)])
      continue
    }

    if (isSignal(value)) {
      try {
        const raw = (value as () => unknown)()
        slots.push([i, 'sig', serializeValue(raw, seen, `$[${i}]`)])
      } catch {
        // ignore signal read errors during SSR
      }
      continue
    }

    if (isStoreProxy(value)) {
      const raw = unwrapStore(value)
      slots.push([i, 'store', serializeValue(raw, seen, `$[${i}]`)])
      continue
    }

    // Fallback: serialize raw slot value with complex type support
    slots.push([i, 'raw', serializeValue(value, seen, `$[${i}]`)])
  }

  return slots
}

function createContextFromSnapshot(snapshot?: ScopeSnapshot): HookContext {
  const ctx: HookContext = { slots: [], cursor: 0 }
  if (!snapshot) return ctx

  for (const slot of snapshot.slots) {
    const [index, type, value] = slot
    if (type === 'sig') {
      ctx.slots[index] = createSignal(deserializeValue(value))
    } else if (type === 'store') {
      ctx.slots[index] = createStore(deserializeValue(value) as object)[0]
    } else {
      ctx.slots[index] = deserializeValue(value)
    }
  }
  if (snapshot.vars) {
    ctx.slotMap = { ...snapshot.vars }
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
    '__t' in value &&
    typeof (value as SerializedMarker).__t === 'string'
  )
}

/**
 * Serialize a value with support for complex types.
 * Handles: Date, Map, Set, RegExp, undefined, NaN, Infinity, -Infinity, BigInt, circular references
 */
export function serializeValue(
  value: unknown,
  seen = new Map<object, string>(),
  path = '$',
): unknown {
  // Handle primitives that JSON can't represent correctly
  if (value === undefined) {
    return { __t: 'u' } as SerializedMarker
  }

  if (typeof value === 'number') {
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

  // Primitives that JSON handles correctly
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value
  }

  // Handle functions - can't serialize, skip
  if (typeof value === 'function') {
    return undefined
  }

  // Handle objects - check for circular references first
  if (typeof value === 'object') {
    // Check for circular reference
    if (seen.has(value)) {
      return { __t: 'ref', v: seen.get(value)! } as SerializedMarker
    }

    // Date
    if (value instanceof Date) {
      return { __t: 'd', v: value.getTime() } as SerializedMarker
    }

    // RegExp
    if (value instanceof RegExp) {
      return { __t: 'r', v: { s: value.source, f: value.flags } } as SerializedMarker
    }

    // Map
    if (value instanceof Map) {
      seen.set(value, path)
      const entries: [unknown, unknown][] = []
      let i = 0
      for (const [k, v] of value) {
        entries.push([
          serializeValue(k, seen, `${path}.k${i}`),
          serializeValue(v, seen, `${path}.v${i}`),
        ])
        i++
      }
      return { __t: 'm', v: entries } as SerializedMarker
    }

    // Set
    if (value instanceof Set) {
      seen.set(value, path)
      const items: unknown[] = []
      let i = 0
      for (const item of value) {
        items.push(serializeValue(item, seen, `${path}[${i}]`))
        i++
      }
      return { __t: 's', v: items } as SerializedMarker
    }

    // Array
    if (Array.isArray(value)) {
      seen.set(value, path)
      return value.map((item, i) => serializeValue(item, seen, `${path}[${i}]`))
    }

    // Plain object
    seen.set(value, path)
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      const serialized = serializeValue(
        (value as Record<string, unknown>)[key],
        seen,
        `${path}.${key}`,
      )
      if (serialized !== undefined) {
        result[key] = serialized
      }
    }
    return result
  }

  return value
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
      case '+i':
        return Infinity
      case '-i':
        return -Infinity
      case 'b':
        return BigInt(value.v)
      case 'd':
        return new Date(value.v)
      case 'r':
        return new RegExp(value.v.s, value.v.f)
      case 'm': {
        const map = new Map<unknown, unknown>()
        refs.set(path, map)
        for (let i = 0; i < value.v.length; i++) {
          const entry = value.v[i]
          if (!entry) continue
          const [k, v] = entry
          map.set(
            deserializeValue(k, refs, `${path}.k${i}`),
            deserializeValue(v, refs, `${path}.v${i}`),
          )
        }
        return map
      }
      case 's': {
        const set = new Set<unknown>()
        refs.set(path, set)
        for (let i = 0; i < value.v.length; i++) {
          set.add(deserializeValue(value.v[i], refs, `${path}[${i}]`))
        }
        return set
      }
      case 'ref':
        return refs.get(value.v)
    }
  }

  // Handle arrays
  if (Array.isArray(value)) {
    const arr: unknown[] = []
    refs.set(path, arr)
    for (let i = 0; i < value.length; i++) {
      arr.push(deserializeValue(value[i], refs, `${path}[${i}]`))
    }
    return arr
  }

  // Handle plain objects
  const obj: Record<string, unknown> = {}
  refs.set(path, obj)
  for (const key of Object.keys(value)) {
    obj[key] = deserializeValue((value as Record<string, unknown>)[key], refs, `${path}.${key}`)
  }
  return obj
}
