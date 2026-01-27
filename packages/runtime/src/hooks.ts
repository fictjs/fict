import { createEffect } from './effect'
import { createMemo } from './memo'
import { createSignal, type SignalAccessor, type ComputedAccessor } from './signal'

const isDev =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process === 'undefined' || process.env?.NODE_ENV !== 'production'

interface HookContext {
  slots: unknown[]
  cursor: number
  rendering?: boolean
}

const ctxStack: HookContext[] = []

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
    // P0-2 fix: Don't silently create context when called outside render.
    // This would cause a memory leak and undefined behavior.
    const message = isDev
      ? 'Invalid hook call: hooks can only be used while rendering a component. ' +
        'Make sure you are not calling hooks in event handlers or outside of components.'
      : 'FICT:E_HOOK_OUTSIDE_RENDER'
    throw new Error(message)
  }
  const ctx = ctxStack[ctxStack.length - 1]!
  // P0-2 fix: Only reset cursor when starting a new render, not during an existing render.
  // This allows custom hooks to share the same hook slot sequence as the calling component,
  // similar to React's "rules of hooks" where hooks are called in consistent order.
  if (!ctx.rendering) {
    ctx.cursor = 0
    ctx.rendering = true
  }
  return ctx
}

export function __fictPushContext(): HookContext {
  const ctx: HookContext = { slots: [], cursor: 0 }
  ctxStack.push(ctx)
  return ctx
}

export function __fictPopContext(): void {
  // P0-2 fix: Reset rendering flag when popping to avoid state leakage
  const ctx = ctxStack.pop()
  if (ctx) ctx.rendering = false
}

export function __fictResetContext(): void {
  ctxStack.length = 0
}

export function __fictUseSignal<T>(ctx: HookContext, initial: T, slot?: number): SignalAccessor<T> {
  assertRenderContext(ctx, '__fictUseSignal')
  const index = slot ?? ctx.cursor++
  if (!ctx.slots[index]) {
    ctx.slots[index] = createSignal(initial)
  }
  return ctx.slots[index] as SignalAccessor<T>
}

export function __fictUseMemo<T>(
  ctx: HookContext,
  fn: () => T,
  slot?: number,
): ComputedAccessor<T> {
  assertRenderContext(ctx, '__fictUseMemo')
  const index = slot ?? ctx.cursor++
  if (!ctx.slots[index]) {
    ctx.slots[index] = createMemo(fn)
  }
  return ctx.slots[index] as ComputedAccessor<T>
}

export function __fictUseEffect(ctx: HookContext, fn: () => void, slot?: number): void {
  assertRenderContext(ctx, '__fictUseEffect')
  const index = slot ?? ctx.cursor++
  if (!ctx.slots[index]) {
    ctx.slots[index] = createEffect(fn)
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
