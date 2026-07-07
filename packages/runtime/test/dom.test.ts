import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  render,
  createElement,
  Fragment,
  createRoot,
  createEffect,
  onDestroy,
  onMount,
} from '../src/index'
import { createSignal, reactive } from '../src/advanced'
import {
  clearDelegatedEvents,
  hydrateComponent,
  resolvePath,
  spread,
  template,
  toNodeArray,
} from '../src/internal'
import { registerErrorHandler } from '../src/lifecycle'
import type { HydrationIssue } from '../src/internal'

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

    it('creates nodes in the container ownerDocument during render', () => {
      const foreignDoc = document.implementation.createHTMLDocument('foreign-render-owner')
      const foreignContainer = foreignDoc.createElement('div')
      let createdNode: Node | null = null

      const teardown = render(
        () => {
          createdNode = createElement('Foreign')
          return createdNode
        },
        foreignContainer as unknown as HTMLElement,
      )

      expect((createdNode as Node | null)?.ownerDocument).toBe(foreignDoc)
      expect(foreignContainer.firstChild?.ownerDocument).toBe(foreignDoc)
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

    it('cleans up effects when the render view throws', async () => {
      const trigger = createSignal(0)
      let runs = 0
      let destroyed = 0

      expect(() => {
        render(() => {
          createEffect(() => {
            trigger()
            runs++
          })
          onDestroy(() => {
            destroyed++
          })
          throw new Error('view boom')
        }, container)
      }).toThrow('view boom')

      expect(runs).toBe(1)
      expect(destroyed).toBe(1)

      trigger(1)
      await tick()

      expect(runs).toBe(1)
    })

    it('cleans up parent and child effects when component rendering throws', async () => {
      const trigger = createSignal(0)
      let parentRuns = 0
      let childRuns = 0
      let destroyed = 0

      const BrokenChild = () => {
        createEffect(() => {
          trigger()
          childRuns++
        })
        onDestroy(() => {
          destroyed++
        })
        throw new Error('child boom')
      }

      expect(() => {
        render(() => {
          createEffect(() => {
            trigger()
            parentRuns++
          })
          onDestroy(() => {
            destroyed++
          })
          return { type: BrokenChild, props: {}, key: undefined }
        }, container)
      }).toThrow('child boom')

      expect(parentRuns).toBe(1)
      expect(childRuns).toBe(1)
      expect(destroyed).toBe(2)

      trigger(1)
      await tick()

      expect(parentRuns).toBe(1)
      expect(childRuns).toBe(1)
    })

    it('cleans up effects when container replacement throws', async () => {
      const trigger = createSignal(0)
      let runs = 0
      let destroyed = 0
      const replaceSpy = vi.spyOn(container, 'replaceChildren').mockImplementation(() => {
        throw new Error('replace boom')
      })

      try {
        expect(() => {
          render(() => {
            createEffect(() => {
              trigger()
              runs++
            })
            onDestroy(() => {
              destroyed++
            })
            return document.createElement('div')
          }, container)
        }).toThrow('replace boom')

        expect(runs).toBe(1)
        expect(destroyed).toBe(1)

        trigger(1)
        await tick()

        expect(runs).toBe(1)
      } finally {
        replaceSpy.mockRestore()
      }
    })

    it('cleans up effects when render mount flushing throws', async () => {
      const trigger = createSignal(0)
      let runs = 0
      let mountCleanups = 0
      let destroyed = 0

      expect(() => {
        render(() => {
          createEffect(() => {
            trigger()
            runs++
          })
          onDestroy(() => {
            destroyed++
          })
          onMount(() => {
            return () => {
              mountCleanups++
            }
          })
          onMount(() => {
            throw new Error('mount boom')
          })
          return document.createElement('div')
        }, container)
      }).toThrow('mount boom')

      expect(runs).toBe(1)
      expect(mountCleanups).toBe(1)
      expect(destroyed).toBe(1)

      trigger(1)
      await tick()

      expect(runs).toBe(1)
    })
  })

  describe('hydrateComponent', () => {
    it('preserves spread children text nodes during hydration', () => {
      container.innerHTML = '<div>hello</div>'
      const existingElement = container.firstChild as HTMLDivElement
      const existingText = existingElement.firstChild

      const teardown = hydrateComponent(() => {
        const factory = template('<div></div>')
        const el = factory() as HTMLDivElement
        spread(el, { children: 'hello' }, false, false)
        return el
      }, container)

      const hydratedElement = container.firstChild as HTMLDivElement

      expect(hydratedElement).toBe(existingElement)
      expect(hydratedElement.firstChild).toBe(existingText)
      expect(hydratedElement.textContent).toBe('hello')

      teardown()
    })

    it('preserves spread children arrays during hydration', () => {
      container.innerHTML = '<div>hello<span>world</span></div>'
      const existingElement = container.firstChild as HTMLDivElement
      const existingText = existingElement.firstChild
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const teardown = hydrateComponent(() => {
        const factory = template('<div></div>')
        const el = factory() as HTMLDivElement
        spread(
          el,
          {
            children: ['hello', { type: 'span', props: { children: 'world' }, key: undefined }],
          },
          false,
          false,
        )
        return el
      }, container)

      const hydratedElement = container.firstChild as HTMLDivElement

      expect(hydratedElement).toBe(existingElement)
      expect(hydratedElement.firstChild).toBe(existingText)
      expect(hydratedElement.childNodes).toHaveLength(2)
      expect((hydratedElement.lastChild as HTMLSpanElement).tagName).toBe('SPAN')
      expect((hydratedElement.lastChild as HTMLSpanElement).textContent).toBe('world')
      expect(hydratedElement.textContent).toBe('helloworld')

      teardown()
      warnSpy.mockRestore()
    })

    it('reports text mismatches during hydration', () => {
      container.innerHTML = 'server'
      const issues: HydrationIssue[] = []
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const teardown = hydrateComponent(
        () => {
          return createElement('client')
        },
        container,
        {
          onHydrationIssue: issue => issues.push(issue),
        },
      )

      expect(container.textContent).toBe('client')
      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'text_mismatch',
          expected: 'client',
          actual: 'server',
        }),
      )

      teardown()
      warnSpy.mockRestore()
    })

    it('warns about hydration mismatches in dev without an issue handler', () => {
      container.innerHTML = 'server'
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const teardown = hydrateComponent(() => createElement('client'), container)

      expect(container.textContent).toBe('client')
      expect(warnSpy).toHaveBeenCalledWith(
        '[fict/hydration] Hydrated text content does not match client output.',
      )

      teardown()
      warnSpy.mockRestore()
    })

    it('throws on hydration mismatches when strictHydration is enabled', () => {
      container.innerHTML = 'server'
      const issues: HydrationIssue[] = []
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      expect(() =>
        hydrateComponent(() => createElement('client'), container, {
          strictHydration: true,
          onHydrationIssue: issue => issues.push(issue),
        }),
      ).toThrow('[fict/hydration] Hydrated text content does not match client output.')

      expect(container.textContent).toBe('server')
      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'text_mismatch',
          expected: 'client',
          actual: 'server',
        }),
      )
      expect(warnSpy).toHaveBeenCalledWith(
        '[fict/hydration] Hydrated text content does not match client output.',
      )

      warnSpy.mockRestore()
    })

    it('cleans up effects when hydrated mount flushing throws', async () => {
      container.innerHTML = '<span>app</span>'
      const trigger = createSignal(0)
      let runs = 0
      let mountCleanups = 0
      let destroyed = 0
      const span = template('<span>app</span>')

      const App = () => {
        createEffect(() => {
          trigger()
          runs++
        })
        onDestroy(() => {
          destroyed++
        })
        onMount(() => {
          return () => {
            mountCleanups++
          }
        })
        onMount(() => {
          throw new Error('hydrate mount boom')
        })
        return span()
      }

      expect(() => {
        hydrateComponent(() => createElement({ type: App, props: {}, key: undefined }), container)
      }).toThrow('hydrate mount boom')

      expect(runs).toBe(1)
      expect(mountCleanups).toBe(1)
      expect(destroyed).toBe(1)

      trigger(1)
      await tick()

      expect(runs).toBe(1)
    })

    it('routes hydrated mount cleanup errors while destroying failed setup', async () => {
      container.innerHTML = '<span>app</span>'
      const trigger = createSignal(0)
      let runs = 0
      let cleanupErrors = 0
      let destroyed = 0
      const span = template('<span>app</span>')

      const App = () => {
        registerErrorHandler((err, info) => {
          if (err instanceof Error && err.message === 'hydrate cleanup boom') {
            cleanupErrors++
            expect(info?.source).toBe('cleanup')
            return true
          }
          return false
        })
        createEffect(() => {
          trigger()
          runs++
        })
        onDestroy(() => {
          destroyed++
        })
        onMount(() => {
          return () => {
            throw new Error('hydrate cleanup boom')
          }
        })
        onMount(() => {
          throw new Error('hydrate mount boom')
        })
        return span()
      }

      expect(() => {
        hydrateComponent(() => createElement({ type: App, props: {}, key: undefined }), container)
      }).toThrow('hydrate mount boom')

      expect(cleanupErrors).toBe(1)
      expect(destroyed).toBe(1)

      trigger(1)
      await tick()

      expect(runs).toBe(1)
    })

    it('cleans up effects when a hydration issue handler throws', async () => {
      container.innerHTML = 'server'
      const trigger = createSignal(0)
      let runs = 0

      expect(() => {
        hydrateComponent(
          () => {
            createEffect(() => {
              trigger()
              runs++
            })
            return createElement('client')
          },
          container,
          {
            onHydrationIssue: () => {
              throw new Error('issue boom')
            },
          },
        )
      }).toThrow('issue boom')

      expect(runs).toBe(1)

      trigger(1)
      await tick()

      expect(runs).toBe(1)
    })

    it('cleans up effects when strict hydration fails after setup', async () => {
      container.innerHTML = 'server'
      const trigger = createSignal(0)
      const issues: HydrationIssue[] = []
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let runs = 0

      try {
        expect(() => {
          hydrateComponent(
            () => {
              createEffect(() => {
                trigger()
                runs++
              })
              return createElement('client')
            },
            container,
            {
              strictHydration: true,
              onHydrationIssue: issue => issues.push(issue),
            },
          )
        }).toThrow('[fict/hydration] Hydrated text content does not match client output.')

        expect(runs).toBe(1)
        expect(issues).toContainEqual(
          expect.objectContaining({
            code: 'text_mismatch',
            expected: 'client',
            actual: 'server',
          }),
        )

        trigger(1)
        await tick()

        expect(runs).toBe(1)
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('reports node mismatches during hydration', () => {
      container.innerHTML = '<span>server</span>'
      const issues: HydrationIssue[] = []
      let hydratedNode: Node | null = null
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const teardown = hydrateComponent(
        () => {
          const factory = template('<div></div>')
          hydratedNode = factory()
          return hydratedNode
        },
        container,
        {
          onHydrationIssue: issue => issues.push(issue),
        },
      )

      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'node_type_mismatch',
          expected: 'div',
          actual: 'span',
        }),
      )
      expect(hydratedNode).toBe(container.firstChild)
      expect(hydratedNode?.isConnected).toBe(true)
      expect((container.firstChild as HTMLElement).tagName).toBe('DIV')
      expect(container.querySelector('span')).toBeNull()

      teardown()
      warnSpy.mockRestore()
    })

    it('reports missing nodes during hydration', () => {
      container.innerHTML = ''
      const issues: HydrationIssue[] = []
      let hydratedNode: Node | null = null
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const teardown = hydrateComponent(
        () => {
          const factory = template('<div></div>')
          hydratedNode = factory()
          return hydratedNode
        },
        container,
        {
          onHydrationIssue: issue => issues.push(issue),
        },
      )

      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'node_missing',
          expected: 'div',
        }),
      )
      expect(hydratedNode).toBe(container.firstChild)
      expect(hydratedNode?.isConnected).toBe(true)
      expect((container.firstChild as HTMLElement).tagName).toBe('DIV')

      teardown()
      warnSpy.mockRestore()
    })

    it('preserves claimed multi-root template nodes during hydration', () => {
      container.innerHTML = '<div>one</div><p>two</p>'
      const first = container.firstChild
      const second = container.lastChild
      let hydratedNode: Node | null = null
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const teardown = hydrateComponent(() => {
        const factory = template('<div>one</div><p>two</p>')
        hydratedNode = factory()
        return hydratedNode
      }, container)

      expect(container.childNodes).toHaveLength(2)
      expect(container.firstChild).toBe(first)
      expect(container.lastChild).toBe(second)
      expect(hydratedNode).toBeInstanceOf(DocumentFragment)
      expect(toNodeArray(hydratedNode)).toEqual([first, second])
      expect(resolvePath(hydratedNode as Node, [1])).toBe(second)
      expect(first?.parentNode).toBe(container)
      expect(second?.parentNode).toBe(container)

      teardown()
      warnSpy.mockRestore()
    })

    it('preserves mounted multi-root fallback nodes after hydration mismatch', () => {
      container.innerHTML = '<span>server</span>'
      const issues: HydrationIssue[] = []
      let hydratedNode: Node | null = null
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const teardown = hydrateComponent(
        () => {
          const factory = template('<div>one</div><p>two</p>')
          hydratedNode = factory()
          return hydratedNode
        },
        container,
        {
          onHydrationIssue: issue => issues.push(issue),
        },
      )

      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'node_type_mismatch',
          expected: 'div',
          actual: 'span',
        }),
      )
      expect(container.childNodes).toHaveLength(2)
      expect(container.querySelector('span')).toBeNull()

      const nodes = toNodeArray(hydratedNode)
      expect(nodes.map(node => (node as Element).tagName)).toEqual(['DIV', 'P'])
      expect(nodes.map(node => node.textContent)).toEqual(['one', 'two'])
      expect(nodes.every(node => node.isConnected)).toBe(true)
      expect(resolvePath(hydratedNode as Node, [1])).toBe(nodes[1])

      teardown()
      warnSpy.mockRestore()
    })

    it('replaces non-text hydrated nodes when hydrating text output', () => {
      container.innerHTML = '<span>server</span>'
      const issues: HydrationIssue[] = []
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const teardown = hydrateComponent(() => createElement('client'), container, {
        onHydrationIssue: issue => issues.push(issue),
      })

      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'node_type_mismatch',
          expected: '#text',
          actual: 'span',
        }),
      )
      expect(container.childNodes).toHaveLength(1)
      expect(container.firstChild?.nodeType).toBe(Node.TEXT_NODE)
      expect(container.textContent).toBe('client')

      teardown()
      warnSpy.mockRestore()
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
        const MyComponent = (props: Record<string, unknown>) => {
          const div = document.createElement('div')
          div.textContent = String(props.text)
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

      it('normalizes SVG camelCase and namespaced props', () => {
        const xlinkNS = 'http://www.w3.org/1999/xlink'
        const result = createElement({
          type: 'svg',
          props: {
            viewBox: '0 0 10 10',
            children: {
              type: 'path',
              props: {
                strokeWidth: 2,
                strokeLinecap: 'round',
                fillRule: 'evenodd',
                clipRule: 'evenodd',
                xlinkHref: '#a',
              },
              key: undefined,
            },
          },
          key: undefined,
        })

        const svg = result as SVGSVGElement
        const path = svg.querySelector('path')!
        expect(svg.getAttribute('viewBox')).toBe('0 0 10 10')
        expect(path.getAttribute('stroke-width')).toBe('2')
        expect(path.getAttribute('stroke-linecap')).toBe('round')
        expect(path.getAttribute('fill-rule')).toBe('evenodd')
        expect(path.getAttribute('clip-rule')).toBe('evenodd')
        expect(path.getAttributeNS(xlinkNS, 'href')).toBe('#a')
        expect(path.hasAttribute('strokeWidth')).toBe(false)
        expect(path.hasAttribute('xlinkHref')).toBe(false)
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

      it('registers cleanup for nested BindingHandle children', () => {
        const marker = document.createComment('nested-marker')
        let disposed = 0
        let flushed = 0

        const handle = {
          marker,
          dispose: () => {
            disposed++
          },
          flush: () => {
            flushed++
          },
        }

        const { value: result, dispose: rootDispose } = createRoot(() =>
          createElement({
            type: 'div',
            props: { children: [handle] },
            key: undefined,
          } as any),
        )

        expect((result as HTMLDivElement).firstChild).toBe(marker)
        expect(flushed).toBe(1)

        rootDispose()

        expect(disposed).toBe(1)
      })
    })

    describe('Reactive children', () => {
      it('creates child binding for reactive children', async () => {
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

      it('creates child binding when child is a signal accessor', async () => {
        const count = createSignal(0)

        const teardown = render(
          () => ({
            type: 'div',
            props: {
              children: count,
            },
            key: undefined,
          }),
          container,
        )

        expect(container.textContent).toBe('0')

        count(7)
        await tick()
        expect(container.textContent).toBe('7')

        teardown()
      })

      it('does not execute plain zero-arg function children', () => {
        let invoked = 0
        const callbackChild = () => {
          invoked++
          return 'should-not-render'
        }

        const result = createElement({
          type: 'div',
          props: {
            children: callbackChild,
          },
          key: undefined,
        })

        expect(invoked).toBe(0)
        expect((result as HTMLDivElement).textContent).toBe('')
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

      it('keeps class and classList props independent', async () => {
        const active = createSignal(true)
        const result = createElement({
          type: 'div',
          props: {
            class: 'base',
            classList: reactive(() => ({ active: active(), off: !active() })),
          },
          key: undefined,
        }) as HTMLDivElement

        expect(result.classList.contains('base')).toBe(true)
        expect(result.classList.contains('active')).toBe(true)
        expect(result.classList.contains('off')).toBe(false)

        active(false)
        await tick()

        expect(result.classList.contains('base')).toBe(true)
        expect(result.classList.contains('active')).toBe(false)
        expect(result.classList.contains('off')).toBe(true)
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
        expect((result as HTMLButtonElement).getAttribute('aria-hidden')).toBe('true')
      })

      it('stringifies boolean aria and data attributes', () => {
        const result = createElement({
          type: 'div',
          props: {
            'aria-hidden': true,
            'aria-expanded': false,
            'data-active': true,
            'data-off': false,
            draggable: true,
            contentEditable: true,
            spellCheck: false,
            hidden: true,
            disabled: false,
            'bool:data-forced': true,
          },
          key: undefined,
        }) as HTMLDivElement

        expect(result.getAttribute('aria-hidden')).toBe('true')
        expect(result.getAttribute('aria-expanded')).toBe('false')
        expect(result.getAttribute('data-active')).toBe('true')
        expect(result.getAttribute('data-off')).toBe('false')
        expect(result.getAttribute('draggable')).toBe('true')
        expect(result.draggable).toBe(true)
        expect(result.getAttribute('contenteditable')).toBe('true')
        expect(result.getAttribute('spellcheck')).toBe('false')
        expect(result.hasAttribute('hidden')).toBe(true)
        expect(result.hasAttribute('disabled')).toBe(false)
        expect(result.getAttribute('data-forced')).toBe('')
      })

      it('stringifies false draggable attributes', () => {
        const result = createElement({
          type: 'div',
          props: { draggable: false },
          key: undefined,
        }) as HTMLDivElement

        expect(result.getAttribute('draggable')).toBe('false')
        expect(result.draggable).toBe(false)
      })

      it('stringifies false editing enumerated attributes', () => {
        const result = createElement({
          type: 'div',
          props: { contentEditable: false, spellCheck: false },
          key: undefined,
        }) as HTMLDivElement

        expect(result.getAttribute('contenteditable')).toBe('false')
        expect(result.getAttribute('spellcheck')).toBe('false')
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

      it('sets form default properties', () => {
        const input = createElement({
          type: 'input',
          props: { defaultValue: 'initial', defaultChecked: true },
          key: undefined,
        }) as HTMLInputElement
        const option = createElement({
          type: 'option',
          props: { defaultSelected: true },
          key: undefined,
        }) as HTMLOptionElement
        const video = createElement({
          type: 'video',
          props: { defaultMuted: true },
          key: undefined,
        }) as HTMLVideoElement

        expect(input.defaultValue).toBe('initial')
        expect(input.defaultChecked).toBe(true)
        expect(input.getAttribute('defaultValue')).toBeNull()
        expect(option.defaultSelected).toBe(true)
        expect(video.defaultMuted).toBe(true)
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

      it('still assigns refs outside a root while warning in dev', () => {
        const ref = { current: null as Element | null }
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        const result = createElement({
          type: 'div',
          props: { ref },
          key: undefined,
        })

        expect(ref.current).toBe(result as Element)
        expect(warn).toHaveBeenCalledTimes(1)

        warn.mockRestore()
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

    it('creates template nodes in current root ownerDocument', () => {
      const foreignDoc = document.implementation.createHTMLDocument('foreign-template-owner')
      const foreignContainer = foreignDoc.createElement('div')
      const factory = template('<span>Owner</span>')
      let createdNode: Node | null = null

      const teardown = render(
        () => {
          createdNode = factory()
          return createdNode
        },
        foreignContainer as unknown as HTMLElement,
      )

      expect((createdNode as Node | null)?.ownerDocument).toBe(foreignDoc)
      expect(foreignContainer.firstChild?.ownerDocument).toBe(foreignDoc)
      teardown()
    })

    it('delegates template-clone events on the render root document', () => {
      const handler = vi.fn()
      const teardown = render(() => {
        const factory = template('<button type="button">Press</button>')
        const button = factory() as HTMLButtonElement
        spread(button, { onClick: handler }, false, true)
        return button
      }, container)

      const button = container.querySelector('button') as HTMLButtonElement
      expect(button).toBeTruthy()

      button.dispatchEvent(new Event('click', { bubbles: true }))
      expect(handler).toHaveBeenCalledTimes(1)

      teardown()
      clearDelegatedEvents()
    })

    it('uses importNode when isImportNode is true', () => {
      const factory = template('<img src="test.png" />', true)

      const node = factory()

      expect(node).toBeInstanceOf(HTMLImageElement)
    })

    it('resolves paths through template element content', () => {
      const factory = template(
        '<template><span data-id="inner">inner</span><template><b data-id="nested">nested</b></template></template>',
      )

      const node = factory() as HTMLTemplateElement
      const inner = node.content.querySelector('[data-id="inner"]')
      const nestedTemplate = node.content.querySelector('template') as HTMLTemplateElement
      const nested = nestedTemplate.content.querySelector('[data-id="nested"]')

      expect(node.childNodes).toHaveLength(0)
      expect(resolvePath(node, [0])).toBe(inner)
      expect(resolvePath(node, [1, 0])).toBe(nested)
    })

    it('handles SVG templates', () => {
      // With isSVG=true, pass content without <svg> wrapper
      // Runtime wraps it in <svg> for proper namespace parsing, then extracts content
      const factory = template('<circle cx="50" cy="50" r="40"/>', false, true)

      const node = factory()

      // SVG template returns the nested content (circle element in SVG namespace)
      expect(node.nodeName.toLowerCase()).toBe('circle')
      // Verify it's actually an SVGElement (not HTMLElement)
      expect(node).toBeInstanceOf(SVGElement)
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

    // Multi-root template warning tests
    describe('multi-root template protection', () => {
      it('warns in dev mode when template has multiple root nodes', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        // Template with two root nodes
        const factory = template('<div>First</div><div>Second</div>')
        const node = factory()

        // Should return a fragment with both nodes
        expect(node).toBeInstanceOf(DocumentFragment)
        const nodes = Array.from((node as DocumentFragment).childNodes)
        expect(nodes.length).toBe(2)
        expect((nodes[0] as HTMLDivElement).textContent).toBe('First')
        expect((nodes[1] as HTMLDivElement).textContent).toBe('Second')

        // Should have warned about multi-root
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[fict] Multi-root template'))

        warnSpy.mockRestore()
      })

      it('warns in dev mode for multi-root SVG templates', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        // SVG template with two root nodes
        const factory = template(
          '<circle cx="10" cy="10" r="5"/><circle cx="20" cy="20" r="5"/>',
          false,
          true,
        )
        const node = factory()

        // Should return a fragment with both nodes
        expect(node).toBeInstanceOf(DocumentFragment)
        const nodes = Array.from((node as DocumentFragment).childNodes)
        expect(nodes.length).toBe(2)
        expect(nodes[0]?.nodeName.toLowerCase()).toBe('circle')
        expect(nodes[1]?.nodeName.toLowerCase()).toBe('circle')

        // Should have warned about multi-root
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[fict] Multi-root SVG template'),
        )

        warnSpy.mockRestore()
      })

      it('warns in dev mode for multi-root MathML templates', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        // MathML template with two root nodes
        const factory = template('<mi>x</mi><mo>+</mo>', false, false, true)
        const node = factory()

        // Should return a fragment with both nodes
        expect(node).toBeInstanceOf(DocumentFragment)
        const nodes = Array.from((node as DocumentFragment).childNodes)
        expect(nodes.length).toBe(2)
        expect(nodes[0]?.nodeName.toLowerCase()).toBe('mi')
        expect(nodes[1]?.nodeName.toLowerCase()).toBe('mo')

        // Should have warned about multi-root
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[fict] Multi-root MathML template'),
        )

        warnSpy.mockRestore()
      })

      it('does not warn for single-root templates', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        const factory = template('<div><span>Nested</span></div>')
        factory()

        expect(warnSpy).not.toHaveBeenCalled()

        warnSpy.mockRestore()
      })
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

      expect((result as Element).namespaceURI).toBe('http://www.w3.org/1998/Math/MathML')
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
