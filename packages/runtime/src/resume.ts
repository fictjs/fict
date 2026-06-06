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

  const refs = new Map<string, unknown>()
  const ctx = createContextFromSnapshot(snapshot, refs)
  ctx.scopeId = scopeId
  if (snapshot?.t !== undefined) {
    ctx.scopeType = snapshot.t
  }
  const entry: { ctx: HookContext; host: Element; props?: Record<string, unknown> } = { ctx, host }
  if (snapshot?.props !== undefined) {
    entry.props = deserializeValue(snapshot.props, refs, '$.props') as Record<string, unknown>
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
    snapshot.props = serializeValue(record.props, seen, '$.props', {
      omitFunctionProperties: true,
    }) as Record<string, unknown>
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
    if (typeof value === 'function') {
      continue
    }

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

function createContextFromSnapshot(
  snapshot?: ScopeSnapshot,
  refs = new Map<string, unknown>(),
): HookContext {
  const ctx: HookContext = { slots: [], cursor: 0 }
  if (!snapshot) return ctx

  for (const slot of snapshot.slots) {
    const [index, type, value] = slot
    const path = `$[${index}]`
    const restored = deserializeValue(value, refs, path)
    if (type === 'sig') {
      ctx.slots[index] = createSignal(restored)
    } else if (type === 'store') {
      ctx.slots[index] = createStore(restored as object)[0]
    } else {
      ctx.slots[index] = restored
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
    const keyPath = objectChildPath(path, String(key))
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
      const time = value.getTime()
      return { __t: 'd', v: Number.isNaN(time) ? 'invalid' : time } as SerializedMarker
    }

    // RegExp
    if (value instanceof RegExp) {
      assertNoEnumerableOwnExtras(value, path, 'RegExp')
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
      case 'd':
        return value.v === 'invalid' ? new Date(NaN) : new Date(value.v)
      case 'r': {
        const regex = new RegExp(value.v.s, value.v.f)
        if (typeof value.v.l === 'number') {
          regex.lastIndex = value.v.l
        }
        return regex
      }
      case 'sym':
        if (value.v.k === 'g') {
          return Symbol.for(value.v.n)
        }
        return WELL_KNOWN_SYMBOL_BY_NAME.get(value.v.n)
      case 'o': {
        const obj: Record<string | symbol, unknown> = value.p === 'n' ? Object.create(null) : {}
        refs.set(path, obj)
        for (let i = 0; i < value.v.length; i++) {
          const entry = value.v[i]
          if (!entry) continue
          const [rawKey, rawValue] = entry
          const key = deserializeValue(rawKey, refs, `${path}.key${i}`)
          if (typeof key !== 'string' && typeof key !== 'symbol') continue
          defineEnumerableDataProperty(
            obj,
            key,
            deserializeValue(rawValue, refs, objectChildPath(path, String(key))),
          )
        }
        return obj
      }
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
