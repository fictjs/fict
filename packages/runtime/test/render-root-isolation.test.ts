import { describe, expect, it } from 'vitest'

import { batch, createEffect, render } from '../src/index'
import { hydrateComponent } from '../src/dom'
import { createSignal } from '../src/advanced'

describe('render root dependency isolation', () => {
  it.each([render, hydrateComponent])('keeps the new root alive when its caller stops', mount => {
    const host = document.createElement('div')
    const source = createSignal(0)
    const seen: number[] = []
    let dispose = () => {}
    const stop = createEffect(() => {
      dispose = mount(() => {
        createEffect(() => {
          seen.push(source())
        })
        return 'child'
      }, host)
    })
    try {
      stop()
      batch(() => source(1))
      expect(seen).toEqual([0, 1])
    } finally {
      stop()
      dispose()
    }
  })
})
