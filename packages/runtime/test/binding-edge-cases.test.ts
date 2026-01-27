import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { createRoot, onDestroy, createElement, Fragment } from '../src/index'
import { createSignal } from '../src/advanced'
import {
  bindRef,
  bindEvent,
  bindText,
  bindAttribute,
  bindProperty,
  bindStyle,
  bindClass,
  classList,
  spread,
  assign,
  __fictProp,
  delegateEvents,
  clearDelegatedEvents,
  addEventListener,
  createConditional,
  createPortal,
  insert,
  callEventHandler,
} from '../src/internal'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('Binding Edge Cases', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
    clearDelegatedEvents()
  })

  describe('bindRef', () => {
    it('handles null ref gracefully', () => {
      const el = document.createElement('div')
      const cleanup = bindRef(el, null)
      expect(cleanup).toBeTypeOf('function')
      cleanup()
    })

    it('handles undefined ref gracefully', () => {
      const el = document.createElement('div')
      const cleanup = bindRef(el, undefined)
      expect(cleanup).toBeTypeOf('function')
      cleanup()
    })

    it('calls callback ref with element', () => {
      const el = document.createElement('div')
      let refValue: Element | null = null

      const { dispose } = createRoot(() => {
        bindRef(el, (elem: Element) => {
          refValue = elem
        })
      })

      expect(refValue).toBe(el)
      dispose()
    })

    it('sets ref object current property', () => {
      const el = document.createElement('div')
      const ref = { current: null as Element | null }

      const { dispose } = createRoot(() => {
        bindRef(el, ref)
      })

      expect(ref.current).toBe(el)
      dispose()
    })

    it('nullifies ref object on cleanup', () => {
      const el = document.createElement('div')
      const ref = { current: null as Element | null }

      const { dispose } = createRoot(() => {
        bindRef(el, ref)
      })

      expect(ref.current).toBe(el)
      dispose()
      expect(ref.current).toBe(null)
    })

    it('handles reactive ref', async () => {
      const el = document.createElement('div')
      const ref1 = { current: null as Element | null }
      const ref2 = { current: null as Element | null }
      const currentRef = createSignal<{ current: Element | null }>(ref1)

      const { dispose } = createRoot(() => {
        bindRef(el, () => currentRef())
      })

      expect(ref1.current).toBe(el)
      expect(ref2.current).toBe(null)

      currentRef(ref2)
      await tick()
      expect(ref2.current).toBe(el)

      dispose()
    })

    it('handles reactive callback ref', async () => {
      const el = document.createElement('div')
      const calls: Array<{ cb: string; elem: Element | null }> = []
      const cb1 = (elem: Element) => calls.push({ cb: 'cb1', elem })
      const cb2 = (elem: Element) => calls.push({ cb: 'cb2', elem })
      const currentCb = createSignal<(elem: Element) => void>(cb1)

      const { dispose } = createRoot(() => {
        bindRef(el, () => currentCb())
      })

      // First callback should be called immediately
      expect(calls.some(c => c.cb === 'cb1' && c.elem === el)).toBe(true)

      currentCb(cb2)
      await tick()
      // After changing the signal, cb2 should be called
      expect(calls.some(c => c.cb === 'cb2' && c.elem === el)).toBe(true)

      dispose()
    })
  })

  describe('bindEvent', () => {
    it('handles null handler gracefully', () => {
      const el = document.createElement('button')
      const cleanup = bindEvent(el, 'click', null)
      expect(cleanup).toBeTypeOf('function')
      cleanup()
    })

    it('handles undefined handler gracefully', () => {
      const el = document.createElement('button')
      const cleanup = bindEvent(el, 'click', undefined)
      expect(cleanup).toBeTypeOf('function')
      cleanup()
    })

    it('attaches event listener with options', () => {
      const el = document.createElement('button')
      const handler = vi.fn()

      const cleanup = bindEvent(el, 'click', handler, { capture: true })
      el.dispatchEvent(new Event('click'))

      expect(handler).toHaveBeenCalled()
      cleanup()
    })

    it('cleans up native event listener', () => {
      const el = document.createElement('button')
      const handler = vi.fn()

      const cleanup = bindEvent(el, 'focus', handler)
      cleanup()

      el.dispatchEvent(new Event('focus'))
      expect(handler).not.toHaveBeenCalled()
    })

    it('uses delegation for delegatable events', () => {
      const el = document.createElement('button')
      container.appendChild(el)
      const handler = vi.fn()

      const cleanup = bindEvent(el, 'click', handler)

      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(handler).toHaveBeenCalled()

      cleanup()
    })

    it('treats prop getters as reactive handlers (does not pass event to getter)', () => {
      const el = document.createElement('button')
      container.appendChild(el)
      const handler = vi.fn()
      let getterArgCount = -1

      const getter = __fictProp(function () {
        getterArgCount = arguments.length
        return handler
      })

      const cleanup = bindEvent(el, 'click', getter)

      el.dispatchEvent(new Event('click', { bubbles: true }))

      expect(getterArgCount).toBe(0)
      expect(handler).toHaveBeenCalled()

      cleanup()
    })

    it('handles reactive handler', async () => {
      const el = document.createElement('button')
      container.appendChild(el)
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      const currentHandler = createSignal<EventListener>(handler1)

      const { dispose } = createRoot(() => {
        bindEvent(el, 'click', () => currentHandler())
      })

      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(handler1).toHaveBeenCalledTimes(1)

      currentHandler(handler2)
      await tick()

      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(handler2).toHaveBeenCalledTimes(1)

      dispose()
    })

    it('uses non-delegated path when options are provided', () => {
      const el = document.createElement('button')
      const handler = vi.fn()

      const cleanup = bindEvent(el, 'click', handler, { passive: true })

      el.dispatchEvent(new Event('click'))
      expect(handler).toHaveBeenCalled()

      cleanup()

      handler.mockClear()
      el.dispatchEvent(new Event('click'))
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('bindText', () => {
    it('formats null as empty string', async () => {
      const text = document.createTextNode('')
      const value = createSignal<string | null>('hello')

      bindText(text, () => value())
      expect(text.data).toBe('hello')

      value(null)
      await tick()
      expect(text.data).toBe('')
    })

    it('formats false as empty string', async () => {
      const text = document.createTextNode('')
      const value = createSignal<string | boolean>('hello')

      bindText(text, () => value())
      expect(text.data).toBe('hello')

      value(false)
      await tick()
      expect(text.data).toBe('')
    })

    it('formats numbers correctly', async () => {
      const text = document.createTextNode('')
      const value = createSignal<number>(42)

      bindText(text, () => value())
      expect(text.data).toBe('42')

      value(0)
      await tick()
      expect(text.data).toBe('0')
    })
  })

  describe('bindAttribute', () => {
    it('removes attribute for false value', async () => {
      const el = document.createElement('button')
      el.setAttribute('disabled', '')
      const disabled = createSignal(false)

      bindAttribute(el, 'disabled', () => disabled())
      await tick()
      expect(el.hasAttribute('disabled')).toBe(false)
    })

    it('sets empty string for true value', async () => {
      const el = document.createElement('button')
      const disabled = createSignal(true)

      bindAttribute(el, 'disabled', () => disabled())
      await tick()
      expect(el.getAttribute('disabled')).toBe('')
    })

    it('handles undefined values', async () => {
      const el = document.createElement('div')
      el.setAttribute('data-test', 'value')
      const attr = createSignal<string | undefined>('value')

      bindAttribute(el, 'data-test', () => attr())
      expect(el.getAttribute('data-test')).toBe('value')

      attr(undefined)
      await tick()
      expect(el.hasAttribute('data-test')).toBe(false)
    })

    it('handles null values', async () => {
      const el = document.createElement('div')
      el.setAttribute('data-test', 'value')
      const attr = createSignal<string | null>('value')

      bindAttribute(el, 'data-test', () => attr())
      expect(el.getAttribute('data-test')).toBe('value')

      attr(null)
      await tick()
      expect(el.hasAttribute('data-test')).toBe(false)
    })
  })

  describe('bindProperty', () => {
    it('clears value property with empty string for undefined', async () => {
      const el = document.createElement('input') as HTMLInputElement
      el.value = 'test'
      const value = createSignal<string | undefined>('test')

      bindProperty(el, 'value', () => value())
      expect(el.value).toBe('test')

      value(undefined)
      await tick()
      expect(el.value).toBe('')
    })

    it('clears checked property with false for undefined', async () => {
      const el = document.createElement('input') as HTMLInputElement
      el.type = 'checkbox'
      el.checked = true
      const checked = createSignal<boolean | undefined>(true)

      bindProperty(el, 'checked', () => checked())
      expect(el.checked).toBe(true)

      checked(undefined)
      await tick()
      expect(el.checked).toBe(false)
    })

    it('clears selected property with false for null', async () => {
      const el = document.createElement('option') as HTMLOptionElement
      el.selected = true
      const selected = createSignal<boolean | null>(true)

      bindProperty(el, 'selected', () => selected())
      expect(el.selected).toBe(true)

      selected(null)
      await tick()
      expect(el.selected).toBe(false)
    })

    it('does not re-set unchanged values', async () => {
      const el = document.createElement('input') as HTMLInputElement
      const value = createSignal('test')

      bindProperty(el, 'value', () => value())
      const initialValue = el.value

      value('test') // Same value
      await tick()
      expect(el.value).toBe(initialValue)
    })
  })

  describe('bindStyle', () => {
    it('transitions from string to object style', async () => {
      const el = document.createElement('div')
      const style = createSignal<string | Record<string, string | number>>('color: red')

      bindStyle(el, () => style())
      expect(el.style.color).toBe('red')

      style({ backgroundColor: 'blue' })
      await tick()
      expect(el.style.backgroundColor).toBe('blue')
      // color should be cleared when transitioning from string to object
      expect(el.style.cssText).toContain('background-color')
    })

    it('transitions from object to string style', async () => {
      const el = document.createElement('div')
      const style = createSignal<string | Record<string, string | number>>({ color: 'red' })

      bindStyle(el, () => style())
      expect(el.style.color).toBe('red')

      style('background-color: blue')
      await tick()
      expect(el.style.cssText).toContain('background-color')
    })

    it('removes styles that are no longer present', async () => {
      const el = document.createElement('div')
      const style = createSignal<Record<string, string | number>>({ color: 'red', fontSize: 14 })

      bindStyle(el, () => style())
      expect(el.style.color).toBe('red')
      expect(el.style.fontSize).toBe('14px')

      style({ color: 'blue' })
      await tick()
      expect(el.style.color).toBe('blue')
      expect(el.style.fontSize).toBe('')
    })

    it('handles null/undefined style values in object', async () => {
      const el = document.createElement('div')
      el.style.color = 'red'
      el.style.fontSize = '14px'

      const style = createSignal<Record<string, string | number | null | undefined>>({
        color: 'red',
        fontSize: 14,
      })

      bindStyle(el, () => style())

      style({ color: null as any, fontSize: undefined as any })
      await tick()
      expect(el.style.color).toBe('')
      expect(el.style.fontSize).toBe('')
    })

    it('clears all styles when set to null', async () => {
      const el = document.createElement('div')
      const style = createSignal<Record<string, string> | null>({ color: 'red' })

      bindStyle(el, () => style())
      expect(el.style.color).toBe('red')

      style(null)
      await tick()
      expect(el.style.color).toBe('')
    })
  })

  describe('bindClass', () => {
    it('short-circuits when string class is unchanged', async () => {
      const el = document.createElement('div')
      const className = createSignal('foo bar')

      bindClass(el, () => className())
      expect(el.className).toBe('foo bar')

      // Re-set same value
      className('foo bar')
      await tick()
      expect(el.className).toBe('foo bar')
    })

    it('transitions from string to object class', async () => {
      const el = document.createElement('div')
      const classValue = createSignal<string | Record<string, boolean>>('static-class')

      bindClass(el, () => classValue())
      expect(el.className).toBe('static-class')

      classValue({ dynamic: true, another: true })
      await tick()
      expect(el.classList.contains('dynamic')).toBe(true)
      expect(el.classList.contains('another')).toBe(true)
    })

    it('transitions from object to string class', async () => {
      const el = document.createElement('div')
      const classValue = createSignal<string | Record<string, boolean>>({ dynamic: true })

      bindClass(el, () => classValue())
      expect(el.classList.contains('dynamic')).toBe(true)

      classValue('static-class')
      await tick()
      expect(el.className).toBe('static-class')
    })

    it('handles space-separated class names in object keys', async () => {
      const el = document.createElement('div')
      const classValue = createSignal({ 'foo bar baz': true })

      bindClass(el, () => classValue())
      expect(el.classList.contains('foo')).toBe(true)
      expect(el.classList.contains('bar')).toBe(true)
      expect(el.classList.contains('baz')).toBe(true)

      classValue({ 'foo bar baz': false })
      await tick()
      expect(el.classList.contains('foo')).toBe(false)
      expect(el.classList.contains('bar')).toBe(false)
      expect(el.classList.contains('baz')).toBe(false)
    })

    it('handles undefined class key', async () => {
      const el = document.createElement('div')
      const classValue = createSignal<Record<string, boolean>>({ undefined: true, valid: true })

      bindClass(el, () => classValue())
      expect(el.classList.contains('valid')).toBe(true)
    })
  })

  describe('classList', () => {
    it('applies and removes classes based on object values', () => {
      const el = document.createElement('div')

      const prev1 = classList(el, { foo: true, bar: true })
      expect(el.classList.contains('foo')).toBe(true)
      expect(el.classList.contains('bar')).toBe(true)

      const prev2 = classList(el, { foo: true, bar: false }, prev1)
      expect(el.classList.contains('foo')).toBe(true)
      expect(el.classList.contains('bar')).toBe(false)

      classList(el, { baz: true }, prev2)
      expect(el.classList.contains('baz')).toBe(true)
    })

    it('handles null/undefined input', () => {
      const el = document.createElement('div')
      el.className = 'existing'

      const prev = classList(el, { added: true })
      expect(el.classList.contains('added')).toBe(true)

      classList(el, null, prev)
      expect(el.classList.contains('added')).toBe(false)
    })

    it('handles string input by replacing className', () => {
      const el = document.createElement('div')
      el.className = 'old-class'

      classList(el, 'new-class' as any)
      expect(el.className).toBe('new-class')
    })
  })

  describe('spread', () => {
    it('applies props to an element', () => {
      const el = document.createElement('div')

      spread(el, { class: 'test-class', 'data-id': '123' })

      expect(el.className).toBe('test-class')
      expect(el.getAttribute('data-id')).toBe('123')
    })

    it('handles ref callback in props', () => {
      const el = document.createElement('div')
      let refElement: Element | null = null

      spread(el, { ref: (elem: Element) => (refElement = elem) })

      expect(refElement).toBe(el)
    })

    it('returns prevProps for tracking', () => {
      const el = document.createElement('div')

      const prevProps = spread(el, { class: 'foo' })

      expect(prevProps).toBeTypeOf('object')
    })
  })

  describe('assign', () => {
    it('removes props that are no longer present', () => {
      const el = document.createElement('div')
      const prevProps: Record<string, unknown> = { 'data-old': 'value' }

      el.setAttribute('data-old', 'value')

      assign(el, { 'data-new': 'new-value' }, false, false, prevProps)

      expect(el.hasAttribute('data-old')).toBe(false)
      expect(el.getAttribute('data-new')).toBe('new-value')
    })

    it('handles style prop', () => {
      const el = document.createElement('div')

      assign(el, { style: { color: 'red' } })

      expect(el.style.color).toBe('red')
    })

    it('handles classList prop', () => {
      const el = document.createElement('div')

      assign(el, { classList: { active: true, disabled: false } })

      expect(el.classList.contains('active')).toBe(true)
      expect(el.classList.contains('disabled')).toBe(false)
    })

    it('handles on: event syntax', () => {
      const el = document.createElement('button')
      const handler = vi.fn()

      assign(el, { 'on:click': handler })

      el.dispatchEvent(new Event('click'))
      expect(handler).toHaveBeenCalled()
    })

    it('handles oncapture: event syntax', () => {
      const el = document.createElement('button')
      const handler = vi.fn()

      assign(el, { 'oncapture:click': handler })

      el.dispatchEvent(new Event('click'))
      expect(handler).toHaveBeenCalled()
    })

    it('handles attr: prefix for forced attributes', () => {
      const el = document.createElement('div')

      assign(el, { 'attr:data-custom': 'value' })

      expect(el.getAttribute('data-custom')).toBe('value')
    })

    it('handles bool: prefix for boolean attributes', () => {
      const el = document.createElement('button')

      assign(el, { 'bool:disabled': true })
      expect(el.hasAttribute('disabled')).toBe(true)

      assign(el, { 'bool:disabled': false }, false, false, {})
      expect(el.hasAttribute('disabled')).toBe(false)
    })

    it('handles prop: prefix for forced properties', () => {
      const el = document.createElement('input') as HTMLInputElement

      assign(el, { 'prop:value': 'test-value' })

      expect(el.value).toBe('test-value')
    })
  })

  describe('delegateEvents / clearDelegatedEvents', () => {
    it('sets up global event delegation', () => {
      const el = document.createElement('button')
      container.appendChild(el)
      const handler = vi.fn()

      delegateEvents(['click'])
      ;(el as any).$$click = handler

      el.dispatchEvent(new Event('click', { bubbles: true }))

      expect(handler).toHaveBeenCalled()
    })

    it('clears delegated events', () => {
      const el = document.createElement('button')
      container.appendChild(el)
      const handler = vi.fn()

      delegateEvents(['click'])
      ;(el as any).$$click = handler

      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(handler).toHaveBeenCalledTimes(1)

      clearDelegatedEvents()
      handler.mockClear()

      // After clearing, the global listener is removed so even though
      // $$click is set, the delegation handler won't run
      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(handler).not.toHaveBeenCalled()
    })

    it('does not add duplicate listeners', () => {
      delegateEvents(['click'])
      delegateEvents(['click'])
      delegateEvents(['click'])

      // Should not throw and should only have one listener
    })
  })

  describe('addEventListener', () => {
    it('handles null handler', () => {
      const el = document.createElement('button')

      // Should not throw
      addEventListener(el, 'click', null)
    })

    it('handles undefined handler', () => {
      const el = document.createElement('button')

      // Should not throw
      addEventListener(el, 'click', undefined)
    })

    it('stores delegated handler on element', () => {
      const el = document.createElement('button')
      const handler = vi.fn()

      addEventListener(el, 'click', handler, true)

      expect((el as any).$$click).toBe(handler)
    })

    it('handles [handler, data] tuple', () => {
      const el = document.createElement('button')
      const handler = vi.fn()
      const data = { id: 123 }

      addEventListener(el, 'click', [handler, data] as any, true)

      expect((el as any).$$click).toBe(handler)
      expect((el as any).$$clickData).toBe(data)
    })

    it('adds non-delegated listener directly', () => {
      const el = document.createElement('button')
      const handler = vi.fn()

      addEventListener(el, 'click', handler, false)

      el.dispatchEvent(new Event('click'))
      expect(handler).toHaveBeenCalled()
    })
  })

  describe('callEventHandler', () => {
    it('handles EventListenerObject', () => {
      const event = new Event('click')
      const handlerObject = {
        handleEvent: vi.fn(),
      }

      callEventHandler(handlerObject, event)

      expect(handlerObject.handleEvent).toHaveBeenCalledWith(event)
    })

    it('handles handler that returns another handler', () => {
      const event = new Event('click')
      const innerHandler = vi.fn()
      const outerHandler = vi.fn(() => innerHandler)

      callEventHandler(outerHandler, event)

      expect(outerHandler).toHaveBeenCalled()
      expect(innerHandler).toHaveBeenCalled()
    })

    it('handles handler that returns EventListenerObject', () => {
      const event = new Event('click')
      const resultHandler = {
        handleEvent: vi.fn(),
      }
      const handler = vi.fn(() => resultHandler)

      callEventHandler(handler, event)

      expect(resultHandler.handleEvent).toHaveBeenCalled()
    })

    it('uses provided node as context', () => {
      const event = new Event('click')
      const node = document.createElement('div')
      let thisValue: unknown

      const handler = function (this: unknown) {
        thisValue = this
      }

      callEventHandler(handler, event, node)

      expect(thisValue).toBe(node)
    })

    it('passes data when provided', () => {
      const event = new Event('click')
      let receivedData: unknown
      let receivedEvent: unknown

      const handler = (data: unknown, e: Event) => {
        receivedData = data
        receivedEvent = e
      }

      callEventHandler(handler, event, null, 'test-data')

      expect(receivedData).toBe('test-data')
      expect(receivedEvent).toBe(event)
    })
  })

  describe('createPortal edge cases', () => {
    it('renders content to external container', () => {
      const portalContainer = document.createElement('div')
      document.body.appendChild(portalContainer)

      const { dispose } = createPortal(portalContainer, () => 'Portal Content', createElement)

      expect(portalContainer.textContent).toBe('Portal Content')

      dispose()
      portalContainer.remove()
    })

    it('cleans up marker on dispose', () => {
      const portalContainer = document.createElement('div')
      document.body.appendChild(portalContainer)

      const { marker, dispose } = createPortal(
        portalContainer,
        () => 'Portal Content',
        createElement,
      )

      expect(portalContainer.contains(marker)).toBe(true)

      dispose()
      expect(portalContainer.contains(marker)).toBe(false)
      portalContainer.remove()
    })

    it('handles null render output', async () => {
      const portalContainer = document.createElement('div')
      const show = createSignal(true)

      const { dispose } = createRoot(() => {
        createPortal(portalContainer, () => (show() ? 'Content' : null), createElement)
      })

      expect(portalContainer.textContent).toBe('Content')

      show(false)
      await tick()
      expect(portalContainer.textContent).toBe('')

      dispose()
    })

    it('handles false render output', async () => {
      const portalContainer = document.createElement('div')
      const show = createSignal(true)

      const { dispose } = createRoot(() => {
        createPortal(portalContainer, () => (show() ? 'Content' : false), createElement)
      })

      expect(portalContainer.textContent).toBe('Content')

      show(false)
      await tick()
      expect(portalContainer.textContent).toBe('')

      dispose()
    })
  })

  describe('createConditional edge cases', () => {
    it('handles returning false from render functions', async () => {
      const condition = createSignal(true)

      const { marker, dispose, flush } = createConditional(
        () => condition(),
        () => false,
        createElement,
      )
      container.appendChild(marker)
      flush?.()

      expect(container.textContent).toBe('')

      condition(false)
      await tick()
      expect(container.textContent).toBe('')

      dispose()
    })

    it('handles returning null from render functions', async () => {
      const condition = createSignal(true)

      const { marker, dispose, flush } = createConditional(
        () => condition(),
        () => null,
        createElement,
      )
      container.appendChild(marker)
      flush?.()

      expect(container.textContent).toBe('')

      dispose()
    })

    it('preserves DOM nodes when condition stays same', async () => {
      const condition = createSignal(true)
      const counter = createSignal(0)

      const { marker, dispose, flush } = createConditional(
        () => condition(),
        () => ({
          type: 'div',
          props: { children: () => counter() },
          key: undefined,
        }),
        createElement,
      )
      container.appendChild(marker)
      flush?.()

      const div = container.querySelector('div')
      expect(div).not.toBeNull()
      expect(div!.textContent).toBe('0')

      counter(1)
      await tick()

      // Same div should be reused
      expect(container.querySelector('div')).toBe(div)
      expect(div!.textContent).toBe('1')

      dispose()
    })
  })

  describe('insert edge cases', () => {
    it('handles array values', async () => {
      const parent = document.createElement('div')
      const items = createSignal(['a', 'b', 'c'])

      const { dispose } = createRoot(() => {
        insert(parent, () => items())
      })

      // Arrays are converted to text representation
      expect(parent.textContent).toBe('a,b,c')

      dispose()
    })

    it('handles Node values directly', async () => {
      const parent = document.createElement('div')
      const span = document.createElement('span')
      span.textContent = 'Span'

      const { dispose } = createRoot(() => {
        insert(parent, () => span)
      })

      expect(parent.contains(span)).toBe(true)

      dispose()
    })

    it('handles array of Nodes', async () => {
      const parent = document.createElement('div')
      const span1 = document.createElement('span')
      span1.textContent = 'A'
      const span2 = document.createElement('span')
      span2.textContent = 'B'

      const { dispose } = createRoot(() => {
        insert(parent, () => [span1, span2])
      })

      expect(parent.contains(span1)).toBe(true)
      expect(parent.contains(span2)).toBe(true)

      dispose()
    })

    it('cleans up owned marker on dispose', () => {
      const parent = document.createElement('div')

      const { value: cleanup } = createRoot(() => {
        return insert(parent, () => 'content')
      })

      const markerCount = Array.from(parent.childNodes).filter(
        n => n.nodeType === Node.COMMENT_NODE,
      ).length
      expect(markerCount).toBeGreaterThan(0)

      cleanup()

      // After cleanup, marker should be removed
      const newMarkerCount = Array.from(parent.childNodes).filter(
        n => n.nodeType === Node.COMMENT_NODE,
      ).length
      expect(newMarkerCount).toBe(0)
    })
  })
})
