import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSignal, createMemo, render } from '../index'
import { jsx as _jsx, jsxs as _jsxs } from '../../../runtime/src/jsx-runtime'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('Component Integration', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
    container.innerHTML = ''
  })

  it('should handle basic counter updates (P0)', async () => {
    function Counter() {
      const count = createSignal(0)
      const doubled = createMemo(() => count() * 2)

      return _jsxs('div', {
        children: [
          _jsx('h1', { children: 'Counter' }),
          _jsxs('p', {
            // FIX: Pass a getter function for reactive text binding
            children: ['Count: ', () => count()],
          }),
          _jsxs('p', {
            // FIX: Pass a getter function for reactive text binding
            children: ['Doubled: ', () => doubled()],
          }),
          _jsx('button', {
            id: 'inc',
            onClick: () => count(count() + 1),
            children: 'Increment',
          }),
        ],
      })
    }

    const dispose = render(() => _jsx(Counter, {}), container)

    const h1 = container.querySelector('h1')
    const ps = container.querySelectorAll('p') as NodeListOf<any>
    const btn = container.querySelector('#inc') as HTMLButtonElement

    expect(h1?.textContent).toBe('Counter')
    expect(ps[0].textContent).toBe('Count: 0')
    expect(ps[1].textContent).toBe('Doubled: 0')

    btn.click()
    await tick()

    expect(ps[0].textContent).toBe('Count: 1')
    expect(ps[1].textContent).toBe('Doubled: 2')

    btn.click()
    await tick()

    expect(ps[0].textContent).toBe('Count: 2')
    expect(ps[1].textContent).toBe('Doubled: 4')

    dispose()
  })

  it('should handle conditional rendering with ternary (P0)', async () => {
    function Toggle() {
      const on = createSignal(false)

      return _jsxs('div', {
        children: [
          _jsx('button', {
            id: 'toggle',
            onClick: () => on(!on()),
            children: 'Toggle',
          }),
          _jsx('div', {
            id: 'status',
            // Reactive child binding using generic function
            children: () => (on() ? _jsx('span', { children: 'ON' }) : 'OFF'),
          }),
        ],
      })
    }

    const dispose = render(() => _jsx(Toggle, {}), container)
    const btn = container.querySelector('#toggle') as HTMLButtonElement
    const status = container.querySelector('#status') as HTMLDivElement

    expect(status.textContent).toBe('OFF')

    btn.click()
    await tick()

    expect(status.textContent).toBe('ON')
    expect(status.querySelector('span')).not.toBeNull()

    btn.click()
    await tick()

    expect(status.textContent).toBe('OFF')
    expect(status.querySelector('span')).toBeNull()

    dispose()
  })

  it('should handle list rendering with map (P0)', async () => {
    function List() {
      const items = createSignal(['a', 'b'])

      return _jsxs('div', {
        children: [
          _jsx('button', {
            id: 'add',
            onClick: () => items([...items(), 'c']),
            children: 'Add',
          }),
          _jsx('ul', {
            // Naive list rendering: returning array of nodes
            children: () =>
              items().map(item =>
                _jsx('li', {
                  children: item,
                }),
              ),
          }),
        ],
      })
    }

    const dispose = render(() => _jsx(List, {}), container)
    const btn = container.querySelector('#add') as HTMLButtonElement
    const ul = container.querySelector('ul') as HTMLUListElement

    expect(ul.children.length).toBe(2)
    expect((ul.children[0] as HTMLLIElement).textContent).toBe('a')
    expect((ul.children[1] as HTMLLIElement).textContent).toBe('b')

    btn.click()
    await tick()

    expect(ul.children.length).toBe(3)
    expect((ul.children[2] as HTMLLIElement).textContent).toBe('c')

    dispose()
  })

  it('should handle reactive attributes (P0)', async () => {
    function ActiveButton() {
      const active = createSignal(false)

      return _jsx('button', {
        id: 'btn',
        // Reactive class attribute
        className: () => (active() ? 'active' : 'inactive'),
        // Reactive style attribute
        style: () => ({ color: active() ? 'red' : 'blue' }),
        // Reactive standard attribute
        disabled: () => active(),
        onClick: () => active(!active()),
        children: 'Click me',
      })
    }

    const dispose = render(() => _jsx(ActiveButton, {}), container)
    const btn = container.querySelector('#btn') as HTMLButtonElement

    expect(btn.className).toBe('inactive')
    expect(btn.style.color).toBe('blue')
    expect(btn.disabled).toBe(false)

    // Manually trigger update since disabled button might not fire click in some envs
    // But here we rely on the click logic:
    // Actually if it becomes disabled, subsequents clicks shouldn't work.
    // Let's testing toggling externally if needed, or proper interaction.
    // The handler toggles it to true (disabled).

    btn.click()
    await tick()

    expect(btn.className).toBe('active')
    expect(btn.style.color).toBe('red')
    expect(btn.disabled).toBe(true)

    dispose()
  })
})
