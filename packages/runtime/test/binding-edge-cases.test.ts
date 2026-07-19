import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  batch,
  createEffect,
  createRoot,
  onDestroy,
  onMount,
  createElement,
  Fragment,
  ErrorBoundary,
} from '../src/index'
import { createChildBinding, createSignal, reactive } from '../src/advanced'
import {
  bindRef,
  bindEvent,
  bindText,
  bindTextContent,
  bindAttribute,
  bindBooleanAttribute,
  bindProperty,
  setBooleanAttribute,
  setProp,
  bindStyle,
  setStyle,
  bindClass,
  setTextContent,
  classList,
  spread,
  assign,
  __fictProp,
  delegateEvents,
  clearDelegatedEvents,
  addEventListener,
  createConditional,
  createPortal,
  hydrateComponent,
  insert,
  insertBetween,
  template,
  callEventHandler,
} from '../src/internal'
import {
  createRootContext,
  destroyRoot,
  getCurrentRoot,
  popRoot,
  pushRoot,
  registerErrorHandler,
  registerSuspenseHandler,
} from '../src/lifecycle'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('setStyle', () => {
  it('preserves numeric CSS custom properties without appending units', () => {
    const el = document.createElement('div')

    setStyle(el, {
      '--gap': 1,
      '--name': 'x',
      marginTop: 1,
    })

    expect(el.style.getPropertyValue('--gap')).toBe('1')
    expect(el.style.getPropertyValue('--name')).toBe('x')
    expect(el.style.marginTop).toBe('1px')
  })

  it('removes deleted properties from reused style object references', () => {
    const el = document.createElement('div')
    const styles: Record<string, string | number> = { color: 'red', marginTop: 1 }

    setStyle(el, styles)
    expect(el.style.color).toBe('red')
    expect(el.style.marginTop).toBe('1px')

    delete styles.color
    setStyle(el, styles)

    expect(el.style.color).toBe('')
    expect(el.style.marginTop).toBe('1px')
  })

  it('updates changed values from reused style object references', () => {
    const el = document.createElement('div')
    const styles: Record<string, string | number> = { color: 'red', marginTop: 1 }

    setStyle(el, styles)
    styles.color = 'blue'
    styles.marginTop = 2
    setStyle(el, styles)

    expect(el.style.color).toBe('blue')
    expect(el.style.marginTop).toBe('2px')
  })
})

const pushCleanup = <T>(log: T[], value: T): void => {
  log.push(value)
}

