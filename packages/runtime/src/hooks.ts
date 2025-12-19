import { createEffect } from './effect'
import { createMemo } from './memo'
import { createSignal, type SignalAccessor, type ComputedAccessor } from './signal'

interface HookContext {
  slots: unknown[]
}

const ctxStack: HookContext[] = []

export function __fictUseContext(): HookContext {
  if (ctxStack.length === 0) {
    const ctx: HookContext = { slots: [] }
    ctxStack.push(ctx)
    return ctx
  }
  return ctxStack[ctxStack.length - 1]!
}

export function __fictPushContext(): HookContext {
  const ctx: HookContext = { slots: [] }
  ctxStack.push(ctx)
  return ctx
}

export function __fictPopContext(): void {
  ctxStack.pop()
}

export function __fictResetContext(): void {
  ctxStack.length = 0
}

export function __fictUseSignal<T>(ctx: HookContext, initial: T, slot: number): SignalAccessor<T> {
  if (!ctx.slots[slot]) {
    const base = createSignal(initial)
    const wrapped = ((...args: [T?]) => {
      if (args.length === 0) {
        return base()
      }
      return base(args[0] as T)
    }) as SignalAccessor<T>
    ctx.slots[slot] = wrapped
  }
  return ctx.slots[slot] as SignalAccessor<T>
}

export function __fictUseMemo<T>(ctx: HookContext, fn: () => T, slot: number): ComputedAccessor<T> {
  if (!ctx.slots[slot]) {
    ctx.slots[slot] = createMemo(fn)
  }
  return ctx.slots[slot] as ComputedAccessor<T>
}

export function __fictUseEffect(ctx: HookContext, fn: () => void, slot: number): void {
  if (!ctx.slots[slot]) {
    ctx.slots[slot] = createEffect(fn)
  }
}

export function __fictRender<T>(ctx: HookContext, fn: () => T): T {
  ctxStack.push(ctx)
  try {
    return fn()
  } finally {
    ctxStack.pop()
  }
}
