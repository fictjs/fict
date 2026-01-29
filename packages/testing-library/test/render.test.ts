/**
 * Tests for the render function
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor, fireEvent, flush } from '../src/index'
import { createElement, Fragment, onMount, onDestroy, createRoot } from '@fictjs/runtime'
import { createSignal } from '@fictjs/runtime/advanced'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('render', () => {
  beforeEach(() => {
    // Clean up any previous renders
    cleanup()
  })

  describe('basic rendering', () => {
    it('renders a simple element', () => {
      const { container } = render(() => {
        const div = document.createElement('div')
        div.textContent = 'Hello World'
        return div
      })

      expect(container.textContent).toBe('Hello World')
    })

    it('renders a VNode', () => {
      const { container } = render(() =>
        createElement({
          type: 'div',
          props: { children: 'Hello VNode' },
          key: undefined,
        }),
      )

      expect(container.textContent).toBe('Hello VNode')
    })

    it('renders a function component', () => {
      const Greeting = (props: Record<string, unknown>) =>
        createElement({
          type: 'span',
          props: { children: `Hello, ${props.name}!` },
          key: undefined,
        })

      const { container } = render(() =>
        createElement({
          type: Greeting,
          props: { name: 'World' },
          key: undefined,
        }),
      )

      expect(container.textContent).toBe('Hello, World!')
    })

    it('provides query utilities', () => {
      const { getByText } = render(() =>
        createElement({
          type: 'button',
          props: { children: 'Click me' },
          key: undefined,
        }),
      )

      const button = getByText('Click me')
      expect(button).toBeTruthy()
      expect(button.tagName).toBe('BUTTON')
    })

    it('scopes queries to the container', () => {
      // Add element outside the render
      const outside = document.createElement('div')
      outside.textContent = 'Outside'
      document.body.appendChild(outside)

      const { queryByText } = render(() =>
        createElement({
          type: 'div',
          props: { children: 'Inside' },
          key: undefined,
        }),
      )

      expect(queryByText('Inside')).toBeTruthy()
      expect(queryByText('Outside')).toBeNull()

      // Clean up
      outside.remove()
    })
  })

  describe('container management', () => {
    it('creates a container if not provided', () => {
      const { container } = render(() => document.createElement('div'))

      expect(container).toBeInstanceOf(HTMLDivElement)
      expect(container.parentNode).toBe(document.body)
    })

    it('uses provided container', () => {
      const customContainer = document.createElement('section')
      document.body.appendChild(customContainer)

      const { container } = render(() => document.createElement('div'), {
        container: customContainer,
      })

      expect(container).toBe(customContainer)

      // Clean up
      customContainer.remove()
    })

    it('defaults baseElement to provided container', () => {
      const customContainer = document.createElement('section')
      document.body.appendChild(customContainer)

      const { baseElement } = render(() => document.createElement('div'), {
        container: customContainer,
      })

      expect(baseElement).toBe(customContainer)

      customContainer.remove()
    })

    it('uses baseElement for creating container', () => {
      const baseElement = document.createElement('main')
      document.body.appendChild(baseElement)

      const { container, baseElement: resultBaseElement } = render(
        () => document.createElement('div'),
        {
          baseElement,
        },
      )

      expect(container.parentNode).toBe(baseElement)
      expect(resultBaseElement).toBe(baseElement)

      // Clean up
      baseElement.remove()
    })
  })

  describe('unmount', () => {
    it('unmounts the component', () => {
      const { container, unmount } = render(() => {
        const div = document.createElement('div')
        div.textContent = 'Content'
        return div
      })

      expect(container.textContent).toBe('Content')

      unmount()

      expect(container.innerHTML).toBe('')
    })

    it('calls onDestroy callbacks on unmount', () => {
      let destroyed = false

      const { unmount } = render(() => {
        onDestroy(() => {
          destroyed = true
        })
        return document.createElement('div')
      })

      expect(destroyed).toBe(false)
      unmount()
      expect(destroyed).toBe(true)
    })

    it('removes container from baseElement on unmount', () => {
      const { container, unmount } = render(() => document.createElement('div'))

      expect(document.body.contains(container)).toBe(true)
      unmount()
      expect(document.body.contains(container)).toBe(false)
    })

    it('does not remove user-provided container on unmount', () => {
      const customContainer = document.createElement('section')
      document.body.appendChild(customContainer)

      const { unmount } = render(() => document.createElement('div'), {
        container: customContainer,
      })

      unmount()
      expect(document.body.contains(customContainer)).toBe(true)

      customContainer.remove()
    })
  })

  describe('rerender', () => {
    it('rerenders with a new view', () => {
      const { container, rerender } = render(() =>
        createElement({
          type: 'div',
          props: { children: 'Original' },
          key: undefined,
        }),
      )

      expect(container.textContent).toBe('Original')

      rerender(() =>
        createElement({
          type: 'div',
          props: { children: 'Updated' },
          key: undefined,
        }),
      )

      expect(container.textContent).toBe('Updated')
    })

    it('cleans up previous render on rerender', () => {
      let cleanedUp = false

      const { rerender } = render(() => {
        onDestroy(() => {
          cleanedUp = true
        })
        return document.createElement('div')
      })

      expect(cleanedUp).toBe(false)

      rerender(() => document.createElement('span'))

      expect(cleanedUp).toBe(true)
    })

    it('cleanup disposes latest rerender root', () => {
      let destroyedA = false
      let destroyedB = false

      const { rerender } = render(() => {
        onDestroy(() => {
          destroyedA = true
        })
        return document.createElement('div')
      })

      rerender(() => {
        onDestroy(() => {
          destroyedB = true
        })
        return document.createElement('span')
      })

      cleanup()

      expect(destroyedA).toBe(true)
      expect(destroyedB).toBe(true)
    })
  })

  describe('asFragment', () => {
    it('returns container innerHTML', () => {
      const { asFragment } = render(() =>
        createElement({
          type: 'div',
          props: { class: 'test', children: 'Content' },
          key: undefined,
        }),
      )

      expect(asFragment()).toBe('<div class="test">Content</div>')
    })
  })

  describe('debug', () => {
    it('logs the DOM to console', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      const { debug, container } = render(() =>
        createElement({
          type: 'div',
          props: { 'data-testid': 'my-element' },
          key: undefined,
        }),
      )

      // Debug the container instead of baseElement to get more predictable output
      debug(container)

      expect(logSpy).toHaveBeenCalled()
      const loggedContent = logSpy.mock.calls[0]?.[0] as string
      // The output may contain ANSI codes, so check for the attribute in a flexible way
      expect(loggedContent).toMatch(/data-testid/)

      logSpy.mockRestore()
    })
  })

  describe('wrapper', () => {
    it('wraps the component with a wrapper', () => {
      const ThemeProvider = (props: { children: any }) =>
        createElement({
          type: 'div',
          props: { class: 'theme-wrapper', children: props.children },
          key: undefined,
        })

      const { container } = render(
        () =>
          createElement({
            type: 'span',
            props: { children: 'Content' },
            key: undefined,
          }),
        {
          wrapper: ThemeProvider,
        },
      )

      expect(container.querySelector('.theme-wrapper')).toBeTruthy()
      expect(container.textContent).toBe('Content')
    })

    it('preserves wrapper on rerender', () => {
      const WrapperWithClass = (props: { children: any }) =>
        createElement({
          type: 'div',
          props: { class: 'persistent-wrapper', children: props.children },
          key: undefined,
        })

      const { container, rerender } = render(
        () =>
          createElement({
            type: 'span',
            props: { children: 'Original' },
            key: undefined,
          }),
        {
          wrapper: WrapperWithClass,
        },
      )

      expect(container.querySelector('.persistent-wrapper')).toBeTruthy()
      expect(container.textContent).toBe('Original')

      rerender(() =>
        createElement({
          type: 'span',
          props: { children: 'Updated' },
          key: undefined,
        }),
      )

      expect(container.querySelector('.persistent-wrapper')).toBeTruthy()
      expect(container.textContent).toBe('Updated')
    })
  })

  describe('lifecycle hooks', () => {
    it('calls onMount after render', () => {
      let mounted = false

      render(() => {
        onMount(() => {
          mounted = true
        })
        return document.createElement('div')
      })

      expect(mounted).toBe(true)
    })

    it('runs onMount cleanup on unmount', () => {
      let cleanedUp = false

      const { unmount } = render(() => {
        onMount(() => {
          return () => {
            cleanedUp = true
          }
        })
        return document.createElement('div')
      })

      expect(cleanedUp).toBe(false)
      unmount()
      expect(cleanedUp).toBe(true)
    })
  })
})

describe('cleanup', () => {
  it('cleans up all rendered components', () => {
    const containers: HTMLElement[] = []

    for (let i = 0; i < 3; i++) {
      const { container } = render(() => {
        const div = document.createElement('div')
        div.textContent = `Render ${i}`
        return div
      })
      containers.push(container)
    }

    // All containers should be in the document
    containers.forEach(c => {
      expect(document.body.contains(c)).toBe(true)
    })

    cleanup()

    // All containers should be removed
    containers.forEach(c => {
      expect(document.body.contains(c)).toBe(false)
    })
  })

  it('calls teardown for all renders', () => {
    const destroyCallbacks: number[] = []

    for (let i = 0; i < 3; i++) {
      const index = i
      render(() => {
        onDestroy(() => {
          destroyCallbacks.push(index)
        })
        return document.createElement('div')
      })
    }

    expect(destroyCallbacks).toEqual([])

    cleanup()

    expect(destroyCallbacks).toHaveLength(3)
    expect(destroyCallbacks).toContain(0)
    expect(destroyCallbacks).toContain(1)
    expect(destroyCallbacks).toContain(2)
  })

  it('removes auto-created containers from custom baseElement', () => {
    const baseElement = document.createElement('main')
    document.body.appendChild(baseElement)

    const { container } = render(() => document.createElement('div'), { baseElement })

    expect(baseElement.contains(container)).toBe(true)
    cleanup()
    expect(baseElement.contains(container)).toBe(false)

    baseElement.remove()
  })

  it('does not remove user container when baseElement is provided', () => {
    const baseElement = document.createElement('main')
    const customContainer = document.createElement('section')
    baseElement.appendChild(customContainer)
    document.body.appendChild(baseElement)

    render(() => document.createElement('div'), {
      container: customContainer,
      baseElement,
    })

    cleanup()

    expect(baseElement.contains(customContainer)).toBe(true)

    baseElement.remove()
  })
})

describe('screen', () => {
  beforeEach(() => {
    cleanup()
  })

  it('provides global screen queries', () => {
    render(() =>
      createElement({
        type: 'button',
        props: { children: 'Submit' },
        key: undefined,
      }),
    )

    const button = screen.getByText('Submit')
    expect(button).toBeTruthy()
    expect(button.tagName).toBe('BUTTON')
  })

  it('works with getByRole', () => {
    render(() =>
      createElement({
        type: 'button',
        props: { children: 'Click' },
        key: undefined,
      }),
    )

    const button = screen.getByRole('button')
    expect(button).toBeTruthy()
  })

  it('works with getByTestId', () => {
    render(() =>
      createElement({
        type: 'div',
        props: { 'data-testid': 'my-element', children: 'Content' },
        key: undefined,
      }),
    )

    const element = screen.getByTestId('my-element')
    expect(element.textContent).toBe('Content')
  })
})

describe('fireEvent', () => {
  beforeEach(() => {
    cleanup()
  })

  it('fires click events', () => {
    const handleClick = vi.fn()

    const { getByRole } = render(() => {
      const button = document.createElement('button')
      button.textContent = 'Click me'
      button.addEventListener('click', handleClick)
      return button
    })

    const button = getByRole('button')
    fireEvent.click(button)

    expect(handleClick).toHaveBeenCalledTimes(1)
  })

  it('fires input events', () => {
    const handleInput = vi.fn()

    const { getByRole } = render(() => {
      const input = document.createElement('input')
      input.addEventListener('input', handleInput)
      return input
    })

    const input = getByRole('textbox')
    fireEvent.input(input, { target: { value: 'hello' } })

    expect(handleInput).toHaveBeenCalled()
  })
})

describe('flush', () => {
  it('flushes pending microtasks', async () => {
    let executed = false

    queueMicrotask(() => {
      executed = true
    })

    expect(executed).toBe(false)

    await flush()

    expect(executed).toBe(true)
  })
})
