import { describe, expect, it } from 'vitest'

import { createSignal } from '../src/advanced'
import { batch, createEffect, createMemo, createRoot, onCleanup } from '../src/index'

describe('cleanup snapshots', () => {
  it.each(['signal', 'memo'])(
    'preserves the previous %s value after an eager read before flush',
    async kind => {
      const source = createSignal(0)
      const read = kind === 'memo' ? createMemo(() => source() * 2) : source
      const cleanups: number[] = []
      const owner = createRoot(() => {
        createEffect(() => {
          read()
          onCleanup(() => {
            cleanups.push(read())
          })
        })
      })
      try {
        source(1)
        expect(read()).toBe(kind === 'memo' ? 2 : 1)
        source(2)
        expect(read()).toBe(kind === 'memo' ? 4 : 2)
        await Promise.resolve()
        expect(cleanups).toEqual([0])
      } finally {
        owner.dispose()
      }
    },
  )

  it('does not roll back an unrelated imperative read during pending cleanup', async () => {
    const source = createSignal(0)
    const trigger = createSignal(0)
    const cleanups: number[] = []
    const owner = createRoot(() => {
      createEffect(() => {
        trigger()
        onCleanup(() => {
          cleanups.push(source())
        })
      })
    })
    try {
      trigger(1)
      source(1)
      expect(source()).toBe(1)
      await Promise.resolve()
      expect(cleanups).toEqual([1])
    } finally {
      owner.dispose()
    }
  })

  const collect = (globalThis as typeof globalThis & { gc?: () => void }).gc
  it.skipIf(!collect).each([
    { kind: 'signal', observed: false },
    { kind: 'signal', observed: true },
    { kind: 'memo', observed: false },
    { kind: 'memo', observed: true },
  ])(
    'releases a replaced $kind object after commit (observed: $observed)',
    async ({ kind, observed }) => {
      const source = createSignal<object | null>(null)
      const read = kind === 'memo' ? createMemo(() => source()) : source
      const owner = observed
        ? createRoot(() => {
            createEffect(() => {
              read()
            })
          })
        : undefined
      const replace = () => {
        const value = { bytes: new Uint8Array(1024 * 1024) }
        batch(() => {
          source(value)
        })
        read()
        const reference = new WeakRef(value)
        batch(() => {
          source(null)
        })
        read()
        return reference
      }
      const reference = replace()
      try {
        for (let i = 0; i < 4; i++) {
          await new Promise(resolve => setTimeout(resolve, 0))
          collect!()
        }
        expect(reference.deref() === undefined).toBe(true)
      } finally {
        owner?.dispose()
      }
    },
  )
})
