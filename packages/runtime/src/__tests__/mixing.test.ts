import { describe, it, expect } from 'vitest'

import { bindClass, bindStyle, createSignal, createRoot } from '../index'

const tick = () => Promise.resolve()

describe('Style/Class Mixing', () => {
  it('mixes static class with dynamic class interactions', async () => {
    const el = document.createElement('div')
    el.className = 'static-class'

    const active = createSignal(false)

    // Simulate class:active={active()}
    const { dispose } = createRoot(() => {
      bindClass(el, () => ({ active: active() }))
    })

    expect(el.classList.contains('static-class')).toBe(true)
    expect(el.classList.contains('active')).toBe(false)

    active(true)
    await tick()
    expect(el.classList.contains('static-class')).toBe(true)
    expect(el.classList.contains('active')).toBe(true)

    active(false)
    await tick()
    expect(el.classList.contains('static-class')).toBe(true)
    expect(el.classList.contains('active')).toBe(false)

    dispose()
  })

  it('mixes static style with dynamic style interactions', async () => {
    const el = document.createElement('div')
    el.style.color = 'red'

    const width = createSignal('10px')

    // Simulate style:width={width()}
    const { dispose } = createRoot(() => {
      bindStyle(el, () => ({ width: width() }))
    })

    expect(el.style.color).toBe('red')
    expect(el.style.width).toBe('10px')

    width('20px')
    await tick()
    expect(el.style.color).toBe('red')
    expect(el.style.width).toBe('20px')

    dispose()
  })
})
