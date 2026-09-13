import { afterEach, describe, expect, it } from 'vitest'

import runtimeAbi from '../runtime-abi.json'
import * as internal from '../src/internal'
import * as list from '../src/internal/list'
import { createRootContext, destroyRoot, withRootContext } from '../src/lifecycle'
import type { HookContext } from '../src/hooks'

const modules = {
  internal: internal as Record<string, unknown>,
  list: list as Record<string, unknown>,
}

afterEach(() => internal.__resetReactiveState())

describe('runtime compiler ABI', () => {
  it('exports every manifest helper from its declared runtime subpath', () => {
    for (const helper of runtimeAbi.helpers) {
      expect(
        Object.prototype.hasOwnProperty.call(modules[helper.module], helper.export),
        `${helper.key} (${helper.export}) from ${helper.module}`,
      ).toBe(true)
    }
  })

  it('exports callable compiler helpers with the declared value shape', () => {
    for (const helper of runtimeAbi.helpers) {
      const value = modules[helper.module][helper.export]
      if (helper.key === 'fragment') {
        expect(value).toBe(Symbol.for('fict:fragment'))
      } else {
        expect(typeof value, `${helper.key} (${helper.export})`).toBe('function')
      }
    }
  })

  it('keeps async helper slot identity and root-owned cancellation', () => {
    const owner = createRootContext()
    const context: HookContext = { slots: [], cursor: 0, rendering: true }
    let calls = 0
    let signal: AbortSignal | undefined
    const value = withRootContext(owner, () =>
      internal.__fictUseAsyncMemo(
        context,
        input => {
          calls++
          signal = input.signal
          return 42
        },
        { name: 'answer' },
        3,
      ),
    )
    expect(value()).toBe(42)
    expect(context.cursor).toBe(0)
    expect(internal.__fictUseAsyncMemo(context, () => 100, 3)).toBe(value)
    expect(calls).toBe(1)
    destroyRoot(owner)
    expect(signal?.aborted).toBe(true)
    expect(value.state().status).toBe('disposed')
    context.rendering = false
    expect(() => internal.__fictUseAsyncMemo(context, () => 1)).toThrow(
      /render execution|FICT:E_HOOK_RENDER/,
    )
  })

  it('keeps signal, memo, and effect helper contracts usable', () => {
    const count = internal.createSignal(1)
    expect(typeof count).toBe('function')
    expect(count()).toBe(1)

    const doubled = internal.createMemo(() => count() * 2)
    expect(doubled()).toBe(2)

    count(3)
    expect(doubled()).toBe(6)

    const dispose = internal.createEffect(() => {
      void doubled()
    })
    expect(typeof dispose).toBe('function')
    dispose()
  })
})