function createMountFailureFixture() {
  const dependency = createSignal(0)
  const error = new Error('child mount failed')
  let effectRuns = 0
  let destroyRuns = 0

  function Child() {
    createEffect(() => {
      dependency()
      effectRuns++
    })
    onDestroy(() => {
      destroyRuns++
    })
    onMount(() => {
      throw error
    })
    return { type: 'span', props: { children: 'owned child' }, key: undefined }
  }

  return {
    Child,
    dependency,
    error,
    effectRuns: () => effectRuns,
    destroyRuns: () => destroyRuns,
  }
}

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
        bindRef(
          el,
          reactive(() => currentRef()),
        )
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
        bindRef(
          el,
          reactive(() => currentCb()),
        )
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

    it.each([
      { eventName: 'click', bubbles: true },
      { eventName: 'focus', bubbles: false },
    ])('runs $eventName handlers in their owner root', ({ eventName, bubbles }) => {
      const el = document.createElement('button')
      container.appendChild(el)
      let ownerRoot = getCurrentRoot()
      let foreignRoot = getCurrentRoot()
      let handlerRoot = getCurrentRoot()
      let destroyRuns = 0

      const owner = createRoot(() => {
        ownerRoot = getCurrentRoot()
        bindEvent(el, eventName, () => {
          handlerRoot = getCurrentRoot()
          onDestroy(() => {
            destroyRuns++
          })
        })
      })
      const foreign = createRoot(() => {
        foreignRoot = getCurrentRoot()
        el.dispatchEvent(new Event(eventName, { bubbles }))
      })

      expect(handlerRoot).toBe(ownerRoot)
      expect(handlerRoot).not.toBe(foreignRoot)

      foreign.dispose()
      expect(destroyRuns).toBe(0)
      owner.dispose()
      expect(destroyRuns).toBe(1)
    })

    it.each([
      { eventName: 'click', bubbles: true },
      { eventName: 'focus', bubbles: false },
    ])('keeps rootless $eventName handlers rootless', ({ eventName, bubbles }) => {
      const el = document.createElement('button')
      container.appendChild(el)
      let handlerRoot = getCurrentRoot()
      let destroyRuns = 0
      const cleanup = bindEvent(el, eventName, () => {
        handlerRoot = getCurrentRoot()
        onDestroy(() => {
          destroyRuns++
        })
      })

      const foreign = createRoot(() => {
        expect(getCurrentRoot()).toBeDefined()
        el.dispatchEvent(new Event(eventName, { bubbles }))
      })

      expect(handlerRoot).toBeUndefined()
      expect(destroyRuns).toBe(1)
      foreign.dispose()
      expect(destroyRuns).toBe(1)
      cleanup()
    })

    it('runs tuple resolution and invocation in the owner root', () => {
      const el = document.createElement('button')
      container.appendChild(el)
      const observed: Array<[string, ReturnType<typeof getCurrentRoot>]> = []
      let ownerRoot = getCurrentRoot()
      const finalHandler = vi.fn(() => {
        observed.push(['handler', getCurrentRoot()])
      })
      const handlerAccessor = reactive(() => {
        observed.push(['handler-accessor', getCurrentRoot()])
        return finalHandler
      })
      const dataAccessor = () => {
        observed.push(['data-accessor', getCurrentRoot()])
        return 'row-1'
      }

      const owner = createRoot(() => {
        ownerRoot = getCurrentRoot()
        addEventListener(el, 'click', [handlerAccessor, dataAccessor] as any, true)
      })
      const foreign = createRoot(() => {
        el.dispatchEvent(new Event('click', { bubbles: true }))
      })

      expect(observed).toEqual([
        ['handler-accessor', ownerRoot],
        ['data-accessor', ownerRoot],
        ['handler', ownerRoot],
      ])
      expect(finalHandler).toHaveBeenCalledWith('row-1', expect.any(Event))

      foreign.dispose()
      owner.dispose()
    })

    it('preserves handleEvent this and owner root', () => {
      const el = document.createElement('input')
      let ownerRoot = getCurrentRoot()
      let handlerRoot = getCurrentRoot()
      let handlerThis: unknown
      const handler = {
        handleEvent(this: unknown) {
          handlerThis = this
          handlerRoot = getCurrentRoot()
        },
      }

      const owner = createRoot(() => {
        ownerRoot = getCurrentRoot()
        bindEvent(el, 'focus', handler)
      })
      const foreign = createRoot(() => {
        el.dispatchEvent(new Event('focus'))
      })

      expect(handlerThis).toBe(handler)
      expect(handlerRoot).toBe(ownerRoot)

      foreign.dispose()
      owner.dispose()
    })

    it('runs event error handlers in the event owner root', () => {
      const el = document.createElement('button')
      container.appendChild(el)
      const error = new Error('event failed')
      let ownerRoot = getCurrentRoot()
      let errorRoot = getCurrentRoot()
      let errorInfo: { source?: string; eventName?: string } | undefined

      const owner = createRoot(() => {
        ownerRoot = getCurrentRoot()
        registerErrorHandler((received, info) => {
          expect(received).toBe(error)
          errorRoot = getCurrentRoot()
          errorInfo = info
          return true
        })
        bindEvent(el, 'click', () => {
          throw error
        })
      })
      const foreign = createRoot(() => {
        el.dispatchEvent(new Event('click', { bubbles: true }))
      })

      expect(errorRoot).toBe(ownerRoot)
      expect(errorInfo).toMatchObject({ source: 'event', eventName: 'click' })

      foreign.dispose()
      owner.dispose()
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
        bindEvent(
          el,
          'click',
          reactive(() => currentHandler()),
        )
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

    it('formats true as empty string', async () => {
      const text = document.createTextNode('')
      const value = createSignal<string | boolean>('hello')

      bindText(text, () => value())
      expect(text.data).toBe('hello')

      value(true)
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

    it('formats element textContent with text binding semantics', async () => {
      const el = document.createElement('script')
      const value = createSignal<string | boolean | null>('hello')

      setTextContent(el, value())
      expect(el.textContent).toBe('hello')

      bindTextContent(el, () => value())

      value(false)
      await tick()
      expect(el.textContent).toBe('')

      value(null)
      await tick()
      expect(el.textContent).toBe('')

      value('updated')
      await tick()
      expect(el.textContent).toBe('updated')
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

    it('stringifies draggable boolean values', async () => {
      const el = document.createElement('div')
      const draggable = createSignal(false)

      bindAttribute(el, 'draggable', () => draggable())
      await tick()
      expect(el.getAttribute('draggable')).toBe('false')
      expect(el.draggable).toBe(false)

      draggable(true)
      await tick()
      expect(el.getAttribute('draggable')).toBe('true')
      expect(el.draggable).toBe(true)
    })

    it('stringifies boolean values for enumerated editing attributes', async () => {
      const el = document.createElement('div')
      const enabled = createSignal(false)

      bindAttribute(el, 'contentEditable', () => enabled())
      bindAttribute(el, 'spellCheck', () => enabled())
      await tick()
      expect(el.getAttribute('contenteditable')).toBe('false')
      expect(el.getAttribute('spellcheck')).toBe('false')

      enabled(true)
      await tick()
      expect(el.getAttribute('contenteditable')).toBe('true')
      expect(el.getAttribute('spellcheck')).toBe('true')
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

    it('sets and removes namespaced SVG attributes', async () => {
      const xlinkNS = 'http://www.w3.org/1999/xlink'
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'use')
      const href = createSignal<string | null>('#a')

      bindAttribute(el, 'xlink:href', () => href())
      await tick()
      expect(el.getAttributeNS(xlinkNS, 'href')).toBe('#a')

      href(null)
      await tick()
      expect(el.hasAttributeNS(xlinkNS, 'href')).toBe(false)
    })

    it('repairs attributes when DOM is externally mutated but value cache is unchanged', async () => {
      const el = document.createElement('div')
      const attr = createSignal('a')
      const trigger = createSignal(0)

      bindAttribute(el, 'data-x', () => {
        trigger()
        return attr()
      })
      expect(el.getAttribute('data-x')).toBe('a')

      el.removeAttribute('data-x')
      trigger(1)
      await tick()

      expect(el.getAttribute('data-x')).toBe('a')
    })

    it('repairs removed attributes when cached value still removes them', async () => {
      const el = document.createElement('div')
      const attr = createSignal<string | undefined>(undefined)
      const trigger = createSignal(0)

      bindAttribute(el, 'data-x', () => {
        trigger()
        return attr()
      })
      expect(el.hasAttribute('data-x')).toBe(false)

      el.setAttribute('data-x', 'external')
      trigger(1)
      await tick()

      expect(el.hasAttribute('data-x')).toBe(false)
    })
  })

  describe('bindBooleanAttribute', () => {
    it('uses presence semantics even for attributes that normally stringify booleans', async () => {
      const el = document.createElement('div')
      const enabled = createSignal(false)

      setBooleanAttribute(el, 'data-enabled', true)
      expect(el.getAttribute('data-enabled')).toBe('')
      setBooleanAttribute(el, 'data-enabled', false)
      expect(el.hasAttribute('data-enabled')).toBe(false)

      bindBooleanAttribute(el, 'data-enabled', () => enabled())
      expect(el.hasAttribute('data-enabled')).toBe(false)

      enabled(true)
      await tick()
      expect(el.getAttribute('data-enabled')).toBe('')

      enabled(false)
      await tick()
      expect(el.hasAttribute('data-enabled')).toBe(false)
    })
  })

  describe('bindProperty', () => {
    it('unwraps and reactively patches dangerouslySetInnerHTML payloads', async () => {
      const el = document.createElement('div')
      const html = createSignal('<b>first</b>')
      const enabled = createSignal(true)

      bindProperty(el, 'dangerouslySetInnerHTML', () => (enabled() ? { __html: html } : null))
      expect(el.innerHTML).toBe('<b>first</b>')

      html('<i>second</i>')
      await tick()
      expect(el.innerHTML).toBe('<i>second</i>')

      enabled(false)
      await tick()
      expect(el.innerHTML).toBe('')
    })

    it('selects only the first duplicate value in a single select', () => {
      const select = document.createElement('select')
      select.innerHTML =
        '<option value="duplicate">First</option><option value="duplicate">Second</option><option value="other">Other</option>'

      bindProperty(select, 'value', () => 'duplicate')

      expect(select.selectedIndex).toBe(0)
      expect(Array.from(select.options, option => option.selected)).toEqual([true, false, false])
    })

    it('selects only the first duplicate value in a multiple select value assignment', () => {
      const select = document.createElement('select')
      select.multiple = true
      select.innerHTML =
        '<option value="duplicate">First</option><option value="duplicate">Second</option><option value="other">Other</option>'

      bindProperty(select, 'value', () => 'duplicate')

      expect(select.selectedIndex).toBe(0)
      expect(Array.from(select.options, option => option.selected)).toEqual([true, false, false])
    })

    it('clears a single select when no option matches the assigned value', () => {
      const select = document.createElement('select')
      select.innerHTML =
        '<option value="first">First</option><option value="second">Second</option>'

      setProp(select, 'value', 'missing')

      expect(select.value).toBe('')
      expect(select.selectedIndex).toBe(-1)
      expect(Array.from(select.options, option => option.selected)).toEqual([false, false])
    })

    it('keeps value assignments generic for foreign-namespace select elements', () => {
      const select = document.createElementNS('http://www.w3.org/2000/svg', 'select') as Element & {
        options?: unknown[]
        value?: string
      }
      select.options = []

      setProp(select, 'value', 'foreign')

      expect(select.namespaceURI).toBe('http://www.w3.org/2000/svg')
      expect(select.value).toBe('foreign')
    })

    it('uses native option values when an option property is shadowed', () => {
      const select = document.createElement('select')
      select.innerHTML =
        '<option value="real">Real</option><option value="shadowed">Shadowed</option>'
      Object.defineProperty(select.options[0], 'value', {
        configurable: true,
        value: 'shadowed',
      })

      setProp(select, 'value', 'shadowed')
      expect(select.selectedIndex).toBe(1)

      select.options[0]!.selected = true
      setProp(select, 'value', 'shadowed')
      expect(select.selectedIndex).toBe(1)
    })

    it('does not observe customized option getters when the native setter is conforming', () => {
      const select = document.createElement('select')
      select.innerHTML =
        '<option value="first">First</option><option value="second">Second</option>'
      const getter = vi.fn(() => {
        throw new Error('custom option getter should not run')
      })
      Object.defineProperty(select.options[0], 'value', {
        configurable: true,
        get: getter,
      })

      expect(() => setProp(select, 'value', 'second')).not.toThrow()
      expect(getter).not.toHaveBeenCalled()
      expect(select.selectedIndex).toBe(1)
    })

    it('does not observe a shadowed selectedOptions getter after a native assignment', () => {
      const select = document.createElement('select')
      select.innerHTML =
        '<option value="first">First</option><option value="second">Second</option>'
      const getter = vi.fn(() => {
        throw new Error('custom selectedOptions getter should not run')
      })
      Object.defineProperty(select, 'selectedOptions', {
        configurable: true,
        get: getter,
      })

      expect(() => setProp(select, 'value', 'second')).not.toThrow()
      expect(getter).not.toHaveBeenCalled()
      expect(select.selectedIndex).toBe(1)
    })

    it('coerces object select values only once like a native DOMString assignment', () => {
      const select = document.createElement('select')
      select.innerHTML =
        '<option value="first">First</option><option value="second">Second</option>'
      const toString = vi.fn(() => 'first')

      setProp(select, 'value', { toString })

      expect(toString).toHaveBeenCalledTimes(1)
      expect(select.selectedIndex).toBe(0)
    })

    it('passes the original value to a customized select setter', () => {
      const select = document.createElement('select')
      select.innerHTML = '<option value="first">First</option>'
      const assigned: unknown[] = []
      Object.defineProperty(select, 'value', {
        configurable: true,
        get: () => 'custom',
        set: value => assigned.push(value),
      })
      const value = { id: 'opaque-select-value' }

      setProp(select, 'value', value)

      expect(assigned).toEqual([value])
    })

    it('does not read a customized select getter before replaying a cached value', () => {
      const select = document.createElement('select')
      select.innerHTML = '<option value="first">First</option>'
      const getter = vi.fn(() => {
        throw new Error('custom select getter should not run')
      })
      const setter = vi.fn()
      Object.defineProperty(select, 'value', {
        configurable: true,
        get: getter,
        set: setter,
      })

      setProp(select, 'value', 'first')
      expect(() => setProp(select, 'value', 'first')).not.toThrow()

      expect(getter).not.toHaveBeenCalled()
      expect(setter).toHaveBeenCalledTimes(2)
    })

    it('repairs a duplicate select value when the cached text is unchanged', async () => {
      const select = document.createElement('select')
      const trigger = createSignal(0)
      select.innerHTML =
        '<option value="duplicate">First</option><option value="duplicate">Second</option><option value="other">Other</option>'

      bindProperty(select, 'value', () => {
        trigger()
        return 'duplicate'
      })
      select.options[1]!.selected = true
      expect(select.value).toBe('duplicate')

      trigger(1)
      await tick()

      expect(select.selectedIndex).toBe(0)
      expect(Array.from(select.options, option => option.selected)).toEqual([true, false, false])
    })

    it('repairs extra multiple selections when the cached text is unchanged', async () => {
      const select = document.createElement('select')
      const trigger = createSignal(0)
      select.multiple = true
      select.innerHTML =
        '<option value="duplicate">First</option><option value="duplicate">Second</option><option value="other">Other</option>'

      bindProperty(select, 'value', () => {
        trigger()
        return 'duplicate'
      })
      select.options[2]!.selected = true
      expect(select.value).toBe('duplicate')

      trigger(1)
      await tick()

      expect(select.selectedIndex).toBe(0)
      expect(Array.from(select.options, option => option.selected)).toEqual([true, false, false])
    })

    it('rejects Symbol select values like a native DOMString assignment', () => {
      const select = document.createElement('select')
      let thrown: unknown

      try {
        setProp(select, 'value', Symbol('value'))
      } catch (error) {
        thrown = error
      }

      // Web IDL creates the TypeError in the element's realm, which can differ
      // from the runtime/test realm.
      expect(thrown).toMatchObject({ name: 'TypeError' })
    })

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

    it('repairs properties when DOM is externally mutated but value cache is unchanged', async () => {
      const el = document.createElement('input') as HTMLInputElement
      const value = createSignal('a')
      const trigger = createSignal(0)

      bindProperty(el, 'value', () => {
        trigger()
        return value()
      })
      expect(el.value).toBe('a')

      el.value = 'external'
      trigger(1)
      await tick()

      expect(el.value).toBe('a')
    })

    it('repairs property fallback values when cached value still clears them', async () => {
      const el = document.createElement('input') as HTMLInputElement
      const value = createSignal<string | undefined>(undefined)
      const trigger = createSignal(0)

      bindProperty(el, 'value', () => {
        trigger()
        return value()
      })
      expect(el.value).toBe('')

      el.value = 'external'
      trigger(1)
      await tick()

      expect(el.value).toBe('')
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

    it('removes styles deleted from a reused reactive style object', async () => {
      const el = document.createElement('div')
      const tickValue = createSignal(0)
      const styles: Record<string, string | number> = { color: 'red', marginTop: 1 }

      bindStyle(el, () => {
        tickValue()
        return styles
      })
      expect(el.style.color).toBe('red')
      expect(el.style.marginTop).toBe('1px')

      delete styles.color
      tickValue(1)
      await tick()

      expect(el.style.color).toBe('')
      expect(el.style.marginTop).toBe('1px')
    })

    it('handles null/undefined style values in object', async () => {
      const el = document.createElement('div')
      el.style.color = 'red'
      el.style.fontSize = '14px'

      const style = createSignal<Record<string, string | number | null | undefined>>({
        color: 'red',
        fontSize: 14,
      })

      bindStyle(el, () => style() as any)

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

    it('repairs string classes when DOM is externally mutated but value cache is unchanged', async () => {
      const el = document.createElement('div')
      const className = createSignal('foo bar')
      const trigger = createSignal(0)

      bindClass(el, () => {
        trigger()
        return className()
      })
      expect(el.className).toBe('foo bar')

      el.className = 'external'
      trigger(1)
      await tick()

      expect(el.className).toBe('foo bar')
    })

    it('repairs SVG string classes when the class attribute is externally mutated', async () => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      const className = createSignal('hot')
      const trigger = createSignal(0)

      bindClass(el, () => {
        trigger()
        return className()
      })
      expect(el.getAttribute('class')).toBe('hot')

      el.setAttribute('class', 'external')
      trigger(1)
      await tick()

      expect(el.getAttribute('class')).toBe('hot')
      expect((el.className as SVGAnimatedString).baseVal).toBe('hot')
    })

    it('transitions from string to object class', async () => {
      const el = document.createElement('div')
      const classValue = createSignal<string | Record<string, boolean>>('old static-class')

      bindClass(el, () => classValue())
      expect(el.className).toBe('old static-class')

      classValue({ dynamic: true, another: true })
      await tick()
      expect(el.classList.contains('old')).toBe(false)
      expect(el.classList.contains('static-class')).toBe(false)
      expect(el.classList.contains('dynamic')).toBe(true)
      expect(el.classList.contains('another')).toBe(true)
    })

    it('clears string class values when switching to null', async () => {
      const el = document.createElement('div')
      const classValue = createSignal<string | null>('foo old')

      bindClass(el, () => classValue())
      expect(el.className).toBe('foo old')

      classValue(null)
      await tick()
      expect(el.className).toBe('')
    })

    it('clears string class values after object to string to null transitions', async () => {
      const el = document.createElement('div')
      const classValue = createSignal<string | Record<string, boolean> | null>({ active: true })

      bindClass(el, () => classValue())
      expect(el.classList.contains('active')).toBe(true)

      classValue('foo')
      await tick()
      expect(el.className).toBe('foo')

      classValue(null)
      await tick()
      expect(el.className).toBe('')
    })

    it('keeps external static classes for object class bindings', async () => {
      const el = document.createElement('div')
      el.className = 'static-class'
      const classValue = createSignal<Record<string, boolean>>({ active: false })

      bindClass(el, () => classValue())
      expect(el.className).toBe('static-class')

      classValue({ active: true })
      await tick()
      expect(el.classList.contains('static-class')).toBe(true)
      expect(el.classList.contains('active')).toBe(true)
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

    it('updates string class values on SVG elements through the class attribute', async () => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      const classValue = createSignal('hot')

      bindClass(el, () => classValue())
      expect(el.getAttribute('class')).toBe('hot')
      expect((el.className as SVGAnimatedString).baseVal).toBe('hot')

      classValue('cool')
      await tick()
      expect(el.getAttribute('class')).toBe('cool')
      expect((el.className as SVGAnimatedString).baseVal).toBe('cool')
    })

    it('transitions SVG object class maps to string class values', async () => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      const classValue = createSignal<string | Record<string, boolean>>({ active: true })

      bindClass(el, () => classValue())
      expect(el.classList.contains('active')).toBe(true)

      classValue('static-class')
      await tick()
      expect(el.getAttribute('class')).toBe('static-class')
      expect((el.className as SVGAnimatedString).baseVal).toBe('static-class')
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

    it('ignores whitespace-only object class keys', () => {
      const el = document.createElement('div')

      expect(() => bindClass(el, () => ({ '   ': true, valid: true }))).not.toThrow()
      expect(el.classList.contains('valid')).toBe(true)
      expect(el.className).toBe('valid')
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

    it('ignores whitespace-only keys when adding and removing classes', () => {
      const el = document.createElement('div')

      const prev = classList(el, { '   ': true, valid: true })
      expect(el.className).toBe('valid')

      expect(() => classList(el, { '   ': false }, prev)).not.toThrow()
      expect(el.className).toBe('')
    })
  })

  describe('spread', () => {
    it('applies props to an element', () => {
      const el = document.createElement('div')

      spread(el, { class: 'test-class', 'data-id': '123' })

      expect(el.className).toBe('test-class')
      expect(el.getAttribute('data-id')).toBe('123')
    })

    it('repairs unchanged spread DOM state after external mutation', async () => {
      const el = document.createElement('input') as HTMLInputElement
      const trigger = createSignal(0)

      const { dispose } = createRoot(() => {
        spread(
          el,
          () => {
            trigger()
            return { 'data-x': 'a', value: 'owned', class: 'owned' }
          },
          false,
          true,
        )
      })

      expect(el.getAttribute('data-x')).toBe('a')
      expect(el.value).toBe('owned')
      expect(el.className).toBe('owned')

      el.removeAttribute('data-x')
      el.value = 'external'
      el.className = 'external'

      trigger(1)
      await tick()

      expect(el.getAttribute('data-x')).toBe('a')
      expect(el.value).toBe('owned')
      expect(el.className).toBe('owned')

      dispose()
    })

    it('skips unchanged spread attribute writes when the DOM is already current', async () => {
      const el = document.createElement('div')
      const trigger = createSignal(0)

      const { dispose } = createRoot(() => {
        spread(el, () => {
          trigger()
          return { 'data-x': 'a' }
        })
      })

      expect(el.getAttribute('data-x')).toBe('a')
      const setAttribute = vi.spyOn(el, 'setAttribute')

      trigger(1)
      await tick()

      expect(setAttribute).not.toHaveBeenCalled()
      setAttribute.mockRestore()
      dispose()
    })

    it('ignores inherited enumerable props in spread sources', () => {
      const el = document.createElement('button')
      container.appendChild(el)
      const inheritedClick = vi.fn()
      const inheritedRef = vi.fn()
      const proto = {
        title: 'leaked',
        onClick: inheritedClick,
        children: 'leaked',
        ref: inheritedRef,
      }
      const props = Object.create(proto) as Record<string, unknown>
      props.id = 'own'

      const { dispose } = createRoot(() => {
        spread(el, props, false, false)
      })

      expect(el.id).toBe('own')
      expect(el.hasAttribute('title')).toBe(false)
      expect(el.textContent).toBe('')
      expect(inheritedRef).not.toHaveBeenCalled()

      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(inheritedClick).not.toHaveBeenCalled()

      dispose()
    })

    it('removes stale spread props when the next source only inherits them', async () => {
      const el = document.createElement('div')
      const props = createSignal<Record<string, unknown>>({
        title: 'own',
        children: 'own child',
      })

      const { dispose } = createRoot(() => {
        spread(el, () => props(), false, false)
      })

      expect(el.getAttribute('title')).toBe('own')
      expect(el.textContent).toBe('own child')

      const next = Object.create({ title: 'leaked', children: 'leaked child' }) as Record<
        string,
        unknown
      >
      next.id = 'next'
      props(next)
      await tick()

      expect(el.id).toBe('next')
      expect(el.hasAttribute('title')).toBe(false)
      expect(el.textContent).toBe('')

      dispose()
    })

    it('keeps assigned child tracking alive across same-root spread updates', () => {
      const el = document.createElement('div')
      const props = createSignal<Record<string, unknown>>({ children: 'first' })

      const { dispose } = createRoot(() => {
        spread(el, () => props(), false, false)
        expect(el.textContent).toBe('first')

        batch(() => props({ children: 'second' }))
        expect(el.textContent).toBe('second')

        batch(() => props({}))
        expect(el.textContent).toBe('')
      })

      dispose()
    })

    it('applies object class maps from spread class props', () => {
      const el = document.createElement('div')

      spread(el, { class: { active: true, disabled: false } })

      expect(el.classList.contains('active')).toBe(true)
      expect(el.classList.contains('disabled')).toBe(false)
      expect(el.className).not.toBe('[object Object]')
    })

    it('applies object class maps from spread className props', () => {
      const el = document.createElement('div')

      spread(el, { className: { selected: true, hidden: false } })

      expect(el.classList.contains('selected')).toBe(true)
      expect(el.classList.contains('hidden')).toBe(false)
      expect(el.className).not.toBe('[object Object]')
    })

    it('updates reactive spread class maps', async () => {
      const el = document.createElement('div')
      const active = createSignal(true)

      const { dispose } = createRoot(() => {
        spread(el, () => ({ class: { active: active(), inactive: !active() } }))
      })

      expect(el.classList.contains('active')).toBe(true)
      expect(el.classList.contains('inactive')).toBe(false)

      active(false)
      await tick()

      expect(el.classList.contains('active')).toBe(false)
      expect(el.classList.contains('inactive')).toBe(true)
      dispose()
    })

    it('transitions spread class values from object to string and null', async () => {
      const el = document.createElement('div')
      const props = createSignal<Record<string, unknown>>({ class: { active: true } })

      const { dispose } = createRoot(() => {
        spread(el, () => props())
      })

      expect(el.classList.contains('active')).toBe(true)

      props({ class: 'plain' })
      await tick()
      expect(el.className).toBe('plain')

      props({ class: null })
      await tick()
      expect(el.hasAttribute('class')).toBe(false)
      dispose()
    })

    it('sets SVG spread class props through the class attribute', async () => {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      const circleProps = createSignal<Record<string, unknown>>({ class: 'hot' })
      const rectProps = createSignal<Record<string, unknown>>({ className: 'warm' })
      const pathProps = createSignal<Record<string, unknown>>({
        class: { active: true, off: false },
      })

      const { dispose } = createRoot(() => {
        spread(circle, () => circleProps(), true)
        spread(rect, () => rectProps(), true)
        spread(path, () => pathProps(), true)
      })

      await tick()
      expect(circle.getAttribute('class')).toBe('hot')
      expect((circle.className as SVGAnimatedString).baseVal).toBe('hot')
      expect(rect.getAttribute('class')).toBe('warm')
      expect((rect.className as SVGAnimatedString).baseVal).toBe('warm')
      expect(path.classList.contains('active')).toBe(true)
      expect(path.classList.contains('off')).toBe(false)

      circleProps({ class: null })
      rectProps({})
      pathProps({ class: { active: false, off: true } })
      await tick()

      expect(circle.hasAttribute('class')).toBe(false)
      expect(rect.hasAttribute('class')).toBe(false)
      expect(path.classList.contains('active')).toBe(false)
      expect(path.classList.contains('off')).toBe(true)

      dispose()
    })

    it('handles ref callback in props', () => {
      const el = document.createElement('div')
      let refElement: Element | null = null

      spread(el, { ref: (elem: Element) => (refElement = elem) })

      expect(refElement).toBe(el)
    })

    it('skips ref callbacks excluded from spread props', () => {
      const el = document.createElement('div')
      const calls: Array<Element | null> = []

      const { dispose } = createRoot(() => {
        spread(el, { ref: (elem: Element | null) => calls.push(elem) }, false, false, ['ref'])
      })

      expect(calls).toEqual([])
      dispose()
      expect(calls).toEqual([])
    })

    it('keeps spread ref callbacks when no exclusion is present', () => {
      const el = document.createElement('div')
      const calls: Array<Element | null> = []

      const { dispose } = createRoot(() => {
        spread(el, { ref: (elem: Element | null) => calls.push(elem) })
      })

      expect(calls).toEqual([el])
      dispose()
      expect(calls).toEqual([el, null])
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

    it('sets innerHTML from dangerouslySetInnerHTML spread props', async () => {
      const el = document.createElement('div')

      const { dispose } = createRoot(() => {
        spread(el, { dangerouslySetInnerHTML: { __html: '<strong>Bold</strong>' } })
      })

      await tick()
      expect(el.innerHTML).toBe('<strong>Bold</strong>')
      expect(el.hasAttribute('dangerouslysetinnerhtml')).toBe(false)
      dispose()
    })

    it('updates innerHTML from reactive dangerouslySetInnerHTML spread props', async () => {
      const el = document.createElement('div')
      const html = createSignal('<span>a</span>')

      const { dispose } = createRoot(() => {
        spread(el, () => ({ dangerouslySetInnerHTML: { __html: html() } }))
      })

      await tick()
      expect(el.innerHTML).toBe('<span>a</span>')

      html('<em>b</em>')
      await tick()
      expect(el.innerHTML).toBe('<em>b</em>')
      dispose()
    })

    it('updates innerHTML from reactive __html spread getters', async () => {
      const el = document.createElement('div')
      const html = createSignal('<span>a</span>')

      const { dispose } = createRoot(() => {
        spread(el, { dangerouslySetInnerHTML: { __html: reactive(() => html()) } })
      })

      await tick()
      expect(el.innerHTML).toBe('<span>a</span>')

      html('<em>b</em>')
      await tick()
      expect(el.innerHTML).toBe('<em>b</em>')
      dispose()
    })

    it('does not write innerHTML when spread dangerouslySetInnerHTML lacks __html', async () => {
      const el = document.createElement('div')
      el.innerHTML = '<span>keep</span>'

      const { dispose } = createRoot(() => {
        spread(el, { dangerouslySetInnerHTML: {} })
      })

      await tick()
      expect(el.innerHTML).toBe('<span>keep</span>')
      expect(el.hasAttribute('dangerouslysetinnerhtml')).toBe(false)
      dispose()
    })

    it('normalizes SVG camelCase and namespaced spread props', async () => {
      const xlinkNS = 'http://www.w3.org/1999/xlink'
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path')

      const { dispose } = createRoot(() => {
        spread(
          el,
          {
            strokeWidth: 2,
            strokeLinecap: 'round',
            fillRule: 'evenodd',
            clipRule: 'evenodd',
            xlinkHref: '#a',
            viewBox: '0 0 10 10',
          },
          true,
        )
      })

      await tick()
      expect(el.getAttribute('stroke-width')).toBe('2')
      expect(el.getAttribute('stroke-linecap')).toBe('round')
      expect(el.getAttribute('fill-rule')).toBe('evenodd')
      expect(el.getAttribute('clip-rule')).toBe('evenodd')
      expect(el.getAttribute('viewBox')).toBe('0 0 10 10')
      expect(el.getAttributeNS(xlinkNS, 'href')).toBe('#a')
      expect(el.getAttribute('xlink:href')).toBe('#a')
      expect(el.hasAttribute('strokeWidth')).toBe(false)
      expect(el.hasAttribute('xlinkHref')).toBe(false)
      dispose()
    })

    it('sets explicit namespaced spread props without the SVG flag', async () => {
      const xlinkNS = 'http://www.w3.org/1999/xlink'
      const xmlNS = 'http://www.w3.org/XML/1998/namespace'
      const el = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'maction')
      const props = createSignal<Record<string, unknown>>({
        'xlink:href': '#a',
        'xml:lang': 'en',
      })

      const { dispose } = createRoot(() => {
        spread(el, () => props(), false)
      })

      await tick()
      expect(el.getAttributeNS(xlinkNS, 'href')).toBe('#a')
      expect(el.getAttributeNS(xmlNS, 'lang')).toBe('en')
      expect(el.getAttribute('xlink:href')).toBe('#a')
      expect(el.getAttribute('xml:lang')).toBe('en')

      props({ 'xlink:href': null, 'xml:lang': 'fr' })
      await tick()
      expect(el.hasAttributeNS(xlinkNS, 'href')).toBe(false)
      expect(el.getAttributeNS(xmlNS, 'lang')).toBe('fr')

      dispose()
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
        spread(el, { children: reactive(() => message()) }, false, false)
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

    it('keeps later static spread precedence when earlier spread updates', async () => {
      const el = document.createElement('div')
      const first = createSignal<Record<string, unknown>>({ title: 'first' })

      const { dispose } = createRoot(() => {
        spread(el, () => first())
        spread(el, { title: 'second' })
      })

      await tick()
      expect(el.getAttribute('title')).toBe('second')

      first({ title: 'first-updated' })
      await tick()
      expect(el.getAttribute('title')).toBe('second')

      dispose()
    })

    it('keeps later dynamic spread precedence when earlier spread updates', async () => {
      const el = document.createElement('div')
      const first = createSignal<Record<string, unknown>>({ title: 'first' })
      const second = createSignal<Record<string, unknown>>({ title: 'second' })

      const { dispose } = createRoot(() => {
        spread(el, () => first())
        spread(el, () => second())
      })

      await tick()
      expect(el.getAttribute('title')).toBe('second')

      first({ title: 'first-updated' })
      await tick()
      expect(el.getAttribute('title')).toBe('second')

      second({ title: 'second-updated' })
      await tick()
      expect(el.getAttribute('title')).toBe('second-updated')

      dispose()
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

    it('does not accumulate root cleanups when assign churns reactive refs', async () => {
      const el = document.createElement('div')
      const prevProps: Record<string, unknown> = {}
      const root = createRootContext()
      const prev = pushRoot(root)
      const first = { current: null as Element | null }
      const second = { current: null as Element | null }
      const third = { current: null as Element | null }

      try {
        assign(el, { ref: reactive(() => first) }, false, false, prevProps)
        await tick()
        const cleanupCount = root.cleanups.length

        assign(el, { ref: reactive(() => second) }, false, false, prevProps)
        await tick()
        expect(root.cleanups.length).toBe(cleanupCount)
        expect(first.current).toBe(null)
        expect(second.current).toBe(el)

        assign(el, { ref: reactive(() => third) }, false, false, prevProps)
        await tick()
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

    it('removes string on: event attributes when spread props omit them', () => {
      const el = document.createElement('button')
      const prevProps: Record<string, unknown> = {}

      assign(el, { 'on:click': '/handler.js#click' }, false, false, prevProps)
      expect(el.getAttribute('on:click')).toBe('/handler.js#click')

      assign(el, {}, false, false, prevProps)

      expect(el.hasAttribute('on:click')).toBe(false)
    })

    it('removes native on: listeners when switching to string event attributes', () => {
      const el = document.createElement('button')
      const handler = vi.fn()
      const prevProps: Record<string, unknown> = {}

      assign(el, { 'on:click': handler }, false, false, prevProps)
      el.dispatchEvent(new Event('click'))
      expect(handler).toHaveBeenCalledTimes(1)

      assign(el, { 'on:click': '/handler.js#click' }, false, false, prevProps)
      handler.mockClear()
      el.dispatchEvent(new Event('click'))

      expect(handler).not.toHaveBeenCalled()
      expect(el.getAttribute('on:click')).toBe('/handler.js#click')
    })

    it('removes string on: event attributes when switching to native listeners', () => {
      const el = document.createElement('button')
      const handler = vi.fn()
      const prevProps: Record<string, unknown> = {}

      assign(el, { 'on:click': '/handler.js#click' }, false, false, prevProps)
      assign(el, { 'on:click': handler }, false, false, prevProps)
      el.dispatchEvent(new Event('click'))

      expect(el.hasAttribute('on:click')).toBe(false)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('replaces native on: event listeners without leaving stale handlers', () => {
      const el = document.createElement('button')
      const first = vi.fn()
      const second = vi.fn()
      const prevProps: Record<string, unknown> = {}

      assign(el, { 'on:click': first }, false, false, prevProps)
      el.dispatchEvent(new Event('click'))
      expect(first).toHaveBeenCalledTimes(1)

      assign(el, { 'on:click': second }, false, false, prevProps)
      el.dispatchEvent(new Event('click'))

      expect(first).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledTimes(1)
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

    it('keeps lower-case on-prefixed spread props as attributes', () => {
      const el = document.createElement('div')
      container.appendChild(el)
      const handler = vi.fn()

      assign(el, {
        on: 'yes',
        once: 'once-value',
        online: 'online-value',
        onClick: handler,
      })

      expect(el.getAttribute('on')).toBe('yes')
      expect(el.getAttribute('once')).toBe('once-value')
      expect(el.getAttribute('online')).toBe('online-value')
      expect(el.getAttribute('onclick')).toBeNull()

      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(handler).toHaveBeenCalledTimes(1)
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

    it('removes delegated assign handlers when the owner root is disposed', () => {
      const el = document.createElement('button')
      container.appendChild(el)
      const handler = vi.fn()
      const prevProps: Record<string, unknown> = {}

      const root = createRoot(() => {
        assign(el, { onClick: handler }, false, false, prevProps)
      })

      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(handler).toHaveBeenCalledTimes(1)

      root.dispose()
      handler.mockClear()
      el.dispatchEvent(new Event('click', { bubbles: true }))

      expect(handler).not.toHaveBeenCalled()
      expect((el as any).$$click).toBeUndefined()
    })

    it('removes non-delegated assign handlers when the owner root is disposed', () => {
      const el = document.createElement('input')
      const handler = vi.fn()
      const prevProps: Record<string, unknown> = {}

      const root = createRoot(() => {
        assign(el, { onFocus: handler }, false, false, prevProps)
      })

      el.dispatchEvent(new Event('focus'))
      expect(handler).toHaveBeenCalledTimes(1)

      root.dispose()
      handler.mockClear()
      el.dispatchEvent(new Event('focus'))

      expect(handler).not.toHaveBeenCalled()
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

    it('restores currentTarget after delegated dispatch', () => {
      const el = document.createElement('button')
      const event = new Event('click', { bubbles: true })
      let observedCurrentTarget: EventTarget | null = null
      container.appendChild(el)
      delegateEvents(['click'])
      ;(el as any).$$click = (received: Event) => {
        observedCurrentTarget = received.currentTarget
      }

      el.dispatchEvent(event)

      expect(observedCurrentTarget).toBe(el)
      expect(event.currentTarget).toBeNull()
      expect(Object.prototype.hasOwnProperty.call(event, 'currentTarget')).toBe(false)
    })

    it('restores target when the same Event is dispatched at different elements', () => {
      const first = document.createElement('button')
      const second = document.createElement('button')
      first.id = 'first'
      second.id = 'second'
      container.append(first, second)
      delegateEvents(['click'])

      const delegatedTargets: string[] = []
      const documentTargets: string[] = []
      ;(first as any).$$click = (event: Event) => {
        delegatedTargets.push((event.target as Element).id)
      }
      ;(second as any).$$click = (event: Event) => {
        delegatedTargets.push((event.target as Element).id)
      }
      const observeDocumentTarget = (event: Event) => {
        documentTargets.push((event.target as Element).id)
      }
      document.addEventListener('click', observeDocumentTarget)

      try {
        const event = new Event('click', { bubbles: true })
        expect(Object.prototype.hasOwnProperty.call(event, 'target')).toBe(false)

        first.dispatchEvent(event)
        second.dispatchEvent(event)

        expect(delegatedTargets).toEqual(['first', 'second'])
        expect(documentTargets).toEqual(['first', 'second'])
        expect(event.target).toBe(second)
        expect(Object.prototype.hasOwnProperty.call(event, 'target')).toBe(false)
      } finally {
        document.removeEventListener('click', observeDocumentTarget)
      }
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

    it('removes delegated bindEvent handlers when the owner root is disposed', () => {
      const el = document.createElement('button')
      container.appendChild(el)
      const handler = vi.fn()

      const root = createRoot(() => {
        bindEvent(el, 'click', handler)
      })

      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(handler).toHaveBeenCalledTimes(1)

      root.dispose()
      handler.mockClear()
      el.dispatchEvent(new Event('click', { bubbles: true }))

      expect(handler).not.toHaveBeenCalled()
      expect((el as any).$$click).toBeUndefined()
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

    it('passes undefined as explicit plain tuple data', () => {
      const el = document.createElement('button')
      const handler = vi.fn()
      container.appendChild(el)
      delegateEvents(['click'])

      addEventListener(el, 'click', [handler, undefined] as any, true)

      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(handler).toHaveBeenCalledWith(undefined, expect.any(Event))
    })

    it('passes undefined returned by tuple data getters', () => {
      const el = document.createElement('button')
      const handler = vi.fn()
      container.appendChild(el)
      delegateEvents(['click'])

      addEventListener(el, 'click', [handler, () => undefined] as any, true)

      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(handler).toHaveBeenCalledWith(undefined, expect.any(Event))
    })

    it('treats missing tuple data as no data', () => {
      const el = document.createElement('button')
      const handler = vi.fn()
      container.appendChild(el)
      delegateEvents(['click'])

      addEventListener(el, 'click', [handler] as any, true)

      const event = new Event('click', { bubbles: true })
      el.dispatchEvent(event)
      expect(handler).toHaveBeenCalledWith(event)
    })

    it.each([null, false, 0])('keeps %s as explicit tuple data', data => {
      const el = document.createElement('button')
      const handler = vi.fn()
      container.appendChild(el)
      delegateEvents(['click'])

      addEventListener(el, 'click', [handler, data] as any, true)

      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(handler).toHaveBeenCalledWith(data, expect.any(Event))
    })

    it('handles compiler-tagged delegated data without adding the event argument', () => {
      const el = document.createElement('button')
      const data = { id: 123 }
      let observed: { length: number; value: unknown; second: unknown; rest: unknown[] } | undefined
      container.appendChild(el)
      delegateEvents(['click'])

      function handler(value: unknown, second = 'default', ...rest: unknown[]) {
        observed = { length: arguments.length, value, second, rest }
      }

      addEventListener(el, 'click', [handler, data, '__fictDataOnly'] as any, true)

      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(observed).toEqual({ length: 1, value: data, second: 'default', rest: [] })
    })

    it('passes undefined as an explicit compiler-tagged data argument', () => {
      const el = document.createElement('button')
      let observed: { length: number; value: unknown } | undefined
      container.appendChild(el)
      delegateEvents(['click'])

      function handler(value: unknown) {
        observed = { length: arguments.length, value }
      }

      addEventListener(el, 'click', [handler, undefined, '__fictDataOnly'] as any, true)

      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(observed).toEqual({ length: 1, value: undefined })
    })

    it('handles compiler-tagged delegated data with plain-call this semantics', () => {
      const el = document.createElement('button')
      const data = { id: 123 }
      let thisValue: unknown = 'unset'
      container.appendChild(el)
      delegateEvents(['click'])

      function handler(this: unknown) {
        thisValue = this
      }

      addEventListener(el, 'click', [handler, data, '__fictDataOnlyPlain'] as any, true)

      el.dispatchEvent(new Event('click', { bubbles: true }))
      expect(thisValue).toBeUndefined()
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

      callEventHandler(handler as any, event, null, 'test-data')

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
          props: { children: reactive(() => counter()) },
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
      expect(container.querySelector('div')).not.toBe(firstDiv)

      counter(2)
      await tick()
      expect(container.textContent).toBe('E')
      expect(logs).toEqual(['even', 'odd', 'even'])
      expect(container.querySelector('div')).not.toBe(firstDiv)

      dispose()
    })

    it('does not double-run side effects when remount fallback is needed', async () => {
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

    it('remounts nested fragment arrays for tracked branch reads', async () => {
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
      expect(spansAfter[0]).not.toBe(spansBefore[0])
      expect(spansAfter[1]).not.toBe(spansBefore[1])

      dispose()
    })

    it('remounts event handlers so tracked branch callbacks see current closures', async () => {
      const condition = createSignal(true)
      const counter = createSignal(0)
      const clicks: number[] = []

      const { marker, dispose, flush } = createConditional(
        () => condition(),
        () => {
          const value = counter()
          return {
            type: 'button',
            props: {
              onClick: () => clicks.push(value),
              children: String(value),
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

      const firstButton = container.querySelector('button')
      expect(firstButton).not.toBeNull()
      firstButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(clicks).toEqual([0])

      counter(1)
      await tick()

      const secondButton = container.querySelector('button')
      expect(secondButton).not.toBeNull()
      expect(secondButton).not.toBe(firstButton)
      expect(secondButton!.textContent).toBe('1')
      secondButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(clicks).toEqual([0, 1])

      dispose()
    })

    it('clears old refs and assigns new refs on tracked branch remount', async () => {
      const condition = createSignal(true)
      const counter = createSignal(0)
      const refCalls: Array<Element | null> = []

      const { marker, dispose, flush } = createConditional(
        () => condition(),
        () => {
          const value = counter()
          return {
            type: 'div',
            props: {
              ref: (el: Element | null) => refCalls.push(el),
              children: String(value),
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

      const firstDiv = container.querySelector('div')
      expect(refCalls).toEqual([firstDiv])

      counter(1)
      await tick()

      const secondDiv = container.querySelector('div')
      expect(secondDiv).not.toBeNull()
      expect(secondDiv).not.toBe(firstDiv)
      expect(refCalls).toEqual([firstDiv, null, secondDiv])

      dispose()
      expect(refCalls).toEqual([firstDiv, null, secondDiv, null])
    })

    it('applies object style and classList from remounted tracked branches', async () => {
      const condition = createSignal(true)
      const counter = createSignal(0)

      const { marker, dispose, flush } = createConditional(
        () => condition(),
        () => {
          const value = counter()
          return {
            type: 'div',
            props: {
              style: { color: value % 2 === 0 ? 'blue' : 'red' },
              classList: { active: value % 2 === 1 },
              children: String(value),
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

      const firstDiv = container.querySelector('div') as HTMLElement | null
      expect(firstDiv).not.toBeNull()
      expect(firstDiv!.style.color).toBe('blue')
      expect(firstDiv!.classList.contains('active')).toBe(false)

      counter(1)
      await tick()

      const secondDiv = container.querySelector('div') as HTMLElement | null
      expect(secondDiv).not.toBeNull()
      expect(secondDiv).not.toBe(firstDiv)
      expect(secondDiv!.style.color).toBe('red')
      expect(secondDiv!.classList.contains('active')).toBe(true)

      dispose()
    })

    it('removes omitted props when tracked branches remount', async () => {
      const condition = createSignal(true)
      const counter = createSignal(0)

      const { marker, dispose, flush } = createConditional(
        () => condition(),
        () => {
          const value = counter()
          return {
            type: 'button',
            props: value === 0 ? { disabled: true, children: 'off' } : { children: 'on' },
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

      const firstButton = container.querySelector('button') as HTMLButtonElement | null
      expect(firstButton).not.toBeNull()
      expect(firstButton!.disabled).toBe(true)

      counter(1)
      await tick()

      const secondButton = container.querySelector('button') as HTMLButtonElement | null
      expect(secondButton).not.toBeNull()
      expect(secondButton).not.toBe(firstButton)
      expect(secondButton!.disabled).toBe(false)
      expect(secondButton!.textContent).toBe('on')

      dispose()
    })

    it('runs branch-local cleanup before tracked branch remount', async () => {
      const condition = createSignal(true)
      const counter = createSignal(0)
      const cleanupLog: number[] = []

      const { marker, dispose, flush } = createConditional(
        () => condition(),
        () => {
          const value = counter()
          onDestroy(() => pushCleanup(cleanupLog, value))
          return {
            type: 'div',
            props: { children: String(value) },
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

      expect(cleanupLog).toEqual([])

      counter(1)
      await tick()
      expect(cleanupLog).toEqual([0])

      counter(2)
      await tick()
      expect(cleanupLog).toEqual([0, 1])

      dispose()
      expect(cleanupLog).toEqual([0, 1, 2])
    })

    it('keeps the old branch interactive when tracked remount DOM creation is handled as an error', async () => {
      const condition = createSignal(true)
      const counter = createSignal(0)
      const clicks: number[] = []
      const errors: unknown[] = []
      const cleanupLog: number[] = []
      const createElementMaybeThrow: typeof createElement = node => {
        if (
          typeof node === 'object' &&
          node !== null &&
          'props' in node &&
          (node as { props?: { children?: unknown } }).props?.children === '1'
        ) {
          throw new Error('remount failed')
        }
        return createElement(node)
      }

      const root = createRoot(() => {
        registerErrorHandler(err => {
          errors.push(err)
          return true
        })

        const handle = createConditional(
          () => condition(),
          () => {
            const value = counter()
            onDestroy(() => pushCleanup(cleanupLog, value))
            return {
              type: 'button',
              props: {
                onClick: () => clicks.push(value),
                children: String(value),
              },
              key: undefined,
            }
          },
          createElementMaybeThrow,
          () => 'OFF',
          undefined,
          undefined,
          { trackBranchReads: true },
        )
        container.appendChild(handle.marker)
        handle.flush?.()
        onDestroy(handle.dispose)
      })

      const firstButton = container.querySelector('button')
      expect(firstButton).not.toBeNull()
      firstButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(clicks).toEqual([0])

      counter(1)
      await tick()

      expect(errors).toHaveLength(1)
      expect(cleanupLog).toEqual([1])
      expect(container.textContent).toBe('0')
      expect(container.querySelector('button')).toBe(firstButton)
      firstButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(clicks).toEqual([0, 0])

      root.dispose()
      expect(cleanupLog).toEqual([1, 0])
    })

    it('keeps the old branch interactive when tracked remount DOM creation suspends', async () => {
      const condition = createSignal(true)
      const counter = createSignal(0)
      const token = Promise.resolve()
      const handledTokens: unknown[] = []
      const clicks: number[] = []
      const createElementMaybeSuspend: typeof createElement = node => {
        if (
          typeof node === 'object' &&
          node !== null &&
          'props' in node &&
          (node as { props?: { children?: unknown } }).props?.children === '1'
        ) {
          throw token
        }
        return createElement(node)
      }

      const root = createRoot(() => {
        registerSuspenseHandler(nextToken => {
          handledTokens.push(nextToken)
          return true
        })

        const handle = createConditional(
          () => condition(),
          () => {
            const value = counter()
            return {
              type: 'button',
              props: {
                onClick: () => clicks.push(value),
                children: String(value),
              },
              key: undefined,
            }
          },
          createElementMaybeSuspend,
          () => 'OFF',
          undefined,
          undefined,
          { trackBranchReads: true },
        )
        container.appendChild(handle.marker)
        handle.flush?.()
        onDestroy(handle.dispose)
      })

      const firstButton = container.querySelector('button')
      expect(firstButton).not.toBeNull()
      firstButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(clicks).toEqual([0])

      counter(1)
      await tick()

      expect(handledTokens).toEqual([token])
      expect(container.textContent).toBe('0')
      expect(container.querySelector('button')).toBe(firstButton)
      firstButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(clicks).toEqual([0, 0])

      root.dispose()
    })

    it('commits ErrorBoundary fallback output during tracked branch remount', async () => {
      const condition = createSignal(true)
      const counter = createSignal(0)
      const errors: unknown[] = []

      function Child() {
        const value = counter()
        if (value === 1) {
          throw new Error('child failed')
        }
        return { type: 'button', props: { children: String(value) }, key: undefined }
      }

      const { marker, dispose, flush } = createConditional(
        () => condition(),
        () => {
          counter()
          return {
            type: ErrorBoundary as any,
            props: {
              fallback: { type: 'span', props: { children: 'caught' }, key: undefined },
              onError: (err: unknown) => errors.push(err),
              children: { type: Child, props: {}, key: undefined },
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

      expect(container.textContent).toBe('0')
      expect(container.querySelector('button')).not.toBeNull()

      counter(1)
      await tick()

      expect(errors).toHaveLength(1)
      expect(container.textContent).toBe('caught')
      expect(container.querySelector('button')).toBeNull()
      expect(container.querySelector('span')).not.toBeNull()

      dispose()
    })

    it('keeps the old branch interactive when ordinary branch flip render fails', async () => {
      const condition = createSignal(true)
      const renderError = new Error('flip render failed')
      const errors: unknown[] = []
      const clicks: string[] = []
      const cleanupLog: string[] = []

      const root = createRoot(() => {
        registerErrorHandler(err => {
          errors.push(err)
          return true
        })

        const handle = createConditional(
          () => condition(),
          () => {
            onDestroy(() => pushCleanup(cleanupLog, 'old'))
            return {
              type: 'button',
              props: {
                onClick: () => clicks.push('old'),
                children: 'old',
              },
              key: undefined,
            }
          },
          createElement,
          () => {
            onDestroy(() => pushCleanup(cleanupLog, 'new'))
            throw renderError
          },
        )
        container.appendChild(handle.marker)
        handle.flush?.()
        onDestroy(handle.dispose)
      })

      const oldButton = container.querySelector('button')
      expect(oldButton).not.toBeNull()
      oldButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(clicks).toEqual(['old'])

      condition(false)
      await tick()

      expect(errors).toEqual([renderError])
      expect(cleanupLog).toEqual(['new'])
      expect(container.textContent).toBe('old')
      expect(container.querySelector('button')).toBe(oldButton)
      oldButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(clicks).toEqual(['old', 'old'])

      root.dispose()
      expect(cleanupLog).toEqual(['new', 'old'])
    })

    it('keeps the old branch interactive when ordinary branch flip DOM creation fails', async () => {
      const condition = createSignal(true)
      const createError = new Error('flip create failed')
      const errors: unknown[] = []
      const clicks: string[] = []
      const cleanupLog: string[] = []
      const createElementMaybeThrow: typeof createElement = node => {
        if (
          typeof node === 'object' &&
          node !== null &&
          'props' in node &&
          (node as { props?: { children?: unknown } }).props?.children === 'new'
        ) {
          throw createError
        }
        return createElement(node)
      }

      const root = createRoot(() => {
        registerErrorHandler(err => {
          errors.push(err)
          return true
        })

        const handle = createConditional(
          () => condition(),
          () => {
            onDestroy(() => pushCleanup(cleanupLog, 'old'))
            return {
              type: 'button',
              props: {
                onClick: () => clicks.push('old'),
                children: 'old',
              },
              key: undefined,
            }
          },
          createElementMaybeThrow,
          () => {
            onDestroy(() => pushCleanup(cleanupLog, 'new'))
            return { type: 'button', props: { children: 'new' }, key: undefined }
          },
        )
        container.appendChild(handle.marker)
        handle.flush?.()
        onDestroy(handle.dispose)
      })

      const oldButton = container.querySelector('button')
      expect(oldButton).not.toBeNull()

      condition(false)
      await tick()

      expect(errors).toEqual([createError])
      expect(cleanupLog).toEqual(['new'])
      expect(container.textContent).toBe('old')
      expect(container.querySelector('button')).toBe(oldButton)
      oldButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(clicks).toEqual(['old'])

      root.dispose()
      expect(cleanupLog).toEqual(['new', 'old'])
    })

    it('keeps the old branch interactive when ordinary branch flip insertion fails', async () => {
      const condition = createSignal(true)
      const insertError = new Error('flip insert failed')
      const errors: unknown[] = []
      const clicks: string[] = []
      const cleanupLog: string[] = []
      const originalInsertBefore = container.insertBefore.bind(container)
      let failInsert = false

      container.insertBefore = ((node: Node, child: Node | null) => {
        if (failInsert && node.nodeType === Node.ELEMENT_NODE && node.textContent === 'new') {
          throw insertError
        }
        return originalInsertBefore(node, child)
      }) as typeof container.insertBefore

      try {
        const root = createRoot(() => {
          registerErrorHandler(err => {
            errors.push(err)
            return true
          })

          const handle = createConditional(
            () => condition(),
            () => {
              onDestroy(() => pushCleanup(cleanupLog, 'old'))
              return {
                type: 'button',
                props: {
                  onClick: () => clicks.push('old'),
                  children: 'old',
                },
                key: undefined,
              }
            },
            createElement,
            () => {
              onDestroy(() => pushCleanup(cleanupLog, 'new'))
              return { type: 'button', props: { children: 'new' }, key: undefined }
            },
          )
          container.appendChild(handle.marker)
          handle.flush?.()
          onDestroy(handle.dispose)
        })

        const oldButton = container.querySelector('button')
        expect(oldButton).not.toBeNull()

        failInsert = true
        condition(false)
        await tick()

        expect(errors).toEqual([insertError])
        expect(cleanupLog).toEqual(['new'])
        expect(container.textContent).toBe('old')
        expect(container.querySelector('button')).toBe(oldButton)
        oldButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        expect(clicks).toEqual(['old'])

        root.dispose()
        expect(cleanupLog).toEqual(['new', 'old'])
      } finally {
        container.insertBefore = originalInsertBefore as typeof container.insertBefore
      }
    })

    it('removes partially inserted nodes when ordinary branch flip insertion fails', async () => {
      const condition = createSignal(true)
      const insertError = new Error('flip partial insert failed')
      const errors: unknown[] = []
      const cleanupLog: string[] = []
      const originalInsertBefore = container.insertBefore.bind(container)
      let failInsert = false

      container.insertBefore = ((node: Node, child: Node | null) => {
        if (failInsert && node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
          const first = node.firstChild
          if (first) {
            originalInsertBefore(first, child)
          }
          throw insertError
        }
        return originalInsertBefore(node, child)
      }) as typeof container.insertBefore

      try {
        const root = createRoot(() => {
          registerErrorHandler(err => {
            errors.push(err)
            return true
          })

          const handle = createConditional(
            () => condition(),
            () => {
              onDestroy(() => pushCleanup(cleanupLog, 'old'))
              return { type: 'button', props: { children: 'old' }, key: undefined }
            },
            createElement,
            () => {
              onDestroy(() => pushCleanup(cleanupLog, 'new'))
              return {
                type: Fragment,
                props: {
                  children: [
                    { type: 'span', props: { children: 'new-a' }, key: undefined },
                    { type: 'span', props: { children: 'new-b' }, key: undefined },
                  ],
                },
                key: undefined,
              }
            },
          )
          container.appendChild(handle.marker)
          handle.flush?.()
          onDestroy(handle.dispose)
        })

        expect(container.textContent).toBe('old')

        failInsert = true
        condition(false)
        await tick()

        expect(errors).toEqual([insertError])
        expect(cleanupLog).toEqual(['new'])
        expect(container.textContent).toBe('old')
        expect(container.querySelectorAll('span')).toHaveLength(0)

        root.dispose()
        expect(cleanupLog).toEqual(['new', 'old'])
      } finally {
        container.insertBefore = originalInsertBefore as typeof container.insertBefore
      }
    })

    it('keeps new branch ownership when ordinary branch flip ref assignment throws', async () => {
      const condition = createSignal(true)
      const refError = new Error('flip ref failed')
      const errors: unknown[] = []
      const cleanupLog: string[] = []

      const root = createRoot(() => {
        registerErrorHandler(err => {
          errors.push(err)
          return true
        })

        const handle = createConditional(
          () => condition(),
          () => {
            onDestroy(() => pushCleanup(cleanupLog, 'old'))
            return { type: 'button', props: { children: 'old' }, key: undefined }
          },
          createElement,
          () => {
            onDestroy(() => pushCleanup(cleanupLog, 'new'))
            return {
              type: 'button',
              props: {
                ref: (el: Element | null) => {
                  if (el) {
                    throw refError
                  }
                },
                children: 'new',
              },
              key: undefined,
            }
          },
        )
        container.appendChild(handle.marker)
        handle.flush?.()
        onDestroy(handle.dispose)
      })

      expect(container.textContent).toBe('old')

      condition(false)
      await tick()

      expect(errors).toEqual([refError])
      expect(cleanupLog).toEqual(['old'])
      expect(container.textContent).toBe('new')
      expect(container.querySelector('button')?.textContent).toBe('new')

      root.dispose()
      expect(cleanupLog).toEqual(['old', 'new'])
    })

    it('keeps new branch ownership when ordinary branch flip onMount throws', async () => {
      const condition = createSignal(true)
      const mountError = new Error('flip mount failed')
      const errors: unknown[] = []
      const cleanupLog: string[] = []

      function NewBranch() {
        onMount(() => {
          throw mountError
        })
        onDestroy(() => pushCleanup(cleanupLog, 'new'))
        return { type: 'button', props: { children: 'new' }, key: undefined }
      }

      const root = createRoot(() => {
        registerErrorHandler(err => {
          errors.push(err)
          return true
        })

        const handle = createConditional(
          () => condition(),
          () => {
            onDestroy(() => pushCleanup(cleanupLog, 'old'))
            return { type: 'button', props: { children: 'old' }, key: undefined }
          },
          createElement,
          () => ({ type: NewBranch, props: {}, key: undefined }),
        )
        container.appendChild(handle.marker)
        handle.flush?.()
        onDestroy(handle.dispose)
      })

      expect(container.textContent).toBe('old')

      condition(false)
      await tick()

      expect(errors).toEqual([mountError])
      expect(cleanupLog).toEqual(['old'])
      expect(container.textContent).toBe('new')

      root.dispose()
      expect(cleanupLog).toEqual(['old', 'new'])
    })

    it('keeps new branch ownership when old branch cleanup throws after commit', async () => {
      const condition = createSignal(true)
      const cleanupError = new Error('old cleanup failed')
      const errors: unknown[] = []
      const cleanupLog: string[] = []

      const root = createRoot(() => {
        registerErrorHandler(err => {
          errors.push(err)
          return true
        })

        const handle = createConditional(
          () => condition(),
          () => {
            onDestroy(() => {
              cleanupLog.push('old')
              throw cleanupError
            })
            return { type: 'button', props: { children: 'old' }, key: undefined }
          },
          createElement,
          () => {
            onDestroy(() => pushCleanup(cleanupLog, 'new'))
            return { type: 'button', props: { children: 'new' }, key: undefined }
          },
        )
        container.appendChild(handle.marker)
        handle.flush?.()
        onDestroy(handle.dispose)
      })

      expect(container.textContent).toBe('old')

      condition(false)
      await tick()

      expect(errors).toEqual([cleanupError])
      expect(cleanupLog).toEqual(['old'])
      expect(container.textContent).toBe('new')
      expect(container.querySelector('button')?.textContent).toBe('new')

      root.dispose()
      expect(cleanupLog).toEqual(['old', 'new'])
    })

    it('tracks cloned branch nodes returned by insertion fallback', async () => {
      const condition = createSignal(false)
      const newButton = document.createElement('button')
      newButton.textContent = 'new'
      const originalInsertBefore = container.insertBefore.bind(container)

      container.insertBefore = ((node: Node, child: Node | null) => {
        if (node === newButton) {
          throw new Error('force clone fallback')
        }
        return originalInsertBefore(node, child)
      }) as typeof container.insertBefore

      try {
        const handle = createConditional(
          () => condition(),
          () => newButton as any,
          value => (value instanceof Node ? value : createElement(value)),
        )
        container.appendChild(handle.marker)
        handle.flush?.()

        expect(container.textContent).toBe('')

        condition(true)
        await tick()

        const inserted = container.querySelector('button')
        expect(inserted).not.toBeNull()
        expect(inserted).not.toBe(newButton)
        expect(container.textContent).toBe('new')

        condition(false)
        await tick()

        expect(container.querySelector('button')).toBeNull()
        expect(container.textContent).toBe('')

        handle.dispose()
      } finally {
        container.insertBefore = originalInsertBefore as typeof container.insertBefore
      }
    })

    it('commits ErrorBoundary fallback output during ordinary branch flip', async () => {
      const condition = createSignal(true)
      const errors: unknown[] = []

      function Child() {
        throw new Error('ordinary child failed')
      }

      const { marker, dispose, flush } = createConditional(
        () => condition(),
        () => ({ type: 'button', props: { children: 'old' }, key: undefined }),
        createElement,
        () => ({
          type: ErrorBoundary as any,
          props: {
            fallback: { type: 'span', props: { children: 'caught' }, key: undefined },
            onError: (err: unknown) => errors.push(err),
            children: { type: Child, props: {}, key: undefined },
          },
          key: undefined,
        }),
      )
      container.appendChild(marker)
      flush?.()

      expect(container.textContent).toBe('old')

      condition(false)
      await tick()

      expect(errors).toHaveLength(1)
      expect(container.textContent).toBe('caught')
      expect(container.querySelector('button')).toBeNull()
      expect(container.querySelector('span')).not.toBeNull()

      dispose()
    })

    it('keeps the old branch interactive when tracked remount insertion fails', async () => {
      const condition = createSignal(true)
      const counter = createSignal(0)
      const insertError = new Error('insert failed')
      const errors: unknown[] = []
      const clicks: number[] = []
      const cleanupLog: number[] = []
      const originalInsertBefore = container.insertBefore.bind(container)
      let failInsert = false

      container.insertBefore = ((node: Node, child: Node | null) => {
        if (failInsert && node.nodeType === Node.ELEMENT_NODE && node.textContent === '1') {
          throw insertError
        }
        return originalInsertBefore(node, child)
      }) as typeof container.insertBefore

      try {
        const root = createRoot(() => {
          registerErrorHandler(err => {
            errors.push(err)
            return true
          })

          const handle = createConditional(
            () => condition(),
            () => {
              const value = counter()
              onDestroy(() => pushCleanup(cleanupLog, value))
              return {
                type: 'button',
                props: {
                  onClick: () => clicks.push(value),
                  children: String(value),
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
          container.appendChild(handle.marker)
          handle.flush?.()
          onDestroy(handle.dispose)
        })

        const firstButton = container.querySelector('button')
        expect(firstButton).not.toBeNull()
        firstButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        expect(clicks).toEqual([0])

        failInsert = true
        counter(1)
        await tick()

        expect(errors).toEqual([insertError])
        expect(cleanupLog).toEqual([1])
        expect(container.textContent).toBe('0')
        expect(container.querySelector('button')).toBe(firstButton)
        firstButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        expect(clicks).toEqual([0, 0])

        root.dispose()
        expect(cleanupLog).toEqual([1, 0])
      } finally {
        container.insertBefore = originalInsertBefore as typeof container.insertBefore
      }
    })

    it('removes partially inserted nodes when tracked remount insertion fails', async () => {
      const condition = createSignal(true)
      const counter = createSignal(0)
      const insertError = new Error('partial insert failed')
      const errors: unknown[] = []
      const cleanupLog: number[] = []
      const originalInsertBefore = container.insertBefore.bind(container)
      let failInsert = false

      container.insertBefore = ((node: Node, child: Node | null) => {
        if (failInsert && node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
          const first = node.firstChild
          if (first) {
            originalInsertBefore(first, child)
          }
          throw insertError
        }
        return originalInsertBefore(node, child)
      }) as typeof container.insertBefore

      try {
        const root = createRoot(() => {
          registerErrorHandler(err => {
            errors.push(err)
            return true
          })

          const handle = createConditional(
            () => condition(),
            () => {
              const value = counter()
              onDestroy(() => pushCleanup(cleanupLog, value))
              return value === 0
                ? { type: 'span', props: { children: '0' }, key: undefined }
                : {
                    type: Fragment,
                    props: {
                      children: [
                        { type: 'span', props: { children: '1A' }, key: undefined },
                        { type: 'span', props: { children: '1B' }, key: undefined },
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
          container.appendChild(handle.marker)
          handle.flush?.()
          onDestroy(handle.dispose)
        })

        expect(container.textContent).toBe('0')

        failInsert = true
        counter(1)
        await tick()

        expect(errors).toEqual([insertError])
        expect(cleanupLog).toEqual([1])
        expect(container.textContent).toBe('0')
        expect(container.querySelectorAll('span')).toHaveLength(1)

        root.dispose()
        expect(cleanupLog).toEqual([1, 0])
      } finally {
        container.insertBefore = originalInsertBefore as typeof container.insertBefore
      }
    })

    it('keeps new branch ownership when deferred ref assignment throws', async () => {
      const condition = createSignal(true)
      const counter = createSignal(0)
      const refError = new Error('ref failed')
      const errors: unknown[] = []
      const cleanupLog: number[] = []
      const refValues: Array<string | null> = []

      const root = createRoot(() => {
        registerErrorHandler(err => {
          errors.push(err)
          return true
        })

        const handle = createConditional(
          () => condition(),
          () => {
            const value = counter()
            onDestroy(() => pushCleanup(cleanupLog, value))
            return {
              type: 'button',
              props: {
                ref: (el: Element | null) => {
                  refValues.push(el?.textContent ?? null)
                  if (value === 1 && el) {
                    throw refError
                  }
                },
                children: String(value),
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
        container.appendChild(handle.marker)
        handle.flush?.()
        onDestroy(handle.dispose)
      })

      expect(container.textContent).toBe('0')
      expect(refValues).toEqual([''])

      counter(1)
      await tick()

      expect(errors).toEqual([refError])
      expect(cleanupLog).toEqual([0])
      expect(container.textContent).toBe('1')

      root.dispose()
      expect(cleanupLog).toEqual([0, 1])
    })

    it('keeps new branch ownership when onMount throws after tracked remount', async () => {
      const condition = createSignal(true)
      const counter = createSignal(0)
      const mountError = new Error('mount failed')
      const errors: unknown[] = []
      const cleanupLog: number[] = []
      const mounts: number[] = []

      function Child() {
        const value = counter()
        onMount(() => {
          if (value === 1) {
            throw mountError
          }
          mounts.push(value)
        })
        onDestroy(() => pushCleanup(cleanupLog, value))
        return { type: 'button', props: { children: String(value) }, key: undefined }
      }

      const root = createRoot(() => {
        registerErrorHandler(err => {
          errors.push(err)
          return true
        })

        const handle = createConditional(
          () => condition(),
          () => {
            counter()
            return { type: Child, props: {}, key: undefined }
          },
          createElement,
          () => 'OFF',
          undefined,
          undefined,
          { trackBranchReads: true },
        )
        container.appendChild(handle.marker)
        handle.flush?.()
        onDestroy(handle.dispose)
      })

      expect(container.textContent).toBe('0')
      expect(mounts).toEqual([0])

      counter(1)
      await tick()

      expect(errors).toEqual([mountError])
      expect(cleanupLog).toEqual([0])
      expect(container.textContent).toBe('1')

      root.dispose()
      expect(cleanupLog).toEqual([0, 1])
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

  describe('materializer mount ownership', () => {
    it('keeps insert ownership when child onMount is handled', async () => {
      const parent = document.createElement('div')
      const fixture = createMountFailureFixture()
      const errors: unknown[] = []
      const root = createRoot(() => {
        registerErrorHandler(error => {
          errors.push(error)
          return true
        })
        insert(parent, () => ({ type: fixture.Child, props: {}, key: undefined }), createElement)
      })

      expect(errors).toEqual([fixture.error])
      expect(parent.textContent).toBe('owned child')
      expect(fixture.effectRuns()).toBe(1)

      root.dispose()
      expect(parent.childNodes).toHaveLength(0)
      expect(fixture.destroyRuns()).toBe(1)
      fixture.dependency(1)
      await tick()
      expect(fixture.effectRuns()).toBe(1)
    })

    it('keeps insertBetween ownership when child onMount is handled', async () => {
      const parent = document.createElement('div')
      const start = document.createComment('start')
      const end = document.createComment('end')
      parent.append(start, end)
      const fixture = createMountFailureFixture()
      const errors: unknown[] = []
      const root = createRoot(() => {
        registerErrorHandler(error => {
          errors.push(error)
          return true
        })
        insertBetween(
          start,
          end,
          () => ({ type: fixture.Child, props: {}, key: undefined }),
          createElement,
        )
      })

      expect(errors).toEqual([fixture.error])
      expect(parent.textContent).toBe('owned child')

      root.dispose()
      expect(Array.from(parent.childNodes)).toEqual([start, end])
      expect(fixture.destroyRuns()).toBe(1)
      fixture.dependency(1)
      await tick()
      expect(fixture.effectRuns()).toBe(1)
    })

    it('keeps createChildBinding ownership when child onMount is handled', async () => {
      const parent = document.createElement('div')
      const fixture = createMountFailureFixture()
      const errors: unknown[] = []
      const root = createRoot(() => {
        registerErrorHandler(error => {
          errors.push(error)
          return true
        })
        createChildBinding(
          parent,
          () => ({ type: fixture.Child, props: {}, key: undefined }),
          createElement,
        )
      })

      expect(errors).toEqual([fixture.error])
      expect(parent.textContent).toBe('owned child')

      root.dispose()
      expect(parent.childNodes).toHaveLength(0)
      expect(fixture.destroyRuns()).toBe(1)
      fixture.dependency(1)
      await tick()
      expect(fixture.effectRuns()).toBe(1)
    })

    it('keeps spread children ownership when child onMount is handled', async () => {
      const parent = document.createElement('div')
      const fixture = createMountFailureFixture()
      const errors: unknown[] = []
      const root = createRoot(() => {
        registerErrorHandler(error => {
          errors.push(error)
          return true
        })
        spread(parent, {
          children: reactive(() => ({ type: fixture.Child, props: {}, key: undefined })),
        })
      })

      expect(errors).toEqual([fixture.error])
      expect(parent.textContent).toBe('owned child')

      root.dispose()
      expect(parent.childNodes).toHaveLength(0)
      expect(fixture.destroyRuns()).toBe(1)
      fixture.dependency(1)
      await tick()
      expect(fixture.effectRuns()).toBe(1)
    })

    it('keeps portal ownership when child onMount is handled', async () => {
      const target = document.createElement('div')
      const fixture = createMountFailureFixture()
      const errors: unknown[] = []
      const root = createRoot(() => {
        registerErrorHandler(error => {
          errors.push(error)
          return true
        })
        createPortal(
          target,
          () => ({ type: fixture.Child, props: {}, key: undefined }),
          createElement,
        )
      })

      expect(errors).toEqual([fixture.error])
      expect(target.textContent).toBe('owned child')

      root.dispose()
      expect(target.childNodes).toHaveLength(0)
      expect(fixture.destroyRuns()).toBe(1)
      fixture.dependency(1)
      await tick()
      expect(fixture.effectRuns()).toBe(1)
    })

    it('rolls back inserted DOM and markers when initial onMount is unhandled', async () => {
      const parent = document.createElement('div')
      const fixture = createMountFailureFixture()

      expect(() =>
        insert(parent, () => ({ type: fixture.Child, props: {}, key: undefined }), createElement),
      ).toThrow(fixture.error)

      expect(parent.childNodes).toHaveLength(0)
      expect(fixture.destroyRuns()).toBe(1)
      fixture.dependency(1)
      await tick()
      expect(fixture.effectRuns()).toBe(1)
    })

    it('keeps the previous inserted subtree when the next getter fails', async () => {
      const parent = document.createElement('div')
      const fail = createSignal(false)
      const error = new Error('next getter failed')
      const errors: unknown[] = []
      const root = createRoot(() => {
        registerErrorHandler(caught => {
          errors.push(caught)
          return true
        })
        insert(
          parent,
          () => {
            if (fail()) throw error
            return { type: 'span', props: { children: 'stable child' }, key: undefined }
          },
          createElement,
        )
      })

      const stable = parent.querySelector('span')
      fail(true)
      await tick()

      expect(errors).toEqual([error])
      expect(parent.querySelector('span')).toBe(stable)
      expect(parent.textContent).toBe('stable child')
      root.dispose()
    })

    it('commits the next inserted subtree when old cleanup errors are handled', async () => {
      const parent = document.createElement('div')
      const version = createSignal(0)
      const cleanupError = new Error('old child cleanup failed')
      const errors: unknown[] = []

      const OldChild = () => {
        onDestroy(() => {
          throw cleanupError
        })
        return 'old child'
      }

      const root = createRoot(() => {
        registerErrorHandler(caught => {
          errors.push(caught)
          return true
        })
        insert(
          parent,
          () =>
            version() === 0
              ? { type: OldChild, props: {}, key: undefined }
              : { type: 'span', props: { children: 'new child' }, key: undefined },
          createElement,
        )
      })

      version(1)
      await tick()

      expect(errors).toEqual([cleanupError])
      expect(parent.textContent).toBe('new child')
      root.dispose()
    })

    it('removes spread children when child cleanup throws', () => {
      const parent = document.createElement('div')
      const cleanupError = new Error('spread cleanup failed')
      const Child = () => {
        onDestroy(() => {
          throw cleanupError
        })
        return 'spread child'
      }
      const root = createRoot(() => {
        spread(parent, {
          children: reactive(() => ({ type: Child, props: {}, key: undefined })),
        })
      })

      expect(() => root.dispose()).toThrow(cleanupError)
      expect(parent.childNodes).toHaveLength(0)
    })

    it('removes conditional nodes and markers when branch cleanup throws', () => {
      const cleanupError = new Error('conditional cleanup failed')
      const Child = () => {
        onDestroy(() => {
          throw cleanupError
        })
        return 'conditional child'
      }
      const handle = createConditional(
        () => true,
        () => ({ type: Child, props: {}, key: undefined }),
        createElement,
      )
      container.appendChild(handle.marker)
      handle.flush?.()

      expect(() => handle.dispose()).toThrow(cleanupError)
      expect(container.childNodes).toHaveLength(0)
    })

    it('destroys a partial conditional branch when initial render throws', async () => {
      const dependency = createSignal(0)
      const renderError = new Error('conditional render failed')
      let effectRuns = 0
      let destroyRuns = 0
      expect(() =>
        createConditional(
          () => true,
          () => {
            createEffect(() => {
              dependency()
              effectRuns++
            })
            onDestroy(() => {
              destroyRuns++
            })
            throw renderError
          },
          createElement,
        ),
      ).toThrow(renderError)
      expect(destroyRuns).toBe(1)
      dependency(1)
      await tick()
      expect(effectRuns).toBe(1)
    })

    it('owns hydrated insertBetween nodes when the initial getter error is handled', async () => {
      container.innerHTML = '<div><!--start--><span>server child</span><!--end--></div>'
      const hydratedHost = template('<div></div>')
      const shouldFail = createSignal(true)
      const error = new Error('hydrated insert getter failed')
      const errors: unknown[] = []

      const teardown = hydrateComponent(() => {
        registerErrorHandler(caught => {
          errors.push(caught)
          return true
        })
        const host = hydratedHost()
        const comments = Array.from(host.childNodes).filter(
          node => node.nodeType === Node.COMMENT_NODE,
        ) as Comment[]
        insertBetween(comments[0]!, comments[1]!, () => {
          if (shouldFail()) throw error
          return 'client child'
        })
      }, container)

      expect(errors).toEqual([error])
      expect(container.textContent).toBe('server child')

      shouldFail(false)
      await tick()
      expect(container.textContent).toBe('client child')
      expect(container.querySelector('span')).toBeNull()

      teardown()
      expect(container.textContent).toBe('')
    })

    it('owns hydrated spread children when the initial getter error is handled', async () => {
      container.innerHTML = '<div><span>server child</span></div>'
      const hydratedHost = template('<div></div>')
      const shouldFail = createSignal(true)
      const error = new Error('hydrated spread getter failed')
      const errors: unknown[] = []

      const teardown = hydrateComponent(() => {
        registerErrorHandler(caught => {
          errors.push(caught)
          return true
        })
        const host = hydratedHost() as Element
        spread(host, {
          children: reactive(() => {
            if (shouldFail()) throw error
            return 'client child'
          }),
        })
      }, container)

      expect(errors).toEqual([error])
      expect(container.textContent).toBe('server child')

      shouldFail(false)
      await tick()
      expect(container.textContent).toBe('client child')
      expect(container.querySelector('span')).toBeNull()

      teardown()
      expect(container.textContent).toBe('')
    })

    it('owns hydrated conditional nodes when the initial condition error is handled', async () => {
      container.innerHTML =
        '<div><!--fict:cond:start--><span>server child</span><!--fict:cond:end--></div>'
      const hydratedHost = template('<div></div>')
      const clientChild = template('<span>client child</span>')
      const shouldFail = createSignal(true)
      const error = new Error('hydrated condition failed')
      const errors: unknown[] = []

      const teardown = hydrateComponent(() => {
        registerErrorHandler(caught => {
          errors.push(caught)
          return true
        })
        const host = hydratedHost()
        const comments = Array.from(host.childNodes).filter(
          node => node.nodeType === Node.COMMENT_NODE,
        ) as Comment[]
        const handle = createConditional(
          () => {
            if (shouldFail()) throw error
            return true
          },
          () => clientChild(),
          createElement,
          undefined,
          comments[0]!,
          comments[1]!,
        )
        onDestroy(handle.dispose)
      }, container)

      expect(errors).toEqual([error])
      expect(container.textContent).toBe('server child')

      teardown()
      expect(container.textContent).toBe('')
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
