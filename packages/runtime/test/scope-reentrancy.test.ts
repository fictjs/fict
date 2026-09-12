import { describe, expect, it } from 'vitest'

import { batch, createEffect, createRoot, onCleanup } from '../src/index'
import { createScope, createSignal } from '../src/advanced'
import { getCurrentRoot } from '../src/lifecycle'

describe('scope ownership and reentrancy', () => {
  it('inherits its creation owner when run later from another root', () => {
    const owner = createRoot(() => ({ scope: createScope(), root: getCurrentRoot() }))
    const caller = createRoot(() => owner.value.scope.run(() => getCurrentRoot()?.parent))
    try {
      expect(caller.value).toBe(owner.value.root)
    } finally {
      caller.dispose()
      owner.dispose()
    }
  })

  it('stops work when stop is called from inside an initializing run', () => {
    const scope = createScope()
    const source = createSignal(0)
    let runs = 0
    let cleanups = 0
    scope.run(() => {
      scope.stop()
      createEffect(() => {
        source()
        runs++
      })
      onCleanup(() => {
        cleanups++
      })
    })
    try {
      batch(() => source(1))
      expect(runs).toBe(1)
      expect(cleanups).toBe(1)
    } finally {
      scope.stop()
    }
  })

  it('does not overwrite a replacement created by a cleanup during stop', () => {
    const scope = createScope()
    const source = createSignal(0)
    let runs = 0
    scope.run(() => {
      onCleanup(() => {
        scope.run(() => {
          createEffect(() => {
            source()
            runs++
          })
        })
      })
    })
    scope.stop()
    scope.stop()
    batch(() => source(1))
    expect(runs).toBe(1)
  })

  it('does not retain effects created after the owner is destroyed', () => {
    const owner = createRoot(() => createScope())
    const source = createSignal(0)
    let runs = 0
    owner.dispose()
    owner.value.run(() => {
      createEffect(() => {
        source()
        runs++
      })
    })
    try {
      batch(() => source(1))
      expect(runs).toBeLessThanOrEqual(1)
    } finally {
      owner.value.stop()
    }
  })
})
