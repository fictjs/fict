/** @jsxImportSource @fictjs/runtime */
import { describe, it, expect } from 'vitest'

import { render } from '../src/index'
import { createSignal } from '../src/advanced'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('property bindings', () => {
  it('updates input value via property binding', async () => {
    const value = createSignal('a')
    const container = document.createElement('div')

    render(() => <input value={() => value()} />, container)

    const input = container.querySelector('input') as HTMLInputElement
    expect(input.value).toBe('a')

    value('b')
    await tick()
    expect(input.value).toBe('b')
  })

  it('updates checkbox checked via property binding', async () => {
    const checked = createSignal(false)
    const container = document.createElement('div')

    render(() => <input type="checkbox" checked={() => checked()} />, container)

    const input = container.querySelector('input') as HTMLInputElement
    expect(input.checked).toBe(false)

    checked(true)
    await tick()
    expect(input.checked).toBe(true)
  })
})
