import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createSignal } from '../src/index'
import { bindClass, bindStyle, bindText } from '../src/internal'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('fine-grained helper prototype', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('updates text, class and style bindings without rerendering nodes', async () => {
    const count = createSignal(0)

    // Manually construct the DOM structure once
    const button = document.createElement('button')
    const textNode = document.createTextNode('')
    button.append('Count: ', textNode)

    // Wire fine-grained bindings
    bindText(textNode, () => count())
    bindClass(button, () => ({ base: true, active: count() > 0 }))
    bindStyle(button, () => ({ color: count() > 0 ? 'green' : 'gray' }))

    container.appendChild(button)

    expect(button.textContent).toBe('Count: 0')
    expect(button.className).toBe('base')
    expect(button.style.color).toBe('gray')

    count(1)
    await tick()

    expect(button.textContent).toBe('Count: 1')
    expect(button.className).toBe('base active')
    expect(button.style.color).toBe('green')

    // Ensure the same text node instance was reused
    expect(button.childNodes[1]).toBe(textNode)
  })
})
