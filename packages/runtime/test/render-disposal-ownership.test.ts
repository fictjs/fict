import { describe, expect, it } from 'vitest'

import { onCleanup, onMount, render } from '../src/index'

describe('render disposal ownership', () => {
  it('does not erase a replacement when an old disposer is called again', () => {
    const host = document.createElement('div')
    const old = render(() => 'old', host)
    old()
    const next = render(() => 'new', host)
    try {
      old()
      expect(host.textContent).toBe('new')
    } finally {
      next()
    }
  })

  it('preserves a replacement created synchronously by old cleanup', () => {
    const host = document.createElement('div')
    let next = () => {}
    const old = render(() => {
      onCleanup(() => {
        next = render(() => 'new', host)
      })
      return 'old'
    }, host)
    try {
      old()
      expect(host.textContent).toBe('new')
    } finally {
      next()
    }
  })

  it('removes an inserted view when its mount callback fails', () => {
    const host = document.createElement('div')
    const failure = new Error('mount failed')
    expect(() =>
      render(() => {
        onMount(() => {
          throw failure
        })
        return { type: 'span', props: { children: 'failed' } }
      }, host),
    ).toThrow(failure)
    expect(host.childNodes).toHaveLength(0)
  })
})
