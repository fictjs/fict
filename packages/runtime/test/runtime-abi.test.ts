import { afterEach, describe, expect, it } from 'vitest'

import runtimeAbi from '../runtime-abi.json'
import * as internal from '../src/internal'
import * as list from '../src/internal/list'

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
