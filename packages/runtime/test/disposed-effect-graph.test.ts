import { describe, expect, it } from 'vitest'

import { batch, createEffect, createMemo } from '../src/index'
import { createSignal } from '../src/advanced'
import { effect, getActiveSub, type ReactiveNode } from '../src/signal'

describe('disposed effect dependency graph', () => {
  it.each([false, true])(
    'detaches memo reads made after self-disposal (throw: %s)',
    throwAfterRead => {
      const source = createSignal(0)
      const trigger = createSignal(false)
      const failure = new Error('after disposal')
      let memoNode: ReactiveNode | undefined
      const memo = createMemo(() => {
        memoNode = getActiveSub()
        return source()
      })
      let stop = () => {}
      stop = createEffect(() => {
        if (!trigger()) return
        stop()
        memo()
        if (throwAfterRead) throw failure
      })

      try {
        const update = () => batch(() => trigger(true))
        if (throwAfterRead) expect(update).toThrow(failure)
        else update()
        expect(memoNode).toBeDefined()
        expect(memoNode!.subs).toBeUndefined()
        expect(memoNode!.deps).toBeUndefined()
      } finally {
        stop()
      }
    },
  )

  it.each([createEffect, effect])(
    'detaches reads after a parent disposes an initializing child',
    makeEffect => {
      const source = createSignal(0)
      const trigger = createSignal(false)
      let memoNode: ReactiveNode | undefined
      const memo = createMemo(() => {
        memoNode = getActiveSub()
        return source()
      })
      let stop = () => {}
      stop = createEffect(() => {
        if (!trigger()) return
        makeEffect(() => {
          stop()
          memo()
        })
      })

      try {
        batch(() => trigger(true))
        expect(memoNode).toBeDefined()
        expect(memoNode!.subs).toBeUndefined()
        expect(memoNode!.deps).toBeUndefined()
      } finally {
        stop()
      }
    },
  )
})
