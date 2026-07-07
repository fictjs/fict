import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  createEffect,
  createRoot,
  render,
  createElement,
  Fragment,
  onDestroy,
  onMount,
} from '../src/index'
import { createSignal } from '../src/advanced'
import {
  createTextBinding,
  createChildBinding,
  createAttributeBinding,
  createStyleBinding,
  createClassBinding,
  createShow,
  isReactive,
  nonReactive,
  reactive,
  unwrap,
} from '../src/advanced'
import {
  bindStyle,
  bindClass,
  createConditional,
  createPortal,
  insert,
  insertBetween,
  bindEvent,
  callEventHandler,
  createKeyedList,
  toNodeArray,
  delegateEvents,
  __fictReactive,
  __fictProp,
} from '../src/internal'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

const createKeyedListBinding = <T>(
  items: () => T[],
  renderItem: (item: any, index: any) => any,
  getKey?: (item: T, index: number) => string | number,
) =>
  createKeyedList(
    items,
    getKey ?? ((_, idx) => idx),
    (itemSig, indexSig) => {
      const output = renderItem(itemSig, indexSig)
      const node =
        output instanceof Node ? output : (createElement(output as any) as unknown as Node)
      return toNodeArray(node)
    },
    true,
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
    it('does not treat plain zero-argument functions as reactive', () => {
      expect(isReactive(() => 1)).toBe(false)
      expect(
        isReactive(function () {
          return 1
        }),
      ).toBe(false)
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

    it('supports explicitly marking zero-arg callbacks as non-reactive', () => {
      const callback = nonReactive(() => 1)
      expect(isReactive(callback)).toBe(false)
    })

    it('marks non-reactive callbacks without adding own symbols', () => {
      const callback = () => 1
      const marked = nonReactive(callback)

      expect(marked).toBe(callback)
      expect(isReactive(marked)).toBe(false)
      expect(Object.getOwnPropertySymbols(marked)).not.toContain(Symbol.for('fict:non-reactive-fn'))
    })

    it('supports explicitly marking zero-arg getters as reactive', () => {
      const getter = reactive(() => 1)
      expect(isReactive(getter)).toBe(true)
    })

    it('keeps frozen getters reactive when explicitly marked', () => {
      const getter = Object.freeze(() => 1)
      const marked = reactive(getter)
      expect(marked).toBe(getter)
      expect(isReactive(marked)).toBe(true)
    })

    it('supports compiler-marked zero-arg getters as reactive', () => {
      const getter = __fictReactive(() => 1)
      expect(isReactive(getter)).toBe(true)
    })

    it('shares frozen prop getter markers with DOM binding checks', () => {
      const getter = Object.freeze(() => 1)
      const marked = __fictProp(getter)
      expect(marked).toBe(getter)
      expect(isReactive(marked)).toBe(true)
    })

    it('nonReactive marker overrides explicit reactive marker', () => {
      const getter = reactive(() => 1)
      const callback = nonReactive(getter)
      expect(isReactive(callback)).toBe(false)
    })

    it('keeps frozen callbacks non-reactive when explicitly marked', () => {
      const callback = Object.freeze(() => 1)
      const marked = nonReactive(callback)
      expect(marked).toBe(callback)
      expect(isReactive(marked)).toBe(false)
    })
  })

  describe('unwrap', () => {
    it('unwraps reactive values', () => {
      expect(unwrap(reactive(() => 42))).toBe(42)
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
      const { value: text, dispose } = createRoot(() => createTextBinding(reactive(() => count())))

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

    it('creates text in provided ownerDocument', () => {
      const foreignDoc = document.implementation.createHTMLDocument('foreign-text')
      const textFromDoc = createTextBinding('A', foreignDoc)
      const host = foreignDoc.createElement('div')
      const textFromNode = createTextBinding('B', host)

      expect(textFromDoc.ownerDocument).toBe(foreignDoc)
      expect(textFromDoc.data).toBe('A')
      expect(textFromNode.ownerDocument).toBe(foreignDoc)
      expect(textFromNode.data).toBe('B')
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
        createAttributeBinding(
          el,
          'disabled',
          reactive(() => disabled()),
          setter,
        )
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
        createStyleBinding(
          el,
          reactive(() => ({ color: color() })),
        )
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
        createClassBinding(
          el,
          reactive(() => ({ active: active(), base: true })),
        )
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

    it('does not track child creation reads as child binding dependencies', async () => {
      const show = createSignal(true)
      const setupValue = createSignal('initial')
      let creates = 0

      const { dispose } = createRoot(() => {
        createChildBinding(
          container,
          () => (show() ? 'child' : null),
          () => {
            creates += 1
            const node = document.createElement('span')
            node.textContent = setupValue()
            return node
          },
        )
      })

      expect(container.textContent).toBe('initial')
      expect(creates).toBe(1)

      setupValue('changed')
      await tick()

      expect(container.textContent).toBe('initial')
      expect(creates).toBe(1)

      show(false)
      await tick()

      expect(container.textContent).toBe('')
      expect(creates).toBe(1)

      dispose()
    })

    it('destroys empty child roots without running mount callbacks', () => {
      const events: string[] = []

      const { dispose } = createRoot(() => {
        createChildBinding(
          container,
          () => {
            onMount(() => events.push('mounted'))
            onDestroy(() => events.push('destroyed'))
            return null
          },
          createElement,
        )
      })

      expect(container.textContent).toBe('')
      expect(events).toEqual(['destroyed'])

      dispose()
      expect(events).toEqual(['destroyed'])
    })

    it('creates marker and children in parent ownerDocument', async () => {
      const foreignDoc = document.implementation.createHTMLDocument('foreign-child-binding')
      const foreignContainer = foreignDoc.createElement('div')
      foreignDoc.body.appendChild(foreignContainer)
      const count = createSignal(0)

      const root = createRoot(() =>
        createChildBinding(
          foreignContainer,
          () => String(count()),
          value => foreignDoc.createTextNode(String(value ?? '')),
        ),
      )
      const binding = root.value

      expect(binding.marker.ownerDocument).toBe(foreignDoc)
      expect(foreignContainer.textContent).toBe('0')

      count(2)
      await tick()
      expect(foreignContainer.textContent).toBe('2')

      binding.dispose()
      expect(foreignContainer.textContent).toBe('')
      root.dispose()
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

    it('cleans dynamic child roots when the owner root is disposed', () => {
      const cleanups: string[] = []

      const Child = () => {
        onDestroy(() => {
          cleanups.push('child')
        })
        return { type: 'span', props: { children: 'child' }, key: undefined }
      }

      const root = createRoot(() => {
        insert(container, () => ({ type: Child, props: {}, key: undefined }), createElement)
      })

      expect(container.querySelector('span')?.textContent).toBe('child')

      root.dispose()

      expect(cleanups).toEqual(['child'])
      expect(container.querySelector('span')).toBeNull()
      expect(container.childNodes.length).toBe(0)
    })

    it('uses parent ownerDocument for auto-created marker and text', async () => {
      const foreignDoc = document.implementation.createHTMLDocument('foreign-insert')
      const foreignContainer = foreignDoc.createElement('div')
      foreignDoc.body.appendChild(foreignContainer)
      const value = createSignal('A')

      const root = createRoot(() => insert(foreignContainer, () => value()))
      const disposeInsert = root.value

      const marker = foreignContainer.lastChild as Comment
      const text = foreignContainer.firstChild as Text
      expect(marker.nodeType).toBe(8)
      expect(marker.ownerDocument).toBe(foreignDoc)
      expect(text.ownerDocument).toBe(foreignDoc)
      expect(foreignContainer.textContent).toBe('A')

      value('B')
      await tick()
      expect(foreignContainer.textContent).toBe('B')

      disposeInsert()
      expect(foreignContainer.childNodes.length).toBe(0)
      root.dispose()
    })

    it('renders boolean primitive children as empty', async () => {
      const value = createSignal<boolean | number>(true)

      const root = createRoot(() => insert(container, () => value()))
      const disposeInsert = root.value

      expect(container.textContent).toBe('')

      value(0)
      await tick()
      expect(container.textContent).toBe('0')

      value(false)
      await tick()
      expect(container.textContent).toBe('')

      disposeInsert()
      root.dispose()
    })
  })

  describe('insertBetween', () => {
    it('uses marker ownerDocument for fallback text nodes', async () => {
      const foreignDoc = document.implementation.createHTMLDocument('foreign-insert-between')
      const start = foreignDoc.createComment('start')
      const end = foreignDoc.createComment('end')
      foreignDoc.body.append(start, end)

      const value = createSignal('hello')
      const dispose = insertBetween(start, end, () => value())

      const text = start.nextSibling as Text
      expect(text.nodeType).toBe(3)
      expect(text.ownerDocument).toBe(foreignDoc)
      expect(foreignDoc.body.textContent).toBe('hello')

      value('world')
      await tick()
      expect(foreignDoc.body.textContent).toBe('world')

      dispose()
      expect(foreignDoc.body.textContent).toBe('')
    })

    it('renders boolean primitive values as empty', async () => {
      const start = document.createComment('start')
      const end = document.createComment('end')
      container.append(start, end)
      const value = createSignal<boolean | number>(true)

      const dispose = insertBetween(start, end, () => value())

      expect(container.textContent).toBe('')

      value(0)
      await tick()
      expect(container.textContent).toBe('0')

      value(false)
      await tick()
      expect(container.textContent).toBe('')

      dispose()
    })

    it('cleans dynamic child roots between markers when the owner root is disposed', () => {
      const start = document.createComment('start')
      const end = document.createComment('end')
      container.append(start, end)
      const cleanups: string[] = []

      const Child = () => {
        onDestroy(() => {
          cleanups.push('child')
        })
        return { type: 'span', props: { children: 'child' }, key: undefined }
      }

      const root = createRoot(() => {
        insertBetween(start, end, () => ({ type: Child, props: {}, key: undefined }), createElement)
      })

      expect(container.querySelector('span')?.textContent).toBe('child')

      root.dispose()

      expect(cleanups).toEqual(['child'])
      expect(container.querySelector('span')).toBeNull()
      expect(container.childNodes.length).toBe(2)
      expect(container.firstChild).toBe(start)
      expect(container.lastChild).toBe(end)
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

    it('supports provided markers in a non-global document', async () => {
      const foreignDoc = document.implementation.createHTMLDocument('foreign-conditional')
      const show = createSignal(true)
      const start = foreignDoc.createComment('fict:cond:start')
      const end = foreignDoc.createComment('fict:cond:end')
      const createForeignElement = (value: unknown) =>
        foreignDoc.createTextNode(String(value ?? ''))

      const { marker, flush, dispose } = createConditional(
        () => show(),
        () => 'TRUE',
        createForeignElement as unknown as typeof createElement,
        () => 'FALSE',
        start,
        end,
      )

      expect(marker).toBe(start)

      foreignDoc.body.append(start, end)
      flush?.()

      expect(foreignDoc.body.textContent).toBe('TRUE')

      show(false)
      await tick()
      expect(foreignDoc.body.textContent).toBe('FALSE')

      dispose()
      expect(foreignDoc.body.textContent).toBe('')
    })

    it('uses root ownerDocument for default conditional markers', async () => {
      const foreignDoc = document.implementation.createHTMLDocument('foreign-conditional-default')
      const foreignContainer = foreignDoc.createElement('div')
      const show = createSignal(true)

      const disposeRender = render(
        () =>
          createConditional(
            () => show(),
            () => 'TRUE',
            createElement,
            () => 'FALSE',
          ),
        foreignContainer as unknown as HTMLElement,
      )

      await tick()
      const commentNodes = Array.from(foreignContainer.childNodes).filter(
        node => node.nodeType === Node.COMMENT_NODE,
      ) as Comment[]
      const startMarker = commentNodes.find(node => node.data === 'fict:cond:start')
      const endMarker = commentNodes.find(node => node.data === 'fict:cond:end')
      expect(startMarker?.ownerDocument).toBe(foreignDoc)
      expect(endMarker?.ownerDocument).toBe(foreignDoc)
      expect(foreignContainer.textContent).toBe('TRUE')

      show(false)
      await tick()
      expect(foreignContainer.textContent).toBe('FALSE')

      disposeRender()
    })
  })

  describe('createKeyedList', () => {
    it('renders list items', () => {
      const items = createSignal(['a', 'b', 'c'])

      const { marker, dispose, flush } = createKeyedListBinding(
        () => items(),
        item => item(),
        item => item,
      )
      container.appendChild(marker)

      flush?.()
      expect(container.textContent).toBe('abc')

      dispose()
    })

    it('uses root ownerDocument for default list markers', async () => {
      const foreignDoc = document.implementation.createHTMLDocument('foreign-list-default')
      const foreignContainer = foreignDoc.createElement('div')
      foreignDoc.body.appendChild(foreignContainer)
      const items = createSignal(['A', 'B'])

      const disposeRender = render(
        () =>
          createKeyedList(
            () => items(),
            item => item,
            itemSig => [foreignDoc.createTextNode(String(itemSig()))],
          ),
        foreignContainer as unknown as HTMLElement,
      )

      await tick()
      await tick()
      const commentNodes = Array.from(foreignContainer.childNodes).filter(
        node => node.nodeType === Node.COMMENT_NODE,
      ) as Comment[]
      const startMarker = commentNodes.find(node => node.data === 'fict:list:start')
      const endMarker = commentNodes.find(node => node.data === 'fict:list:end')
      expect(startMarker?.ownerDocument).toBe(foreignDoc)
      expect(endMarker?.ownerDocument).toBe(foreignDoc)
      expect(foreignContainer.textContent).toBe('AB')

      items(['C'])
      await tick()
      expect(foreignContainer.textContent).toBe('C')

      disposeRender()
    })

    it('updates when items change', async () => {
      const items = createSignal(['a', 'b'])

      const { marker, dispose, flush } = createKeyedListBinding(
        () => items(),
        item => item(),
        item => item,
      )
      container.appendChild(marker)

      flush?.()
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

      const { marker, dispose, flush } = createKeyedListBinding(
        () => items(),
        item => {
          const span = document.createElement('span')
          createEffect(() => {
            const value = item()
            renderCounts.set(value.id, (renderCounts.get(value.id) || 0) + 1)
            span.textContent = value.text
          })
          return span
        },
        item => item.id,
      )
      container.appendChild(marker)

      flush?.()
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

      const { marker, dispose, flush } = createKeyedListBinding(
        () => items(),
        item => {
          const textNode = document.createTextNode('')
          const span = document.createElement('span')
          const frag = document.createDocumentFragment()
          frag.append(textNode, span)

          createEffect(() => {
            const value = item()
            textNode.data = value.text
            span.textContent = value.text.toUpperCase()
          })

          return [textNode, span]
        },
        item => item.id,
      )
      container.appendChild(marker)

      flush?.()
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

      const { marker, dispose, flush } = createKeyedListBinding(
        () => items(),
        item => {
          const span = document.createElement('span')
          createEffect(() => {
            span.textContent = String(item())
          })
          onDestroy(() => {
            cleanups.push(`destroy-${item()}`)
          })
          return span
        },
      )
      container.appendChild(marker)

      flush?.()
      expect(container.textContent).toBe('abcd')

      items(['d', 'c', 'b'])

      await tick()
      expect(container.textContent).toBe('dcb')
      // Index-keyed fallback reuses positional blocks; only truncated items are disposed.
      expect(cleanups).toEqual(['destroy-d'])

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

      const { marker, dispose, flush } = createKeyedListBinding(
        () => items(),
        item => {
          const span = document.createElement('span')
          createEffect(() => {
            const value = item()
            renders.push(`render-${value.id}`)
            span.textContent = value.text
          })
          onDestroy(() => {
            cleanups.push(`destroy-${item().id}`)
          })
          return span
        },
        item => item.id,
      )
      container.appendChild(marker)

      flush?.()
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
        'render-d',
        'render-c',
        'render-a',
      ])
      expect(cleanups).toEqual(['destroy-b'])

      dispose()
    })

    it('updates keyed items when reference is stable but fields change', async () => {
      const user = { id: 1, name: 'Alice' }
      const items = createSignal([user])
      const effectRuns: string[] = []

      const { marker, dispose, flush } = createKeyedListBinding(
        () => items(),
        item => {
          const div = document.createElement('div')
          createEffect(() => {
            const value = item()
            effectRuns.push(value.name)
            div.textContent = value.name
          })
          return div
        },
        item => item.id,
      )
      container.appendChild(marker)

      flush?.()
      const firstNode = container.firstChild
      expect(container.textContent).toBe('Alice')

      items([{ ...user, name: 'Bob' }])
      await tick()

      expect(container.textContent).toBe('Bob')
      expect(container.firstChild).toBe(firstNode)
      expect(effectRuns).toEqual(['Alice', 'Bob'])

      dispose()
    })

    it('updates primitive keyed items without remounting nodes', async () => {
      const items = createSignal([1, 2, 3])

      const { marker, dispose, flush } = createKeyedListBinding(
        () => items(),
        item => {
          const span = document.createElement('span')
          createEffect(() => {
            span.textContent = String(item())
          })
          return span
        },
        (_item, index) => index,
      )
      container.appendChild(marker)

      flush?.()
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

      const { marker, dispose, flush } = createKeyedListBinding(
        () => items(),
        item => {
          const input = document.createElement('input')
          const span = document.createElement('span')

          createEffect(() => {
            const value = item()
            input.setAttribute('data-id', `input-${value.id}`)
            input.value = String(value.text)
            span.setAttribute('data-span-id', `span-${value.id}`)
            span.textContent = value.text.toUpperCase()
          })

          return [input, span]
        },
        item => item.id,
      )
      container.appendChild(marker)

      flush?.()
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

    it('handles primitive keyed items without proxy wrapping', async () => {
      const items = createSignal([1, 2, 3])
      const typeResults: string[] = []
      const equalityResults: boolean[] = []

      const { marker, dispose, flush } = createKeyedListBinding(
        () => items(),
        item => {
          const value = item()
          typeResults.push(typeof value)
          equalityResults.push(value === 1)

          const div = document.createElement('div')
          div.textContent = String(value)
          return div
        },
        item => item,
      )
      container.appendChild(marker)

      flush?.()
      // Values are raw primitives and equality behaves as expected
      expect(typeResults).toEqual(['number', 'number', 'number'])
      expect(equalityResults).toEqual([true, false, false])

      dispose()
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

    it('creates portal marker in the target ownerDocument', async () => {
      const foreignDoc = document.implementation.createHTMLDocument('foreign-portal')
      const portalContainer = foreignDoc.createElement('div')
      foreignDoc.body.appendChild(portalContainer)
      const visible = createSignal(true)

      const { marker, dispose } = createPortal(
        portalContainer,
        () => (visible() ? 'PORTAL' : null),
        (value: unknown) => foreignDoc.createTextNode(String(value ?? '')),
      )

      expect(marker.ownerDocument).toBe(foreignDoc)
      expect(portalContainer.textContent).toBe('PORTAL')

      visible(false)
      await tick()
      expect(portalContainer.textContent).toBe('')

      dispose()
      expect(portalContainer.contains(marker)).toBe(false)
    })

    it('uses container ownerDocument for default createElement portal output', async () => {
      const foreignDoc = document.implementation.createHTMLDocument('foreign-portal-default')
      const portalContainer = foreignDoc.createElement('div')
      foreignDoc.body.appendChild(portalContainer)
      const label = createSignal('A')

      const { marker, dispose } = createPortal(
        portalContainer,
        () => ({
          type: 'span',
          props: { children: label() },
          key: undefined,
        }),
        createElement,
      )

      const span = portalContainer.querySelector('span')
      expect(marker.ownerDocument).toBe(foreignDoc)
      expect(span).toBeTruthy()
      expect(span?.ownerDocument).toBe(foreignDoc)
      expect(portalContainer.textContent).toBe('A')

      label('B')
      await tick()
      expect(portalContainer.textContent).toBe('B')

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
            children: reactive(() => `Count: ${count()}`),
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
            children: reactive(() => `Count: ${count()}`),
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
            disabled: reactive(() => disabled()),
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
            children: reactive(() => (show() ? 'Visible' : null)),
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
            children: reactive(() =>
              items().map(item => ({
                type: 'li',
                props: { children: item },
                key: item,
              })),
            ),
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
            class: reactive(() => className()),
            title: reactive(() => title()),
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
            children: ['Static: ', reactive(() => `Dynamic: ${count()}`)],
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

  describe('delegated events', () => {
    it('handles delegated events from text node targets', () => {
      const handler = vi.fn()
      const button = document.createElement('button')
      const text = document.createTextNode('click')
      button.appendChild(text)

      bindEvent(button, 'click', handler)
      container.appendChild(button)

      text.dispatchEvent(new Event('click', { bubbles: true }))

      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('passes (data, event) to data-bound delegated handlers', () => {
      const button = document.createElement('button') as HTMLButtonElement & {
        $$click?: (data: unknown, e: Event) => void
        $$clickData?: () => unknown
      }
      container.appendChild(button)

      let receivedData: unknown
      let receivedEvent: Event | null = null
      let receivedThis: unknown

      button.$$click = function (data: unknown, e: Event) {
        receivedThis = this
        receivedData = data
        receivedEvent = e
      }
      button.$$clickData = () => 'payload'

      delegateEvents(['click'])
      const event = new Event('click', { bubbles: true })
      button.dispatchEvent(event)

      expect(receivedData).toBe('payload')
      expect(receivedEvent).toBe(event)
      expect(receivedThis).toBe(button)
    })
  })

  describe('callEventHandler', () => {
    it('passes only event when no data is provided', () => {
      const mockEvent = new Event('click')
      const receivedArgs: unknown[] = []
      const handler = (...args: unknown[]) => {
        receivedArgs.push(...args)
      }

      callEventHandler(handler, mockEvent, null)

      expect(receivedArgs.length).toBe(1)
      expect(receivedArgs[0]).toBe(mockEvent)
    })

    it('passes (data, event) when data is provided', () => {
      const mockEvent = new Event('click')
      const receivedArgs: unknown[] = []
      const handler = (...args: unknown[]) => {
        receivedArgs.push(...args)
      }

      callEventHandler(handler, mockEvent, null, 'testData')

      expect(receivedArgs.length).toBe(2)
      expect(receivedArgs[0]).toBe('testData')
      expect(receivedArgs[1]).toBe(mockEvent)
    })

    it('supports [handler, data] tuple pattern with (data, event) signature', () => {
      const mockEvent = new Event('click')
      let receivedData: unknown
      let receivedEvent: unknown
      const handler = (data: unknown, e: Event) => {
        receivedData = data
        receivedEvent = e
      }

      // Simulate the tuple pattern: onClick={[handler, itemId]}
      callEventHandler(handler, mockEvent, null, 123)

      expect(receivedData).toBe(123)
      expect(receivedEvent).toBe(mockEvent)
    })

    it('allows handler to access event methods like stopPropagation', () => {
      const mockEvent = new Event('click', { bubbles: true, cancelable: true })
      let eventReceived: Event | null = null
      const handler = (data: unknown, e: Event) => {
        eventReceived = e
        e.stopPropagation()
      }

      callEventHandler(handler, mockEvent, null, 'data')

      expect(eventReceived).toBe(mockEvent)
      expect(mockEvent.cancelBubble).toBe(true)
    })
  })
})
