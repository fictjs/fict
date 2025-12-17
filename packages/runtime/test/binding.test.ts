import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  createSignal,
  createEffect,
  createRoot,
  render,
  createElement,
  Fragment,
  createTextBinding,
  createChildBinding,
  createAttributeBinding,
  createStyleBinding,
  createClassBinding,
  bindStyle,
  bindClass,
  createConditional,
  createList,
  insert,
  createShow,
  createPortal,
  onDestroy,
  unwrapPrimitive,
  isReactive,
  unwrap,
} from '../src/index'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('Reactive DOM Binding', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  describe('isReactive', () => {
    it('detects reactive values (zero-argument functions)', () => {
      expect(isReactive(() => 1)).toBe(true)
      expect(
        isReactive(function () {
          return 1
        }),
      ).toBe(true)
    })

    it('does not detect static values', () => {
      expect(isReactive(1)).toBe(false)
      expect(isReactive('hello')).toBe(false)
      expect(isReactive(null)).toBe(false)
      expect(isReactive(undefined)).toBe(false)
    })

    it('does not detect event handlers (functions with arguments)', () => {
      expect(isReactive((e: unknown) => console.log(e))).toBe(false)
      expect(
        isReactive(function (x: number) {
          return x
        }),
      ).toBe(false)
    })
  })

  describe('unwrap', () => {
    it('unwraps reactive values', () => {
      expect(unwrap(() => 42)).toBe(42)
    })

    it('returns static values as-is', () => {
      expect(unwrap(42)).toBe(42)
      expect(unwrap('hello')).toBe('hello')
    })
  })

  describe('createTextBinding', () => {
    it('creates static text node', () => {
      const text = createTextBinding('Hello')
      expect(text.data).toBe('Hello')
    })

    it('creates reactive text node', async () => {
      const count = createSignal(0)
      const { value: text, dispose } = createRoot(() => createTextBinding(() => count()))

      expect(text.data).toBe('0')

      count(5)
      await tick()
      expect(text.data).toBe('5')

      count(100)
      await tick()
      expect(text.data).toBe('100')

      dispose()
    })

    it('handles null/undefined/false as empty string', () => {
      expect(createTextBinding(null).data).toBe('')
      expect(createTextBinding(undefined).data).toBe('')
      expect(createTextBinding(false).data).toBe('')
    })
  })

  describe('createAttributeBinding', () => {
    it('sets static attributes', () => {
      const el = document.createElement('button')
      const setter = (el: HTMLElement, key: string, value: unknown) => {
        if (value === true) el.setAttribute(key, '')
        else if (value == null || value === false) el.removeAttribute(key)
        else el.setAttribute(key, String(value))
      }

      createAttributeBinding(el, 'disabled', true, setter)
      expect(el.hasAttribute('disabled')).toBe(true)
    })

    it('creates reactive attribute binding', async () => {
      const el = document.createElement('button')
      const disabled = createSignal(false)
      const setter = (el: HTMLElement, key: string, value: unknown) => {
        if (value === true) el.setAttribute(key, '')
        else if (value == null || value === false) el.removeAttribute(key)
        else el.setAttribute(key, String(value))
      }

      const { dispose } = createRoot(() => {
        createAttributeBinding(el, 'disabled', () => disabled(), setter)
      })

      expect(el.hasAttribute('disabled')).toBe(false)

      disabled(true)
      await tick()
      expect(el.hasAttribute('disabled')).toBe(true)

      disabled(false)
      await tick()
      expect(el.hasAttribute('disabled')).toBe(false)

      dispose()
    })
  })

  describe('createStyleBinding', () => {
    it('applies string style', () => {
      const el = document.createElement('div')
      createStyleBinding(el, 'color: red; font-size: 14px;')
      expect(el.style.color).toBe('red')
      expect(el.style.fontSize).toBe('14px')
    })

    it('applies object style', () => {
      const el = document.createElement('div')
      createStyleBinding(el, { color: 'blue', fontSize: 16 })
      expect(el.style.color).toBe('blue')
      expect(el.style.fontSize).toBe('16px')
    })

    it('creates reactive style binding', async () => {
      const el = document.createElement('div')
      const color = createSignal('red')

      const { dispose } = createRoot(() => {
        createStyleBinding(el, () => ({ color: color() }))
      })

      expect(el.style.color).toBe('red')

      color('blue')
      await tick()
      expect(el.style.color).toBe('blue')

      dispose()
    })
  })

  describe('bindStyle', () => {
    it('reactively updates style on existing nodes', async () => {
      const el = document.createElement('div')
      const size = createSignal(12)

      bindStyle(el, () => ({ fontSize: `${size()}px`, color: 'black' }))
      expect(el.style.fontSize).toBe('12px')
      expect(el.style.color).toBe('black')

      size(18)
      await tick()
      expect(el.style.fontSize).toBe('18px')
    })
  })

  describe('createClassBinding', () => {
    it('applies string class', () => {
      const el = document.createElement('div')
      createClassBinding(el, 'foo bar')
      expect(el.className).toBe('foo bar')
    })

    it('applies object class', () => {
      const el = document.createElement('div')
      createClassBinding(el, { foo: true, bar: false, baz: true })
      expect(el.className).toBe('foo baz')
    })

    it('creates reactive class binding', async () => {
      const el = document.createElement('div')
      const active = createSignal(false)

      const { dispose } = createRoot(() => {
        createClassBinding(el, () => ({ active: active(), base: true }))
      })

      expect(el.classList.contains('base')).toBe(true)
      expect(el.classList.contains('active')).toBe(false)

      active(true)
      await tick()
      expect(el.classList.contains('active')).toBe(true)
      expect(el.classList.contains('base')).toBe(true)

      active(false)
      await tick()
      expect(el.classList.contains('active')).toBe(false)
      expect(el.classList.contains('base')).toBe(true)

      dispose()
    })
  })

  describe('bindClass', () => {
    it('reactively updates classes on existing nodes', async () => {
      const el = document.createElement('div')
      const isActive = createSignal(false)

      bindClass(el, () => ({ base: true, active: isActive() }))
      expect(el.className).toBe('base')

      isActive(true)
      await tick()
      expect(el.className).toBe('base active')
    })
  })

  describe('createChildBinding', () => {
    it('creates reactive child that updates', async () => {
      const count = createSignal(0)

      const { dispose } = createRoot(() => {
        createChildBinding(container, () => String(count()), createElement)
      })

      expect(container.textContent).toBe('0')

      count(5)
      await tick()
      expect(container.textContent).toBe('5')

      count(100)
      await tick()
      expect(container.textContent).toBe('100')

      dispose()
    })

    it('handles conditional content', async () => {
      const show = createSignal(true)

      const { dispose } = createRoot(() => {
        createChildBinding(container, () => (show() ? 'Visible' : null), createElement)
      })

      expect(container.textContent).toBe('Visible')

      show(false)
      await tick()
      expect(container.textContent).toBe('')

      show(true)
      await tick()
      expect(container.textContent).toBe('Visible')

      dispose()
    })
  })

  describe('insert', () => {
    it('cleans up fragment outputs and lifecycles when swapped', async () => {
      const show = createSignal(true)
      const cleanups: string[] = []

      const Child = () => {
        onDestroy(() => {
          cleanups.push('child')
        })
        return {
          type: Fragment,
          props: {
            children: ['X', { type: 'span', props: { children: 'Y' }, key: undefined }],
          },
          key: undefined,
        }
      }

      const root = createRoot(() =>
        insert(
          container,
          () => (show() ? { type: Child, props: {}, key: undefined } : null),
          createElement,
        ),
      )
      const disposeInsert = root.value

      expect(container.textContent).toBe('XY')

      show(false)
      await tick()
      expect(container.textContent).toBe('')
      expect(cleanups).toEqual(['child'])

      disposeInsert()
      root.dispose()
    })
  })

  describe('createConditional', () => {
    it('renders true branch when condition is true', async () => {
      const show = createSignal(true)

      const { marker, dispose } = createConditional(
        () => show(),
        () => 'TRUE',
        createElement,
        () => 'FALSE',
      )
      // marker is now a fragment - append it to container
      container.appendChild(marker)

      expect(container.textContent).toBe('TRUE')

      show(false)
      await tick()
      expect(container.textContent).toBe('FALSE')

      show(true)
      await tick()
      expect(container.textContent).toBe('TRUE')

      dispose()
    })

    it('handles undefined false branch', async () => {
      const show = createSignal(true)

      const { marker, dispose } = createConditional(
        () => show(),
        () => 'CONTENT',
        createElement,
        undefined,
      )
      container.appendChild(marker)

      expect(container.textContent).toBe('CONTENT')

      show(false)
      await tick()
      expect(container.textContent).toBe('')

      dispose()
    })

    it('cleans up fragment branches', async () => {
      const show = createSignal(true)

      const { marker, dispose } = createConditional(
        () => show(),
        () => ({
          type: Fragment,
          props: { children: ['A', { type: 'span', props: { children: 'B' }, key: undefined }] },
          key: undefined,
        }),
        createElement,
        () => 'X',
      )
      container.appendChild(marker)

      expect(container.textContent).toBe('AB')

      show(false)
      await tick()
      expect(container.textContent).toBe('X')

      show(true)
      await tick()
      expect(container.textContent).toBe('AB')

      dispose()
    })
  })

  describe('createList', () => {
    it('renders list items', () => {
      const items = createSignal(['a', 'b', 'c'])

      const { marker, dispose } = createList(
        () => items(),
        item => item,
        createElement,
        item => item,
      )
      container.appendChild(marker)

      expect(container.textContent).toBe('abc')

      dispose()
    })

    it('updates when items change', async () => {
      const items = createSignal(['a', 'b'])

      const { marker, dispose } = createList(
        () => items(),
        item => item,
        createElement,
        item => item,
      )
      container.appendChild(marker)

      expect(container.textContent).toBe('ab')

      items(['x', 'y', 'z'])
      await tick()
      expect(container.textContent).toBe('xyz')

      items([])
      await tick()
      expect(container.textContent).toBe('')

      dispose()
    })

    it('reuses nodes with keys', async () => {
      const items = createSignal([
        { id: 1, text: 'one' },
        { id: 2, text: 'two' },
      ])

      const renderCounts = new Map<number, number>()

      const { marker, dispose } = createList(
        () => items(),
        item => {
          renderCounts.set(item.id, (renderCounts.get(item.id) || 0) + 1)
          return item.text
        },
        createElement,
        item => item.id,
      )
      container.appendChild(marker)

      expect(container.textContent).toBe('onetwo')
      expect(renderCounts.get(1)).toBe(1)
      expect(renderCounts.get(2)).toBe(1)

      // Reorder items - nodes should be reused
      items([
        { id: 2, text: 'two' },
        { id: 1, text: 'one' },
      ])

      await tick()
      expect(container.textContent).toBe('twoone')
      // Re-rendered to reflect new ordering/content
      expect(renderCounts.get(1)).toBe(2)
      expect(renderCounts.get(2)).toBe(2)

      dispose()
    })

    it('updates reused keyed items and removes fragment outputs correctly', async () => {
      const items = createSignal([
        { id: 1, text: 'one' },
        { id: 2, text: 'two' },
      ])

      const { marker, dispose } = createList(
        () => items(),
        item => ({
          type: Fragment,
          props: {
            children: [
              item.text,
              { type: 'span', props: { children: item.text.toUpperCase() }, key: undefined },
            ],
          },
          key: undefined,
        }),
        createElement,
        item => item.id,
      )
      container.appendChild(marker)

      expect(container.textContent).toBe('oneONEtwoTWO')

      items([
        { id: 2, text: 'dos' },
        { id: 1, text: 'uno' },
      ])

      await tick()
      expect(container.textContent).toBe('dosDOSunoUNO')

      items([{ id: 2, text: 'done' }])
      await tick()
      expect(container.textContent).toBe('doneDONE')

      dispose()
    })

    it('handles unkeyed reorders and disposes replaced blocks in order', async () => {
      const items = createSignal(['a', 'b', 'c', 'd'])
      const cleanups: string[] = []

      const { marker, dispose } = createList(
        () => items(),
        item => {
          onDestroy(() => {
            cleanups.push(`destroy-${item}`)
          })
          return { type: 'span', props: { children: item }, key: undefined }
        },
        createElement,
      )
      container.appendChild(marker)

      expect(container.textContent).toBe('abcd')

      items(['d', 'c', 'b'])

      await tick()
      expect(container.textContent).toBe('dcb')
      expect(cleanups).toEqual(['destroy-a', 'destroy-b', 'destroy-c', 'destroy-d'])

      dispose()
    })

    it('reorders keyed lists while keeping cleanup order deterministic', async () => {
      const items = createSignal([
        { id: 'a', text: 'one' },
        { id: 'b', text: 'two' },
        { id: 'c', text: 'three' },
      ])

      const renders: string[] = []
      const cleanups: string[] = []

      const { marker, dispose } = createList(
        () => items(),
        item => {
          renders.push(`render-${item.id}`)
          onDestroy(() => {
            cleanups.push(`destroy-${item.id}`)
          })
          return { type: 'span', props: { children: item.text }, key: undefined }
        },
        createElement,
        item => item.id,
      )
      container.appendChild(marker)

      expect(container.textContent).toBe('onetwothree')

      items([
        { id: 'c', text: 'tres' },
        { id: 'a', text: 'uno' },
        { id: 'd', text: 'cuatro' },
      ])

      await tick()
      expect(container.textContent).toBe('tresunocuatro')
      expect(renders).toEqual([
        'render-a',
        'render-b',
        'render-c',
        'render-c',
        'render-a',
        'render-d',
      ])
      expect(cleanups).toEqual(['destroy-b'])

      dispose()
    })

    it('updates keyed items when reference is stable but fields change', async () => {
      const user = { id: 1, name: 'Alice' }
      const items = createSignal([user])
      const effectRuns: string[] = []

      const { marker, dispose } = createList(
        () => items(),
        item => {
          const div = document.createElement('div')
          createEffect(() => {
            effectRuns.push(item.name)
            div.textContent = item.name
          })
          return div
        },
        createElement,
        item => item.id,
      )
      container.appendChild(marker)

      const firstNode = container.firstChild
      expect(container.textContent).toBe('Alice')

      user.name = 'Bob'
      items([user])
      await tick()

      expect(container.textContent).toBe('Bob')
      expect(container.firstChild).toBe(firstNode)
      expect(effectRuns).toEqual(['Alice', 'Bob'])

      dispose()
    })

    it('updates primitive keyed items without remounting nodes', async () => {
      const items = createSignal([1, 2, 3])

      const { marker, dispose } = createList(
        () => items(),
        item => {
          const span = document.createElement('span')
          createEffect(() => {
            span.textContent = String(item)
          })
          return span
        },
        createElement,
        (_item, index) => index,
      )
      container.appendChild(marker)

      const spansBefore = Array.from(container.querySelectorAll('span'))
      expect(container.textContent).toBe('123')

      items([1, 2, 4])
      await tick()

      const spansAfter = Array.from(container.querySelectorAll('span'))
      expect(spansAfter[2]).toBe(spansBefore[2])
      expect(container.textContent).toBe('124')

      dispose()
    })

    it('reuses fragment outputs when keyed items reorder', async () => {
      const items = createSignal([
        { id: 'a', text: 'alpha' },
        { id: 'b', text: 'beta' },
      ])

      const { marker, dispose } = createList(
        () => items(),
        item => ({
          type: Fragment,
          props: {
            children: [
              {
                type: 'input',
                props: {
                  'data-id': `input-${item.id}`,
                  value: String(item.text),
                },
                key: undefined,
              },
              {
                type: 'span',
                props: {
                  'data-span-id': `span-${item.id}`,
                  children: item.text.toUpperCase(),
                },
                key: undefined,
              },
            ],
          },
          key: undefined,
        }),
        createElement,
        item => item.id,
      )
      container.appendChild(marker)

      const inputA = container.querySelector('input[data-id="input-a"]') as HTMLInputElement
      inputA.dataset.keep = 'yes'

      items([
        { id: 'b', text: 'beta' },
        { id: 'a', text: 'gamma' },
      ])
      await tick()

      const inputAAfter = container.querySelector('input[data-id="input-a"]') as HTMLInputElement
      expect(inputAAfter).toBe(inputA)
      expect(inputAAfter.dataset.keep).toBe('yes')
      const spanA = container.querySelector('span[data-span-id="span-a"]')!
      expect(spanA.textContent).toBe('GAMMA')

      dispose()
    })

    it('unwrapPrimitive extracts raw values from keyed primitive proxies', async () => {
      const items = createSignal([1, 2, 3])
      const typeResults: string[] = []
      const equalityResults: boolean[] = []
      const unwrappedTypeResults: string[] = []
      const unwrappedEqualityResults: boolean[] = []

      const { marker, dispose } = createList(
        () => items(),
        item => {
          // Proxied primitive behavior
          typeResults.push(typeof item)
          equalityResults.push(item === 1)

          // Unwrapped primitive behavior
          const raw = unwrapPrimitive(item)
          unwrappedTypeResults.push(typeof raw)
          unwrappedEqualityResults.push(raw === 1)

          const div = document.createElement('div')
          div.textContent = String(item)
          return div
        },
        createElement,
        item => item,
      )
      container.appendChild(marker)

      // Proxied values return 'object' and fail strict equality
      expect(typeResults).toEqual(['object', 'object', 'object'])
      expect(equalityResults).toEqual([false, false, false])

      // Unwrapped values return correct type and pass strict equality
      expect(unwrappedTypeResults).toEqual(['number', 'number', 'number'])
      expect(unwrappedEqualityResults).toEqual([true, false, false])

      dispose()
    })

    it('unwrapPrimitive passes through non-proxy values unchanged', () => {
      expect(unwrapPrimitive(42)).toBe(42)
      expect(unwrapPrimitive('hello')).toBe('hello')
      expect(unwrapPrimitive(true)).toBe(true)
      expect(unwrapPrimitive(null)).toBe(null)
      expect(unwrapPrimitive(undefined)).toBe(undefined)
      const obj = { foo: 'bar' }
      expect(unwrapPrimitive(obj)).toBe(obj)
    })
  })

  describe('createShow', () => {
    it('toggles display style', async () => {
      const el = document.createElement('div')
      const visible = createSignal(true)

      const { dispose } = createRoot(() => {
        createShow(el, () => visible())
      })

      expect(el.style.display).toBe('')

      visible(false)
      await tick()
      expect(el.style.display).toBe('none')

      visible(true)
      await tick()
      expect(el.style.display).toBe('')

      dispose()
    })

    it('preserves original display style', async () => {
      const el = document.createElement('div')
      el.style.display = 'flex'
      const visible = createSignal(true)

      const { dispose } = createRoot(() => {
        createShow(el, () => visible())
      })

      expect(el.style.display).toBe('flex')

      visible(false)
      await tick()
      expect(el.style.display).toBe('none')

      visible(true)
      await tick()
      expect(el.style.display).toBe('flex')

      dispose()
    })
  })

  describe('createPortal', () => {
    it('renders and cleans up fragment output', async () => {
      const portalContainer = document.createElement('div')
      const visible = createSignal(true)

      const { marker, dispose } = createPortal(
        portalContainer,
        () =>
          visible()
            ? {
                type: Fragment,
                props: {
                  children: ['P', { type: 'span', props: { children: 'Q' }, key: undefined }],
                },
                key: undefined,
              }
            : null,
        createElement,
      )

      expect(portalContainer.textContent).toBe('PQ')

      visible(false)
      await tick()
      expect(portalContainer.textContent).toBe('')

      dispose()
      expect(portalContainer.contains(marker)).toBe(false)
    })
  })

  describe('Full Integration: render with reactive children', () => {
    it('keeps render function single-run while bindings update', async () => {
      let renderCount = 0
      let setCount!: (value: number) => void

      const teardown = render(() => {
        renderCount++
        const count = createSignal(0)
        setCount = count
        return {
          type: 'div',
          props: {
            children: () => `Count: ${count()}`,
          },
          key: undefined,
        }
      }, container)

      expect(renderCount).toBe(1)
      expect(container.textContent).toBe('Count: 0')

      setCount(1)
      setCount(2)

      expect(renderCount).toBe(1)
      await tick()
      expect(container.textContent).toBe('Count: 2')

      teardown()
    })

    it('updates text content reactively', async () => {
      const count = createSignal(0)

      const teardown = render(
        () => ({
          type: 'div',
          props: {
            children: () => `Count: ${count()}`,
          },
          key: undefined,
        }),
        container,
      )

      expect(container.textContent).toBe('Count: 0')

      count(5)
      await tick()
      expect(container.textContent).toBe('Count: 5')

      teardown()
    })

    it('updates attributes reactively', async () => {
      const disabled = createSignal(false)

      const teardown = render(
        () => ({
          type: 'button',
          props: {
            disabled: () => disabled(),
            children: 'Click me',
          },
          key: undefined,
        }),
        container,
      )

      const button = container.querySelector('button')!
      expect(button.hasAttribute('disabled')).toBe(false)

      disabled(true)
      await tick()
      expect(button.hasAttribute('disabled')).toBe(true)

      disabled(false)
      await tick()
      expect(button.hasAttribute('disabled')).toBe(false)

      teardown()
    })

    it('handles conditional rendering', async () => {
      const show = createSignal(true)

      const teardown = render(
        () => ({
          type: 'div',
          props: {
            children: () => (show() ? 'Visible' : null),
          },
          key: undefined,
        }),
        container,
      )

      expect(container.textContent).toBe('Visible')

      show(false)
      await tick()
      expect(container.textContent).toBe('')

      show(true)
      await tick()
      expect(container.textContent).toBe('Visible')

      teardown()
    })

    it('handles list rendering with nested reactive content', async () => {
      const items = createSignal(['a', 'b', 'c'])

      const teardown = render(
        () => ({
          type: 'ul',
          props: {
            children: () =>
              items().map(item => ({
                type: 'li',
                props: { children: item },
                key: item,
              })),
          },
          key: undefined,
        }),
        container,
      )

      expect(container.querySelectorAll('li').length).toBe(3)
      expect(container.textContent).toBe('abc')

      items(['x', 'y'])
      await tick()
      expect(container.querySelectorAll('li').length).toBe(2)
      expect(container.textContent).toBe('xy')

      teardown()
    })

    it('handles multiple reactive attributes', async () => {
      const className = createSignal('base')
      const title = createSignal('Hello')

      const teardown = render(
        () => ({
          type: 'div',
          props: {
            class: () => className(),
            title: () => title(),
            children: 'Content',
          },
          key: undefined,
        }),
        container,
      )

      const div = container.querySelector('div')!
      expect(div.className).toBe('base')
      expect(div.getAttribute('title')).toBe('Hello')

      className('updated')
      title('World')
      await tick()
      expect(div.className).toBe('updated')
      expect(div.getAttribute('title')).toBe('World')

      teardown()
    })

    it('handles Fragment with reactive children', async () => {
      const count = createSignal(0)

      const teardown = render(
        () => ({
          type: Fragment,
          props: {
            children: ['Static: ', () => `Dynamic: ${count()}`],
          },
          key: undefined,
        }),
        container,
      )

      expect(container.textContent).toBe('Static: Dynamic: 0')

      count(42)
      await tick()
      expect(container.textContent).toBe('Static: Dynamic: 42')

      teardown()
    })
  })
})
