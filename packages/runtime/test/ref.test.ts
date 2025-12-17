import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  createSignal,
  onMount,
  createRef,
  createConditional,
  render,
  createElement,
} from '../src/index'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('Ref Support', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  describe('createRef', () => {
    it('creates an object with current: null', () => {
      const ref = createRef()
      expect(ref.current).toBe(null)
    })

    it('creates a typed ref object', () => {
      const ref = createRef<HTMLInputElement>()
      expect(ref.current).toBe(null)
    })
  })

  describe('Object ref', () => {
    it('assigns element to ref.current on mount', () => {
      const ref = createRef<HTMLDivElement>()

      render(() => {
        const div = document.createElement('div')
        div.setAttribute('data-testid', 'test-div')

        // Manually apply ref like the runtime does
        ref.current = div

        return div
      }, container)

      expect(ref.current).toBeInstanceOf(HTMLDivElement)
      expect(ref.current?.getAttribute('data-testid')).toBe('test-div')
    })

    it('works when passed to JSX-like createElement', () => {
      const ref = createRef<HTMLButtonElement>()

      const dispose = render(() => {
        return createElement({
          type: 'button',
          props: { ref, children: 'Click me' },
          key: undefined,
        })
      }, container)

      expect(ref.current).toBeInstanceOf(HTMLButtonElement)
      expect(ref.current?.textContent).toBe('Click me')

      dispose()
    })

    it('sets ref.current to null on unmount', () => {
      const ref = createRef<HTMLDivElement>()

      const dispose = render(() => {
        return createElement({
          type: 'div',
          props: { ref, children: 'Test' },
          key: undefined,
        })
      }, container)

      expect(ref.current).not.toBe(null)

      dispose()

      expect(ref.current).toBe(null)
    })
  })

  describe('Callback ref', () => {
    it('calls callback with element on mount', () => {
      let capturedEl: HTMLElement | null = null

      render(() => {
        return createElement({
          type: 'div',
          props: {
            ref: (el: HTMLElement | null) => {
              capturedEl = el
            },
            children: 'Test',
          },
          key: undefined,
        })
      }, container)

      expect(capturedEl).toBeInstanceOf(HTMLDivElement)
    })

    it('calls callback with null on unmount', () => {
      const calls: (HTMLElement | null)[] = []

      const dispose = render(() => {
        return createElement({
          type: 'div',
          props: {
            ref: (el: HTMLElement | null) => {
              calls.push(el)
            },
            children: 'Test',
          },
          key: undefined,
        })
      }, container)

      // Should be called once with the element on mount
      expect(calls).toHaveLength(1)
      expect(calls[0]).toBeInstanceOf(HTMLDivElement)

      // Unmount
      dispose()

      // Should be called again with null on unmount
      expect(calls).toHaveLength(2)
      expect(calls[1]).toBe(null)
    })

    it('still works alongside object refs', () => {
      const objectRef = createRef<HTMLSpanElement>()
      let callbackEl: HTMLElement | null = null

      render(() => {
        const div = document.createElement('div')

        const span1 = createElement({
          type: 'span',
          props: { ref: objectRef, children: 'Object' },
          key: undefined,
        })

        const span2 = createElement({
          type: 'span',
          props: {
            ref: (el: HTMLElement) => {
              callbackEl = el
            },
            children: 'Callback',
          },
          key: undefined,
        })

        div.appendChild(span1 as Node)
        div.appendChild(span2 as Node)
        return div
      }, container)

      expect(objectRef.current).toBeInstanceOf(HTMLSpanElement)
      expect(callbackEl).toBeInstanceOf(HTMLSpanElement)
    })
  })

  describe('Ref with conditional rendering', () => {
    it('updates ref.current when condition changes', async () => {
      const ref = createRef<HTMLDivElement>()
      const show = createSignal(true)

      const { marker, flush, dispose } = createConditional(
        () => show(),
        () =>
          createElement({
            type: 'div',
            props: { ref, children: 'shown' },
            key: undefined,
          }),
        createElement,
        () =>
          createElement({
            type: 'span',
            props: { children: 'hidden' },
            key: undefined,
          }),
      )

      // marker is an array [startMarker, endMarker]
      const markers = Array.isArray(marker) ? marker : [marker]
      for (const m of markers) {
        container.appendChild(m)
      }
      // Flush pending content now that markers are in DOM
      flush?.()

      await tick()

      expect(ref.current).toBeInstanceOf(HTMLDivElement)
      expect(ref.current?.textContent).toBe('shown')

      // Hide the element
      show(false)
      await tick()

      // After hiding, the ref cleanup should have run
      expect(ref.current).toBe(null)

      dispose()
    })
  })

  describe('Ref with onMount access', () => {
    it('allows access to ref.current in onMount', () => {
      const ref = createRef<HTMLInputElement>()
      let mountValue: string | null = null

      render(() => {
        onMount(() => {
          if (ref.current) {
            mountValue = ref.current.tagName
          }
        })

        return createElement({
          type: 'input',
          props: { ref, type: 'text' },
          key: undefined,
        })
      }, container)

      expect(mountValue).toBe('INPUT')
    })
  })
})
