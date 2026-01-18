import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { render, createElement, Fragment, createRoot, onDestroy, onMount } from '../src/index'
import { createSignal } from '../src/advanced'
import { template } from '../src/internal'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('DOM Module', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  describe('render', () => {
    it('renders a view into container', () => {
      const teardown = render(() => {
        const div = document.createElement('div')
        div.textContent = 'Hello'
        return div
      }, container)

      expect(container.textContent).toBe('Hello')
      teardown()
    })

    it('replaces container children on render', () => {
      container.innerHTML = '<p>Old content</p>'

      const teardown = render(() => {
        const div = document.createElement('div')
        div.textContent = 'New'
        return div
      }, container)

      expect(container.textContent).toBe('New')
      expect(container.querySelector('p')).toBeNull()
      teardown()
    })

    it('sets data-fict-fine-grained attribute', () => {
      const teardown = render(() => document.createElement('div'), container)

      expect(container.getAttribute('data-fict-fine-grained')).toBe('1')
      teardown()
    })

    it('clears container on teardown', () => {
      const teardown = render(() => {
        const div = document.createElement('div')
        div.textContent = 'Content'
        return div
      }, container)

      expect(container.textContent).toBe('Content')
      teardown()
      expect(container.innerHTML).toBe('')
    })

    it('calls onMount callbacks', () => {
      let mounted = false

      const teardown = render(() => {
        onMount(() => {
          mounted = true
        })
        return document.createElement('div')
      }, container)

      expect(mounted).toBe(true)
      teardown()
    })

    it('calls onDestroy callbacks on teardown', () => {
      let destroyed = false

      const teardown = render(() => {
        onDestroy(() => {
          destroyed = true
        })
        return document.createElement('div')
      }, container)

      expect(destroyed).toBe(false)
      teardown()
      expect(destroyed).toBe(true)
    })
  })

  describe('createElement', () => {
    describe('Node passthrough', () => {
      it('passes through existing DOM nodes', () => {
        const existingDiv = document.createElement('div')
        existingDiv.textContent = 'Existing'

        const result = createElement(existingDiv)

        expect(result).toBe(existingDiv)
      })

      it('passes through Text nodes', () => {
        const textNode = document.createTextNode('Text')

        const result = createElement(textNode)

        expect(result).toBe(textNode)
      })

      it('passes through Comment nodes', () => {
        const comment = document.createComment('Comment')

        const result = createElement(comment)

        expect(result).toBe(comment)
      })
    })

    describe('Null/Undefined/False handling', () => {
      it('returns empty text node for null', () => {
        const result = createElement(null)

        expect(result).toBeInstanceOf(Text)
        expect((result as Text).data).toBe('')
      })

      it('returns empty text node for undefined', () => {
        const result = createElement(undefined)

        expect(result).toBeInstanceOf(Text)
        expect((result as Text).data).toBe('')
      })

      it('returns empty text node for false', () => {
        const result = createElement(false)

        expect(result).toBeInstanceOf(Text)
        expect((result as Text).data).toBe('')
      })
    })

    describe('Primitives', () => {
      it('creates text node for strings', () => {
        const result = createElement('Hello World')

        expect(result).toBeInstanceOf(Text)
        expect((result as Text).data).toBe('Hello World')
      })

      it('creates text node for numbers', () => {
        const result = createElement(42)

        expect(result).toBeInstanceOf(Text)
        expect((result as Text).data).toBe('42')
      })

      it('creates text node for zero', () => {
        const result = createElement(0)

        expect(result).toBeInstanceOf(Text)
        expect((result as Text).data).toBe('0')
      })

      it('creates empty text node for true', () => {
        const result = createElement(true)

        expect(result).toBeInstanceOf(Text)
        expect((result as Text).data).toBe('')
      })
    })

    describe('Arrays', () => {
      it('creates DocumentFragment for arrays', () => {
        const result = createElement(['a', 'b', 'c'])

        expect(result).toBeInstanceOf(DocumentFragment)
        expect(result.childNodes.length).toBe(3)
      })

      it('handles nested arrays', () => {
        const result = createElement(['a', ['b', 'c'], 'd'] as any)

        expect(result).toBeInstanceOf(DocumentFragment)
        expect(result.textContent).toBe('abcd')
      })

      it('handles empty arrays', () => {
        const result = createElement([])

        expect(result).toBeInstanceOf(DocumentFragment)
        expect(result.childNodes.length).toBe(0)
      })
    })

    describe('VNodes', () => {
      it('creates HTML element from VNode', () => {
        const result = createElement({
          type: 'div',
          props: { class: 'test' },
          key: undefined,
        })

        expect(result).toBeInstanceOf(HTMLDivElement)
        expect((result as HTMLDivElement).className).toBe('test')
      })

      it('creates nested elements', () => {
        const result = createElement({
          type: 'div',
          props: {
            children: {
              type: 'span',
              props: { children: 'Inner' },
              key: undefined,
            },
          },
          key: undefined,
        })

        expect(result).toBeInstanceOf(HTMLDivElement)
        expect((result as HTMLDivElement).querySelector('span')!.textContent).toBe('Inner')
      })

      it('handles multiple children', () => {
        const result = createElement({
          type: 'div',
          props: {
            children: [
              { type: 'span', props: { children: 'A' }, key: undefined },
              { type: 'span', props: { children: 'B' }, key: undefined },
            ],
          },
          key: undefined,
        })

        const spans = (result as HTMLDivElement).querySelectorAll('span')
        expect(spans.length).toBe(2)
        expect(spans[0]!.textContent).toBe('A')
        expect(spans[1]!.textContent).toBe('B')
      })
    })

    describe('Fragment', () => {
      it('creates DocumentFragment for Fragment type', () => {
        const result = createElement({
          type: Fragment,
          props: { children: ['a', 'b'] },
          key: undefined,
        })

        expect(result).toBeInstanceOf(DocumentFragment)
        expect(result.textContent).toBe('ab')
      })

      it('handles nested Fragments', () => {
        const result = createElement({
          type: Fragment,
          props: {
            children: [
              { type: Fragment, props: { children: ['a', 'b'] }, key: undefined },
              { type: Fragment, props: { children: ['c', 'd'] }, key: undefined },
            ],
          },
          key: undefined,
        })

        expect(result.textContent).toBe('abcd')
      })

      it('handles empty Fragment', () => {
        const result = createElement({
          type: Fragment,
          props: {},
          key: undefined,
        })

        expect(result).toBeInstanceOf(DocumentFragment)
        expect(result.childNodes.length).toBe(0)
      })
    })

    describe('Function Components', () => {
      it('renders function components', () => {
        const MyComponent = (props: { text: string }) => {
          const div = document.createElement('div')
          div.textContent = props.text
          return div
        }

        const result = createElement({
          type: MyComponent,
          props: { text: 'Hello Component' },
          key: undefined,
        })

        expect(result).toBeInstanceOf(HTMLDivElement)
        expect((result as HTMLDivElement).textContent).toBe('Hello Component')
      })

      it('renders nested function components', () => {
        const Inner = () => {
          const span = document.createElement('span')
          span.textContent = 'Inner'
          return span
        }

        const Outer = () => ({
          type: 'div',
          props: {
            children: { type: Inner, props: {}, key: undefined },
          },
          key: undefined,
        })

        const result = createElement({
          type: Outer,
          props: {},
          key: undefined,
        })

        expect((result as HTMLDivElement).querySelector('span')!.textContent).toBe('Inner')
      })

      it('passes key to component props', () => {
        let receivedKey: unknown

        const KeyAwareComponent = (props: { key?: unknown }) => {
          receivedKey = props.key
          return document.createElement('div')
        }

        createElement({
          type: KeyAwareComponent,
          props: {},
          key: 'my-key',
        })

        expect(receivedKey).toBe('my-key')
      })
    })

    describe('SVG Elements', () => {
      it('creates SVG elements in SVG namespace', () => {
        const result = createElement({
          type: 'svg',
          props: {
            children: {
              type: 'circle',
              props: { cx: 50, cy: 50, r: 40 },
              key: undefined,
            },
          },
          key: undefined,
        })

        expect(result).toBeInstanceOf(SVGSVGElement)
        expect((result as SVGSVGElement).namespaceURI).toBe('http://www.w3.org/2000/svg')
      })

      it('creates nested SVG elements in correct namespace', () => {
        const result = createElement({
          type: 'svg',
          props: {
            children: {
              type: 'g',
              props: {
                children: {
                  type: 'rect',
                  props: { width: 100, height: 100 },
                  key: undefined,
                },
              },
              key: undefined,
            },
          },
          key: undefined,
        })

        const rect = (result as SVGSVGElement).querySelector('rect')
        expect(rect!.namespaceURI).toBe('http://www.w3.org/2000/svg')
      })
    })

    describe('Binding Handle', () => {
      it('handles BindingHandle with marker', () => {
        const marker = document.createComment('test-marker')
        let disposed = false

        const handle = {
          marker,
          dispose: () => {
            disposed = true
          },
        }

        const { dispose: rootDispose } = createRoot(() => {
          const result = createElement(handle as any)
          return result
        })

        rootDispose()
        expect(disposed).toBe(true)
      })

      it('calls flush on BindingHandle if available', async () => {
        const marker = document.createComment('test-marker')
        let flushed = false

        const handle = {
          marker,
          dispose: () => {},
          flush: () => {
            flushed = true
          },
        }

        createElement(handle as any)

        await tick()
        expect(flushed).toBe(true)
      })
    })

    describe('Reactive children', () => {
      it('creates child binding for reactive children', async () => {
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
    })

    describe('Attribute handling', () => {
      it('applies class attribute', () => {
        const result = createElement({
          type: 'div',
          props: { class: 'foo bar' },
          key: undefined,
        })

        expect((result as HTMLDivElement).className).toBe('foo bar')
      })

      it('applies className attribute', () => {
        const result = createElement({
          type: 'div',
          props: { className: 'foo bar' },
          key: undefined,
        })

        expect((result as HTMLDivElement).className).toBe('foo bar')
      })

      it('applies style as string', () => {
        const result = createElement({
          type: 'div',
          props: { style: 'color: red' },
          key: undefined,
        })

        expect((result as HTMLDivElement).style.color).toBe('red')
      })

      it('applies style as object', () => {
        const result = createElement({
          type: 'div',
          props: { style: { color: 'red', fontSize: 14 } },
          key: undefined,
        })

        expect((result as HTMLDivElement).style.color).toBe('red')
        expect((result as HTMLDivElement).style.fontSize).toBe('14px')
      })

      it('applies classList as object', () => {
        const result = createElement({
          type: 'div',
          props: { classList: { active: true, disabled: false } },
          key: undefined,
        })

        expect((result as HTMLDivElement).classList.contains('active')).toBe(true)
        expect((result as HTMLDivElement).classList.contains('disabled')).toBe(false)
      })

      it('applies data attributes', () => {
        const result = createElement({
          type: 'div',
          props: { 'data-id': '123', 'data-type': 'test' },
          key: undefined,
        })

        expect((result as HTMLDivElement).getAttribute('data-id')).toBe('123')
        expect((result as HTMLDivElement).getAttribute('data-type')).toBe('test')
      })

      it('applies aria attributes', () => {
        const result = createElement({
          type: 'button',
          props: { 'aria-label': 'Close', 'aria-hidden': true },
          key: undefined,
        })

        expect((result as HTMLButtonElement).getAttribute('aria-label')).toBe('Close')
        expect((result as HTMLButtonElement).getAttribute('aria-hidden')).toBe('')
      })
    })

    describe('Property handling', () => {
      it('sets value property on input', () => {
        const result = createElement({
          type: 'input',
          props: { value: 'test value' },
          key: undefined,
        })

        expect((result as HTMLInputElement).value).toBe('test value')
      })

      it('sets checked property on checkbox', () => {
        const result = createElement({
          type: 'input',
          props: { type: 'checkbox', checked: true },
          key: undefined,
        })

        expect((result as HTMLInputElement).checked).toBe(true)
      })

      it('sets disabled property', () => {
        const result = createElement({
          type: 'button',
          props: { disabled: true },
          key: undefined,
        })

        expect((result as HTMLButtonElement).disabled).toBe(true)
      })

      it('applies htmlFor as for attribute', () => {
        const result = createElement({
          type: 'label',
          props: { htmlFor: 'my-input' },
          key: undefined,
        })

        expect((result as HTMLLabelElement).getAttribute('for')).toBe('my-input')
      })
    })

    describe('Event handling', () => {
      it('attaches onClick handler via delegation', () => {
        const handler = vi.fn()

        const result = createElement({
          type: 'button',
          props: { onClick: handler },
          key: undefined,
        })

        // Delegation requires element to be in DOM
        container.appendChild(result as Node)
        ;(result as HTMLButtonElement).dispatchEvent(new Event('click', { bubbles: true }))

        expect(handler).toHaveBeenCalled()
      })

      it('attaches onFocus handler (non-delegated event)', () => {
        const handler = vi.fn()

        const { value: result, dispose } = createRoot(() =>
          createElement({
            type: 'input',
            props: { onFocus: handler },
            key: undefined,
          }),
        )

        // Focus is not a delegated event, so it uses native addEventListener
        ;(result as HTMLInputElement).dispatchEvent(new Event('focus'))

        expect(handler).toHaveBeenCalled()
        dispose()
      })

      it('attaches oncapture:event handler', () => {
        const handler = vi.fn()

        const { value: result } = createRoot(() =>
          createElement({
            type: 'div',
            props: { 'oncapture:click': handler },
            key: undefined,
          }),
        )

        ;(result as HTMLDivElement).dispatchEvent(new Event('click'))

        expect(handler).toHaveBeenCalled()
      })
    })

    describe('Ref handling', () => {
      it('calls callback ref with element', () => {
        let refElement: Element | null = null

        const { dispose } = createRoot(() => {
          return createElement({
            type: 'div',
            props: { ref: (el: Element) => (refElement = el) },
            key: undefined,
          })
        })

        expect(refElement).toBeInstanceOf(HTMLDivElement)
        dispose()
      })

      it('sets ref object current property', () => {
        const ref = { current: null as Element | null }

        const { dispose } = createRoot(() => {
          return createElement({
            type: 'div',
            props: { ref },
            key: undefined,
          })
        })

        expect(ref.current).toBeInstanceOf(HTMLDivElement)
        dispose()
      })

      it('nullifies ref on dispose', () => {
        const ref = { current: null as Element | null }

        const { dispose } = createRoot(() => {
          return createElement({
            type: 'div',
            props: { ref },
            key: undefined,
          })
        })

        expect(ref.current).not.toBeNull()
        dispose()
        expect(ref.current).toBeNull()
      })
    })

    describe('dangerouslySetInnerHTML', () => {
      it('sets innerHTML from dangerouslySetInnerHTML', () => {
        const result = createElement({
          type: 'div',
          props: { dangerouslySetInnerHTML: { __html: '<strong>Bold</strong>' } },
          key: undefined,
        })

        expect((result as HTMLDivElement).innerHTML).toBe('<strong>Bold</strong>')
      })
    })

    describe('Prefix prop handling', () => {
      it('handles attr: prefix for forced attributes', () => {
        const result = createElement({
          type: 'div',
          props: { 'attr:data-custom': 'value' },
          key: undefined,
        })

        expect((result as HTMLDivElement).getAttribute('data-custom')).toBe('value')
      })

      it('handles bool: prefix for boolean attributes', () => {
        const result = createElement({
          type: 'button',
          props: { 'bool:disabled': true },
          key: undefined,
        })

        expect((result as HTMLButtonElement).hasAttribute('disabled')).toBe(true)
      })

      it('handles prop: prefix for forced properties', () => {
        const result = createElement({
          type: 'input',
          props: { 'prop:value': 'test' },
          key: undefined,
        })

        expect((result as HTMLInputElement).value).toBe('test')
      })
    })
  })

  describe('template', () => {
    it('creates a cloning factory from HTML string', () => {
      const factory = template('<div class="test">Content</div>')

      const node1 = factory()
      const node2 = factory()

      expect(node1).toBeInstanceOf(HTMLDivElement)
      expect((node1 as HTMLDivElement).className).toBe('test')
      expect((node1 as HTMLDivElement).textContent).toBe('Content')

      expect(node2).not.toBe(node1)
      expect((node2 as HTMLDivElement).className).toBe('test')
    })

    it('caches the template element', () => {
      const factory = template('<span>Cached</span>')

      const node1 = factory()
      const node2 = factory()
      const node3 = factory()

      expect(node1).not.toBe(node2)
      expect(node2).not.toBe(node3)
      expect((node1 as HTMLSpanElement).textContent).toBe('Cached')
    })

    it('uses importNode when isImportNode is true', () => {
      const factory = template('<img src="test.png" />', true)

      const node = factory()

      expect(node).toBeInstanceOf(HTMLImageElement)
    })

    it('handles SVG templates', () => {
      const factory = template('<svg><circle cx="50" cy="50" r="40"/></svg>', false, true)

      const node = factory()

      // SVG template returns the nested content (circle element)
      expect(node.nodeName.toLowerCase()).toBe('circle')
    })

    it('handles MathML templates', () => {
      const factory = template('<mi>x</mi>', false, false, true)

      const node = factory()

      expect(node.nodeName.toLowerCase()).toBe('mi')
    })

    it('provides cloneNode property for compatibility', () => {
      const factory = template('<div>Test</div>') as { cloneNode?: () => Node }

      expect(factory.cloneNode).toBe(factory)
    })

    it('clones nested structures correctly', () => {
      const factory = template('<div><span>A</span><span>B</span></div>')

      const node = factory() as HTMLDivElement

      expect(node.children.length).toBe(2)
      expect((node.children[0] as HTMLSpanElement).textContent).toBe('A')
      expect((node.children[1] as HTMLSpanElement).textContent).toBe('B')
    })
  })

  describe('Custom Elements', () => {
    it('handles custom element property conversion', () => {
      const result = createElement({
        type: 'my-component',
        props: { 'my-prop': 'value' },
        key: undefined,
      })

      // Custom elements have properties set via kebab-to-camel conversion
      expect(result).toBeInstanceOf(HTMLElement)
    })

    it('handles custom elements with is attribute', () => {
      const result = createElement({
        type: 'button',
        props: { is: 'my-button' },
        key: undefined,
      })

      expect(result).toBeInstanceOf(HTMLButtonElement)
    })
  })

  describe('MathML Elements', () => {
    it('creates MathML elements in math namespace', () => {
      const result = createElement({
        type: 'math',
        props: {
          children: {
            type: 'mi',
            props: { children: 'x' },
            key: undefined,
          },
        },
        key: undefined,
      })

      expect(result.namespaceURI).toBe('http://www.w3.org/1998/Math/MathML')
    })
  })

  describe('foreignObject handling', () => {
    it('resets namespace for foreignObject children', () => {
      const result = createElement({
        type: 'svg',
        props: {
          children: {
            type: 'foreignObject',
            props: {
              children: {
                type: 'div',
                props: { children: 'HTML inside SVG' },
                key: undefined,
              },
            },
            key: undefined,
          },
        },
        key: undefined,
      })

      const div = (result as SVGSVGElement).querySelector('div')
      expect(div).not.toBeNull()
      // div should be in HTML namespace, not SVG
      expect(div!.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    })
  })
})
