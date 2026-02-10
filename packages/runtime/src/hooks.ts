import { createEffect } from './effect'
import { createMemo } from './memo'
import {
  createSignal,
  type SignalAccessor,
  type ComputedAccessor,
  type EffectOptions,
  type MemoOptions,
  type SignalOptions,
} from './signal'

const isDev =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'

export interface HookContext {
  slots: unknown[]
  cursor: number
  rendering?: boolean
  componentId?: number
  parentId?: number
  scopeId?: string
  scopeType?: string
  slotMap?: Record<string, number>
}

const ctxStack: HookContext[] = []
let preparedContext: HookContext | null = null

function assertRenderContext(ctx: HookContext, hookName: string): void {
  if (!ctx.rendering) {
    const message = isDev
      ? `${hookName} can only be used during render execution`
      : 'FICT:E_HOOK_RENDER'
    throw new Error(message)
  }
}

export function __fictUseContext(): HookContext {
  if (ctxStack.length === 0) {
    // fix: Don't silently create context when called outside render.
    // This would cause a memory leak and undefined behavior.
    const message = isDev
      ? 'Invalid hook call: hooks can only be used while rendering a component. ' +
        'Make sure you are not calling hooks in event handlers or outside of components.'
      : 'FICT:E_HOOK_OUTSIDE_RENDER'
    throw new Error(message)
  }
  const ctx = ctxStack[ctxStack.length - 1]!
  // fix: Only reset cursor when starting a new render, not during an existing render.
  // This allows custom hooks to share the same hook slot sequence as the calling component,
  // similar to React's "rules of hooks" where hooks are called in consistent order.
  if (!ctx.rendering) {
    ctx.cursor = 0
    ctx.rendering = true
  }
  return ctx
}

export function __fictPushContext(): HookContext {
  const ctx: HookContext = preparedContext ?? { slots: [], cursor: 0 }
  preparedContext = null
  ctxStack.push(ctx)
  return ctx
}

export function __fictPrepareContext(ctx: HookContext): void {
  preparedContext = ctx
}

export function __fictGetCurrentComponentId(): number | undefined {
  return ctxStack[ctxStack.length - 1]?.componentId
}

export function __fictPopContext(): void {
  // fix: Reset rendering flag when popping to avoid state leakage
  const ctx = ctxStack.pop()
  if (ctx) ctx.rendering = false
}

export function __fictResetContext(): void {
  ctxStack.length = 0
}

export function __fictUseSignal<T>(
  ctx: HookContext,
  initial: T,
  optionsOrSlot?: number | SignalOptions<T>,
  slot?: number,
): SignalAccessor<T> {
  assertRenderContext(ctx, '__fictUseSignal')
  const options = typeof optionsOrSlot === 'number' ? undefined : optionsOrSlot
  const resolvedSlot = typeof optionsOrSlot === 'number' ? optionsOrSlot : slot
  const index = resolvedSlot ?? ctx.cursor++
  if (!ctx.slots[index]) {
    ctx.slots[index] = createSignal(initial, options)
  }
  if (options?.name) {
    if (!ctx.slotMap) ctx.slotMap = {}
    ctx.slotMap[options.name] = index
  }
  return ctx.slots[index] as SignalAccessor<T>
}

export function __fictUseMemo<T>(
  ctx: HookContext,
  fn: () => T,
  optionsOrSlot?: number | MemoOptions<T>,
  slot?: number,
): ComputedAccessor<T> {
  assertRenderContext(ctx, '__fictUseMemo')
  const options = typeof optionsOrSlot === 'number' ? undefined : optionsOrSlot
  const resolvedSlot = typeof optionsOrSlot === 'number' ? optionsOrSlot : slot
  const index = resolvedSlot ?? ctx.cursor++
  if (!ctx.slots[index]) {
    ctx.slots[index] = createMemo(fn, options)
  }
  return ctx.slots[index] as ComputedAccessor<T>
}

export function __fictUseEffect(
  ctx: HookContext,
  fn: () => void,
  optionsOrSlot?: number | EffectOptions,
  slot?: number,
): void {
  const options = typeof optionsOrSlot === 'number' ? undefined : optionsOrSlot
  const resolvedSlot = typeof optionsOrSlot === 'number' ? optionsOrSlot : slot
  // fix: When a slot number is provided, we trust the compiler has allocated this slot.
  // This allows effects inside conditional callbacks to work even outside render context.
  // The slot number proves this is a known, statically-allocated effect location.
  if (resolvedSlot !== undefined) {
    if (ctx.slots[resolvedSlot]) {
      // Effect already exists, nothing to do
      return
    }
    // Create the effect even outside render context - the slot number proves validity
    ctx.slots[resolvedSlot] = createEffect(fn, options)
    return
  }

  // For cursor-based allocation (no slot number), we need render context
  assertRenderContext(ctx, '__fictUseEffect')
  const index = ctx.cursor++
  if (!ctx.slots[index]) {
    ctx.slots[index] = createEffect(fn, options)
  }
}

export function __fictRender<T>(ctx: HookContext, fn: () => T): T {
  ctxStack.push(ctx)
  ctx.cursor = 0
  ctx.rendering = true
  try {
    return fn()
  } finally {
    ctx.rendering = false
    ctxStack.pop()
  }
}
