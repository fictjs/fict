import { afterEach, describe, expect, it } from 'vitest'
import { __fictCreateAsyncSource } from '../src/async-source'
import { AsyncDisposedError, isAsyncPending } from '../src/async-state'
import { createEffect } from '../src/effect'
import { createRoot, registerSuspenseHandler } from '../src/lifecycle'
import { __resetReactiveState, flush, getActiveSub, type ReactiveNode } from '../src/signal'

const disposers: (() => void)[] = []
afterEach(() => {
  while (disposers.length) disposers.pop()!()
  __resetReactiveState()
})

describe('async graph sources for query policies', () => {
  it('publishes readiness and values through one computed node', () => {
    const source = __fictCreateAsyncSource<number>()
    disposers.push(source.dispose)
    const generation = source.begin()
    const values: number[] = []
    let consumer!: ReactiveNode
    const owner = createRoot(() => {
      registerSuspenseHandler(token => isAsyncPending(token))
      createEffect(() => {
        consumer = getActiveSub()!
        values.push(source.read())
      })
    })
    disposers.push(owner.dispose)
    expect(consumer.deps?.nextDep).toBeUndefined()
    const node = consumer.deps!.dep
    expect('getter' in node).toBe(true)
    expect(node.deps).toBeUndefined()
    source.resolve(generation, 3)
    flush()
    expect(values).toEqual([3])
    expect(consumer.deps?.dep).toBe(node)
  })

  it('supports cache reset without retaining a superseded value or accepting stale work', () => {
    const source = __fictCreateAsyncSource<number>()
    disposers.push(source.dispose)
    const first = source.begin()
    expect(source.resolve(first, 1)).toBe(true)
    const second = source.begin(false)
    expect(source.state()).toMatchObject({ status: 'pending', hasValue: false, value: undefined })
    expect(source.resolve(first, 9)).toBe(false)
    expect(source.reject(second, undefined)).toBe(true)
    expect(source.state()).toMatchObject({ status: 'errored', hasValue: false, error: undefined })
    const third = source.begin()
    source.resolve(third, 2)
    expect(source.read()).toBe(2)
  })

  it('keeps cache ownership separate from readers and wakes disposed waiters', async () => {
    let source!: ReturnType<typeof __fictCreateAsyncSource<string>>
    const owner = createRoot(() => {
      source = __fictCreateAsyncSource<string>()
      source.begin()
    })
    const token = source.peek().pending!
    owner.dispose()
    expect(source.peek().status).toBe('pending')
    source.dispose()
    await token
    expect(source.peek().status).toBe('disposed')
    expect(() => source.read()).toThrow(AsyncDisposedError)
    expect(() => source.begin()).toThrow(AsyncDisposedError)
    expect(source.resolve(1, 'late')).toBe(false)
  })
})
