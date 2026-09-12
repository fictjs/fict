import { describe, expect, it } from 'vitest'

import { onMount } from '../src/index'
import { createKeyedList } from '../src/list-helpers'

describe('keyed list mount errors', () => {
  it('mounts every committed row even when an earlier mount callback throws', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const failure = new Error('mount failed')
    const mounted: number[] = []
    const list = createKeyedList(
      () => [1, 2, 3],
      id => id,
      item => {
        const id = item()
        onMount(() => {
          mounted.push(id)
          if (id === 1) throw failure
        })
        return document.createElement('span')
      },
    )
    host.append(list.marker)
    try {
      expect(() => list.flush?.()).toThrow(failure)
      expect(mounted).toEqual([1, 2, 3])
    } finally {
      list.dispose()
      host.remove()
    }
  })
})
