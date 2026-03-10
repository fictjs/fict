import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { createRoot, onDestroy, createElement, Fragment } from '../src/index'
import { createSignal, reactive } from '../src/advanced'
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
import { createRootContext, destroyRoot, popRoot, pushRoot } from '../src/lifecycle'

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
        bindRef(el, (elem: Element | null) => {
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
      expect(ref1.current).toBe(null)
      expect(ref2.current).toBe(el)

      dispose()
      expect(ref2.current).toBe(null)
    })

    it('handles reactive callback ref', async () => {
      const el = document.createElement('div')
      const calls: Array<{ cb: string; elem: Element | null }> = []
      const cb1 = (elem: Element | null) => calls.push({ cb: 'cb1', elem })
      const cb2 = (elem: Element | null) => calls.push({ cb: 'cb2', elem })
      const currentCb = createSignal<(elem: Element | null) => void>(cb1)

      const { dispose } = createRoot(() => {
        bindRef(el, () => currentCb())
      })

      // First callback should be called immediately
      expect(calls.some(c => c.cb === 'cb1' && c.elem === el)).toBe(true)

      currentCb(cb2)
      await tick()
      expect(calls.some(c => c.cb === 'cb1' && c.elem === null)).toBe(true)
      // After changing the signal, cb2 should be called
      expect(calls.some(c => c.cb === 'cb2' && c.elem === el)).toBe(true)

      dispose()
      expect(calls.some(c => c.cb === 'cb2' && c.elem === null)).toBe(true)
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

    it('uses the element ownerDocument for delegated events', () => {
      const foreignDoc = document.implementation.createHTMLDocument('foreign-delegated-events')
      const el = foreignDoc.createElement('button')
      foreignDoc.body.appendChild(el)
      const handler = vi.fn()

      const cleanup = bindEvent(el, 'click', handler)

      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(handler).toHaveBeenCalledTimes(1)

      cleanup()
      clearDelegatedEvents(foreignDoc)
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

    it('treats reactive(...) getters as reactive handlers (does not pass event to getter)', () => {
      const el = document.createElement('button')
      container.appendChild(el)
      const handler = vi.fn()
      let getterArgCount = -1

      const getter = reactive(function () {
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

    it('reconciles text when DOM is externally mutated but value cache is unchanged', async () => {
      const text = document.createTextNode('')
      const value = createSignal('hello')
      const trigger = createSignal(0)

      bindText(text, () => {
        trigger()
        return value()
      })
      expect(text.data).toBe('hello')

      // Simulate third-party/manual DOM mutation.
      text.data = 'tampered'
      trigger(1)
      await tick()

      expect(text.data).toBe('hello')
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

    it('ignores inherited style keys and removes stale own keys', async () => {
      const el = document.createElement('div')
      const style = createSignal<Record<string, string | number>>({ color: 'red' })

      bindStyle(el, () => style())
      expect(el.style.color).toBe('red')

      const inheritedOnly = Object.create({ color: 'blue' }) as Record<string, string | number>
      style(inheritedOnly)
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

    it('handles object refs in props', () => {
      const el = document.createElement('div')
      const ref = { current: null as Element | null }

      const { dispose } = createRoot(() => {
        spread(el, { ref })
      })

      expect(ref.current).toBe(el)
      dispose()
      expect(ref.current).toBe(null)
    })

    it('renders children from spread props', async () => {
      const el = document.createElement('div')

      const { dispose } = createRoot(() => {
        spread(el, { children: 'hello' }, false, false)
      })

      await tick()
      expect(el.textContent).toBe('hello')
      expect(el.innerHTML).toBe('hello')
      expect(Array.from(el.childNodes).map(node => node.nodeType)).toEqual([Node.TEXT_NODE])
      dispose()
    })

    it('updates reactive children from spread props', async () => {
      const el = document.createElement('div')
      const message = createSignal('hello')

      const { dispose } = createRoot(() => {
        spread(el, { children: () => message() }, false, false)
      })

      await tick()
      expect(el.textContent).toBe('hello')

      message('world')
      await tick()
      expect(el.textContent).toBe('world')
      dispose()
    })

    it('returns prevProps for tracking', () => {
      const el = document.createElement('div')

      const prevProps = spread(el, { class: 'foo' })

      expect(prevProps).toBeTypeOf('object')
    })

    it('supports getter props and updates assignments reactively', async () => {
      const el = document.createElement('button')
      container.appendChild(el)
      const firstHandler = vi.fn()
      const secondHandler = vi.fn()
      const props = createSignal<Record<string, unknown>>({
        'data-id': 'first',
        onClick: firstHandler,
      })

      const { dispose } = createRoot(() => {
        spread(el, () => props(), false, true)
      })

      expect(el.getAttribute('data-id')).toBe('first')

      props({
        'data-id': 'second',
        onClick: secondHandler,
      })
      await tick()

      expect(el.getAttribute('data-id')).toBe('second')
      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(firstHandler).not.toHaveBeenCalled()
      expect(secondHandler).toHaveBeenCalledTimes(1)
      dispose()
    })

    it('treats delegated reactive handlers as accessors instead of raw listeners', async () => {
      const el = document.createElement('button')
      container.appendChild(el)
      const firstHandler = vi.fn()
      const secondHandler = vi.fn()
      const currentHandler = createSignal<EventListener>(firstHandler)
      const prevProps: Record<string, unknown> = {}

      assign(el, { onClick: currentHandler }, false, false, prevProps)

      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(firstHandler).toHaveBeenCalledTimes(1)

      currentHandler(secondHandler)
      await tick()

      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(secondHandler).toHaveBeenCalledTimes(1)
      expect(currentHandler()).toBe(secondHandler)
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

    it('assigns and clears object refs', () => {
      const el = document.createElement('div')
      const ref = { current: null as Element | null }
      const prevProps: Record<string, unknown> = {}

      assign(el, { ref }, false, false, prevProps)
      expect(ref.current).toBe(el)

      assign(el, {}, false, false, prevProps)
      expect(ref.current).toBe(null)
    })

    it('clears the previous object ref before applying a new one', () => {
      const el = document.createElement('div')
      const first = { current: null as Element | null }
      const second = { current: null as Element | null }
      const prevProps: Record<string, unknown> = {}

      assign(el, { ref: first }, false, false, prevProps)
      expect(first.current).toBe(el)

      assign(el, { ref: second }, false, false, prevProps)
      expect(first.current).toBe(null)
      expect(second.current).toBe(el)
    })

    it('does not accumulate root cleanups when assign churns refs', () => {
      const el = document.createElement('div')
      const prevProps: Record<string, unknown> = {}
      const root = createRootContext()
      const prev = pushRoot(root)
      const first = { current: null as Element | null }
      const second = { current: null as Element | null }
      const third = { current: null as Element | null }

      try {
        assign(el, { ref: first }, false, false, prevProps)
        const cleanupCount = root.cleanups.length

        assign(el, { ref: second }, false, false, prevProps)
        expect(root.cleanups.length).toBe(cleanupCount)
        expect(first.current).toBe(null)
        expect(second.current).toBe(el)

        assign(el, { ref: third }, false, false, prevProps)
        expect(root.cleanups.length).toBe(cleanupCount)
        expect(second.current).toBe(null)
        expect(third.current).toBe(el)
      } finally {
        popRoot(prev)
      }

      destroyRoot(root)
      expect(third.current).toBe(null)
    })

    it('does not let a disposed root clear refs rebound under another owner', () => {
      const el = document.createElement('div')
      const prevProps: Record<string, unknown> = {}
      const root = createRootContext()
      const first = { current: null as Element | null }
      const second = { current: null as Element | null }
      const prev = pushRoot(root)

      try {
        assign(el, { ref: first }, false, false, prevProps)
        assign(el, {}, false, false, prevProps)
      } finally {
        popRoot(prev)
      }

      assign(el, { ref: second }, false, false, prevProps)
      expect(second.current).toBe(el)

      destroyRoot(root)
      expect(second.current).toBe(el)
    })

    it('does not let a disposed root clear children rebound under another owner', async () => {
      const el = document.createElement('div')
      const prevProps: Record<string, unknown> = {}
      const root = createRootContext()
      const prev = pushRoot(root)

      try {
        assign(el, { children: 'old' }, false, false, prevProps)
        await tick()
        assign(el, {}, false, false, prevProps)
        await tick()
      } finally {
        popRoot(prev)
      }

      assign(el, { children: 'new' }, false, false, prevProps)
      await tick()
      expect(el.textContent).toBe('new')

      destroyRoot(root)
      expect(el.textContent).toBe('new')
    })

    it('handles on: event syntax', () => {
      const el = document.createElement('button')
      const handler = vi.fn()

      assign(el, { 'on:click': handler })

      el.dispatchEvent(new Event('click'))
      expect(handler).toHaveBeenCalled()
    })

    it('treats on: reactive handlers as accessors instead of native listeners', async () => {
      const el = document.createElement('input')
      const firstHandler = vi.fn()
      const secondHandler = vi.fn()
      const currentHandler = createSignal<EventListener>(firstHandler)
      const prevProps: Record<string, unknown> = {}

      assign(el, { 'on:focus': currentHandler }, false, false, prevProps)

      el.dispatchEvent(new Event('focus'))
      expect(firstHandler).toHaveBeenCalledTimes(1)

      currentHandler(secondHandler)
      await tick()

      el.dispatchEvent(new Event('focus'))
      expect(secondHandler).toHaveBeenCalledTimes(1)
      expect(currentHandler()).toBe(secondHandler)
    })

    it('handles oncapture: event syntax', () => {
      const el = document.createElement('button')
      const handler = vi.fn()

      assign(el, { 'oncapture:click': handler })

      el.dispatchEvent(new Event('click'))
      expect(handler).toHaveBeenCalled()
    })

    it('removes delegated handlers when onX prop is cleared', () => {
      const el = document.createElement('button')
      container.appendChild(el)
      const handler = vi.fn()
      const prevProps: Record<string, unknown> = {}

      assign(el, { onClick: handler }, false, false, prevProps)
      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(handler).toHaveBeenCalledTimes(1)

      assign(el, {}, false, false, prevProps)
      handler.mockClear()
      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(handler).not.toHaveBeenCalled()
    })

    it('clears delegated tuple data when switching to plain handler', () => {
      const el = document.createElement('button')
      container.appendChild(el)
      const tupleHandler = vi.fn()
      const plainHandler = vi.fn()
      const prevProps: Record<string, unknown> = {}

      assign(el, { onClick: [tupleHandler, 'row-1'] }, false, false, prevProps)
      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(tupleHandler).toHaveBeenCalledWith('row-1', expect.any(Event))

      assign(el, { onClick: plainHandler }, false, false, prevProps)
      plainHandler.mockClear()
      el.dispatchEvent(new Event('click', { bubbles: true }))

      expect(plainHandler).toHaveBeenCalledTimes(1)
      expect(plainHandler).toHaveBeenCalledWith(expect.any(Event))
      expect(tupleHandler).toHaveBeenCalledTimes(1)
    })

    it('replaces and removes non-delegated tuple handlers correctly', () => {
      const el = document.createElement('input')
      const first = vi.fn()
      const second = vi.fn()
      const prevProps: Record<string, unknown> = {}

      assign(el, { onFocus: [first, 'first'] }, false, false, prevProps)
      el.dispatchEvent(new Event('focus'))
      expect(first).toHaveBeenCalledWith('first', expect.any(Event))

      assign(el, { onFocus: [second, 'second'] }, false, false, prevProps)
      el.dispatchEvent(new Event('focus'))
      expect(first).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledWith('second', expect.any(Event))

      assign(el, {}, false, false, prevProps)
      second.mockClear()
      el.dispatchEvent(new Event('focus'))
      expect(second).not.toHaveBeenCalled()
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

      expect((el as any).$$click).toBeTypeOf('function')
    })

    it('handles [handler, data] tuple', () => {
      const el = document.createElement('button')
      const handler = vi.fn()
      const data = { id: 123 }
      container.appendChild(el)
      delegateEvents(['click'])

      addEventListener(el, 'click', [handler, data] as any, true)

      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(handler).toHaveBeenCalledWith(data, expect.any(Event))
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

    it('re-runs active branch when trackBranchReads is enabled', async () => {
      const condition = createSignal(true)
      const counter = createSignal(0)
      const logs: string[] = []

      const { marker, dispose, flush } = createConditional(
        () => condition(),
        () => {
          if (counter() % 2 === 0) {
            logs.push('even')
          } else {
            logs.push('odd')
          }
          return {
            type: 'div',
            props: { children: counter() % 2 === 0 ? 'E' : 'O' },
            key: undefined,
          }
        },
        createElement,
        () => 'OFF',
        undefined,
        undefined,
        { trackBranchReads: true },
      )
      container.appendChild(marker)
      flush?.()

      expect(container.textContent).toBe('E')
      expect(logs).toEqual(['even'])
      const firstDiv = container.querySelector('div')
      expect(firstDiv).not.toBeNull()

      counter(1)
      await tick()
      expect(container.textContent).toBe('O')
      expect(logs).toEqual(['even', 'odd'])
      expect(container.querySelector('div')).toBe(firstDiv)

      counter(2)
      await tick()
      expect(container.textContent).toBe('E')
      expect(logs).toEqual(['even', 'odd', 'even'])
      expect(container.querySelector('div')).toBe(firstDiv)

      dispose()
    })

    it('does not double-run side effects when patch fallback is needed', async () => {
      const condition = createSignal(true)
      const counter = createSignal(0)
      const renders: number[] = []

      const { marker, dispose, flush } = createConditional(
        () => condition(),
        () => {
          const value = counter()
          renders.push(value)
          return {
            type: Fragment,
            props: {
              children:
                value % 2 === 0
                  ? [{ type: 'span', props: { children: 'A' }, key: undefined }]
                  : [
                      { type: 'span', props: { children: 'A' }, key: undefined },
                      { type: 'span', props: { children: 'B' }, key: undefined },
                    ],
            },
            key: undefined,
          }
        },
        createElement,
        () => 'OFF',
        undefined,
        undefined,
        { trackBranchReads: true },
      )
      container.appendChild(marker)
      flush?.()

      expect(container.textContent).toBe('A')
      expect(renders).toEqual([0])

      counter(1)
      await tick()
      expect(container.textContent).toBe('AB')
      expect(renders).toEqual([0, 1])

      counter(2)
      await tick()
      expect(container.textContent).toBe('A')
      expect(renders).toEqual([0, 1, 2])

      dispose()
    })

    it('reuses dom nodes for nested fragment arrays in tracked branch patching', async () => {
      const condition = createSignal(true)
      const counter = createSignal(0)

      const { marker, dispose, flush } = createConditional(
        () => condition(),
        () => {
          const value = counter()
          return {
            type: Fragment,
            props: {
              children: [
                {
                  type: Fragment,
                  props: {
                    children: [{ type: 'span', props: { children: 'A' }, key: undefined }],
                  },
                  key: undefined,
                },
                {
                  type: Fragment,
                  props: {
                    children: [
                      { type: 'span', props: { children: String(value) }, key: undefined },
                    ],
                  },
                  key: undefined,
                },
              ],
            },
            key: undefined,
          }
        },
        createElement,
        () => 'OFF',
        undefined,
        undefined,
        { trackBranchReads: true },
      )
      container.appendChild(marker)
      flush?.()

      expect(container.textContent).toBe('A0')
      const spansBefore = Array.from(container.querySelectorAll('span'))
      expect(spansBefore).toHaveLength(2)

      counter(1)
      await tick()
      expect(container.textContent).toBe('A1')
      const spansAfter = Array.from(container.querySelectorAll('span'))
      expect(spansAfter).toHaveLength(2)
      expect(spansAfter[0]).toBe(spansBefore[0])
      expect(spansAfter[1]).toBe(spansBefore[1])

      dispose()
    })

    it('falls back to structural replace when node kind changes', async () => {
      const condition = createSignal(true)
      const counter = createSignal(0)

      const { marker, dispose, flush } = createConditional(
        () => condition(),
        () =>
          counter() % 2 === 0
            ? { type: 'span', props: { children: 'EVEN' }, key: undefined }
            : 'ODD',
        createElement,
        () => 'OFF',
        undefined,
        undefined,
        { trackBranchReads: true },
      )
      container.appendChild(marker)
      flush?.()

      expect(container.textContent).toBe('EVEN')
      const firstSpan = container.querySelector('span')
      expect(firstSpan).not.toBeNull()

      counter(1)
      await tick()
      expect(container.textContent).toBe('ODD')
      expect(container.querySelector('span')).toBeNull()

      counter(2)
      await tick()
      expect(container.textContent).toBe('EVEN')
      const secondSpan = container.querySelector('span')
      expect(secondSpan).not.toBeNull()
      expect(secondSpan).not.toBe(firstSpan)

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
