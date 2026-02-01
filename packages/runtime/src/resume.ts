import { createSignal, isSignal } from './signal'
import { createStore, isStoreProxy, unwrapStore } from './store'
import type { HookContext } from './hooks'

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

export interface SSRState {
  scopes: Record<string, ScopeSnapshot>
}

export interface ScopeRecord {
  id: string
  ctx: HookContext
  host: Element
  type?: string
  props?: Record<string, unknown>
}

let ssrEnabled = false
let resumableEnabled = false
let hydrating = false
let scopeCounter = 0
let scopeRegistry = new Map<string, ScopeRecord>()
let snapshotState: SSRState | null = null
const resumedScopes = new Map<
  string,
  { ctx: HookContext; host: Element; props?: Record<string, unknown> }
>()

export function __fictEnableSSR(): void {
  ssrEnabled = true
  scopeCounter = 0
  scopeRegistry = new Map()
}

export function __fictDisableSSR(): void {
  ssrEnabled = false
}

export function __fictEnableResumable(): void {
  resumableEnabled = true
}

export function __fictDisableResumable(): void {
  resumableEnabled = false
}

export function __fictIsResumable(): boolean {
  return ssrEnabled || resumableEnabled
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

  const id = `s${++scopeCounter}`
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
  scopeRegistry.set(id, record)
  return id
}

export function __fictGetScopeRegistry(): Map<string, ScopeRecord> {
  return scopeRegistry
}

export function __fictSerializeSSRState(): SSRState {
  const scopes: Record<string, ScopeSnapshot> = {}

  for (const [id, record] of scopeRegistry.entries()) {
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

  return { scopes }
}

export function __fictSetSSRState(state: SSRState | null): void {
  snapshotState = state
}

export function __fictGetSSRScope(id: string): ScopeSnapshot | undefined {
  return snapshotState?.scopes[id]
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
  const manifest = (globalThis as Record<string, unknown>).__FICT_MANIFEST__ as
    | Record<string, string>
    | undefined
  const resolved = manifest?.[moduleId] ?? moduleId
  return `${resolved}#${exportName}`
}

function serializeSlots(ctx: HookContext): SlotSnapshot[] {
  const slots: SlotSnapshot[] = []
  const values = ctx.slots ?? []

  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (value === undefined) continue

    if (isSignal(value)) {
      try {
        slots.push([i, 'sig', (value as () => unknown)()])
      } catch {
        // ignore signal read errors during SSR
      }
      continue
    }

    if (isStoreProxy(value)) {
      slots.push([i, 'store', unwrapStore(value)])
      continue
    }

    // Fallback: attempt to serialize raw slot value
    slots.push([i, 'raw', value])
  }

  return slots
}

function createContextFromSnapshot(snapshot?: ScopeSnapshot): HookContext {
  const ctx: HookContext = { slots: [], cursor: 0 }
  if (!snapshot) return ctx

  for (const slot of snapshot.slots) {
    const [index, type, value] = slot
    if (type === 'sig') {
      ctx.slots[index] = createSignal(value)
    } else if (type === 'store') {
      ctx.slots[index] = createStore(value as object)[0]
    } else {
      ctx.slots[index] = value
    }
  }
  if (snapshot.vars) {
    ctx.slotMap = { ...snapshot.vars }
  }

  return ctx
}
