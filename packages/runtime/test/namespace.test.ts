import { describe, expect, it } from 'vitest'

import {
  createContext,
  createElement,
  createPortal,
  createSuspenseToken,
  ErrorBoundary,
  render,
  Suspense,
  type FictNode,
} from '../src/index'
import { createChildBinding, createSignal, reactive } from '../src/advanced'
import {
  __fictDisableResumable,
  __fictEnableResumable,
  __fictGetScopeRegistry,
  __fictProp,
  assign,
  createKeyedList,
  insert,
} from '../src/internal'

const SVG_NS = 'http://www.w3.org/2000/svg'
const HTML_NS = 'http://www.w3.org/1999/xhtml'
const MATH_NS = 'http://www.w3.org/1998/Math/MathML'

const nextTick = () => Promise.resolve()

describe('namespace handling in createElement', () => {
  it('creates SVG elements with the correct namespace at runtime', () => {
    const circle = createElement({ type: 'circle', props: {} }) as SVGElement
    expect(circle.namespaceURI).toBe(SVG_NS)
  })

  it('propagates SVG namespace through dynamic children', async () => {
    const container = document.createElement('div')
    const dispose = render(
      () => ({
        type: 'svg',
        props: {
          children: reactive(() => ({ type: 'circle', props: { r: 2 } })),
        },
      }),
      container,
    )

    await nextTick()
    const circle = container.querySelector('circle')
    expect(circle?.namespaceURI).toBe(SVG_NS)

    dispose()
  })

  it('resets namespace to HTML inside foreignObject children', async () => {
    const container = document.createElement('div')
    const dispose = render(
      () => ({
        type: 'svg',
        props: {
          children: {
            type: 'foreignObject',
            props: {
              children: { type: 'div', props: { id: 'html-child', children: 'ok' } },
            },
          },
        },
      }),
      container,
    )

    await nextTick()
    const div = container.querySelector('#html-child')
    expect(div?.namespaceURI).toBe(HTML_NS)

    dispose()
  })

  it('follows SVG and MathML HTML integration points for runtime VNodes', async () => {
    const container = document.createElement('div')
    const dispose = render(
      () => ({
        type: 'div',
        props: {
          children: [
            { type: 'circle', props: { id: 'ordinary-html' } },
            {
              type: 'svg',
              props: {
                children: [
                  {
                    type: 'title',
                    props: {
                      children: reactive(() => ({
                        type: 'circle',
                        props: { id: 'svg-title-html' },
                      })),
                    },
                  },
                  {
                    type: 'desc',
                    props: {
                      children: { type: 'circle', props: { id: 'svg-desc-html' } },
                    },
                  },
                  {
                    type: 'foreignObject',
                    props: {
                      children: { type: 'circle', props: { id: 'svg-foreign-html' } },
                    },
                  },
                  {
                    type: 'foreignobject',
                    props: {
                      children: { type: 'circle', props: { id: 'svg-lower-foreign-html' } },
                    },
                  },
                  {
                    type: 'g',
                    props: {
                      children: [
                        { type: 'circle', props: { id: 'svg-native' } },
                        {
                          type: 'math',
                          props: {
                            id: 'svg-math',
                            children: { type: 'mi', props: { id: 'svg-math-mi' } },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
            {
              type: 'math',
              props: {
                'data-main-math': '',
                children: [
                  {
                    type: 'annotation-XML',
                    props: {
                      encoding: ' TEXT/HTML ',
                      children: { type: 'circle', props: { id: 'annotation-padded-math' } },
                    },
                  },
                  {
                    type: 'annotation-xml',
                    props: {
                      encoding: 'application/xhtml+xml',
                      children: { type: 'circle', props: { id: 'annotation-xhtml' } },
                    },
                  },
                  {
                    type: 'annotation-xml',
                    props: {
                      encoding: 'application/xml',
                      children: [
                        { type: 'mi', props: { id: 'annotation-math' } },
                        {
                          type: 'svg',
                          props: {
                            id: 'annotation-svg',
                            children: { type: 'circle', props: { id: 'annotation-svg-circle' } },
                          },
                        },
                        { type: 'math', props: { id: 'annotation-math-tag' } },
                      ],
                    },
                  },
                  {
                    type: 'mrow',
                    props: {
                      children: {
                        type: 'svg',
                        props: {
                          id: 'math-svg-foreign',
                          children: { type: 'circle', props: { id: 'math-svg-foreign-circle' } },
                        },
                      },
                    },
                  },
                  ...['mi', 'mo', 'mn', 'ms', 'mtext'].map(type => ({
                    type,
                    props: {
                      children: { type: 'circle', props: { id: `${type}-html` } },
                    },
                  })),
                  {
                    type: 'mText',
                    props: {
                      children: [
                        { type: 'mGlyph', props: { id: 'math-mglyph' } },
                        { type: 'malignmark', props: { id: 'math-malignmark' } },
                        {
                          type: 'svg',
                          props: {
                            id: 'math-svg',
                            children: { type: 'circle', props: { id: 'math-svg-circle' } },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
      container,
    )

    await nextTick()

    for (const element of container.querySelectorAll('svg > title, svg > desc, foreignObject')) {
      expect(element.namespaceURI, element.localName).toBe(SVG_NS)
    }
    for (const element of container.querySelectorAll(
      '[data-main-math] > annotation-xml, [data-main-math] > mi, [data-main-math] > mo, [data-main-math] > mn, [data-main-math] > ms, [data-main-math] > mtext',
    )) {
      expect(element.namespaceURI, element.localName).toBe(MATH_NS)
    }
    expect(container.querySelector('annotation-xml')?.getAttribute('encoding')).toBe(' TEXT/HTML ')

    for (const id of [
      'svg-title-html',
      'svg-desc-html',
      'svg-foreign-html',
      'svg-lower-foreign-html',
      'ordinary-html',
      'annotation-xhtml',
      'mi-html',
      'mo-html',
      'mn-html',
      'ms-html',
      'mtext-html',
    ]) {
      expect(container.querySelector(`#${id}`)?.namespaceURI, id).toBe(HTML_NS)
    }
    expect(container.querySelector('#svg-native')?.namespaceURI).toBe(SVG_NS)
    expect(container.querySelector('#svg-math')?.namespaceURI).toBe(SVG_NS)
    expect(container.querySelector('#svg-math-mi')?.namespaceURI).toBe(SVG_NS)
    expect(container.querySelector('#annotation-padded-math')?.namespaceURI).toBe(MATH_NS)
    expect(container.querySelector('#annotation-math')?.namespaceURI).toBe(MATH_NS)
    expect(container.querySelector('#annotation-svg')?.namespaceURI).toBe(SVG_NS)
    expect(container.querySelector('#annotation-svg-circle')?.namespaceURI).toBe(SVG_NS)
    expect(container.querySelector('#annotation-math-tag')?.namespaceURI).toBe(MATH_NS)
    expect(container.querySelector('#math-svg-foreign')?.namespaceURI).toBe(MATH_NS)
    expect(container.querySelector('#math-svg-foreign-circle')?.namespaceURI).toBe(MATH_NS)
    expect(container.querySelector('#math-mglyph')?.namespaceURI).toBe(MATH_NS)
    expect(container.querySelector('#math-malignmark')?.namespaceURI).toBe(MATH_NS)
    expect(container.querySelector('#math-svg')?.namespaceURI).toBe(SVG_NS)
    expect(container.querySelector('#math-svg-circle')?.namespaceURI).toBe(SVG_NS)

    dispose()
  })

  it('creates MathML content with preserved namespace', () => {
    const math = createElement({
      type: 'math',
      props: { children: { type: 'mi', props: { children: 'x' } } },
    }) as Element

    expect(math.namespaceURI).toBe(MATH_NS)
    const child = math.firstChild as Element | null
    expect(child?.namespaceURI).toBe(MATH_NS)
  })

  it('preserves foreign namespace through delayed Suspense and ErrorBoundary replay', async () => {
    const pending = createSuspenseToken()
    let ready = false
    const AsyncChild = () => {
      if (!ready) throw pending.token
      return { type: 'div', props: { id: 'suspense-resolved' } }
    }
    const ThrowButton = () => ({
      type: 'button',
      props: {
        id: 'error-trigger',
        onClick: () => {
          throw new Error('later')
        },
      },
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const dispose = render(
      () => ({
        type: 'svg',
        props: {
          children: {
            type: 'g',
            props: {
              children: [
                {
                  type: Suspense,
                  props: {
                    fallback: { type: 'div', props: { id: 'suspense-fallback' } },
                    children: { type: AsyncChild, props: null },
                  },
                },
                {
                  type: ErrorBoundary,
                  props: {
                    fallback: { type: 'div', props: { id: 'error-fallback' } },
                    children: { type: ThrowButton, props: null },
                  },
                },
              ],
            },
          },
        },
      }),
      container,
    )

    await nextTick()
    expect(container.querySelector('#suspense-fallback')?.namespaceURI).toBe(SVG_NS)

    container.querySelector('#error-trigger')?.dispatchEvent(new Event('click', { bubbles: true }))
    await nextTick()
    expect(container.querySelector('#error-fallback')?.namespaceURI).toBe(SVG_NS)

    ready = true
    pending.resolve()
    await nextTick()
    await nextTick()
    expect(container.querySelector('#suspense-resolved')?.namespaceURI).toBe(SVG_NS)

    dispose()
    container.remove()
  })

  it('keeps parser-compatible resumable roots in the logical call-site namespace', async () => {
    const CircleChild = (props: { id: string }) => ({
      type: 'circle',
      props: { id: props.id },
    })
    const MiChild = (props: { id: string }) => ({
      type: 'mi',
      props: { id: props.id },
    })
    const SvgChild = (props: { id: string }) => ({
      type: 'svg',
      props: { id: props.id },
    })

    const container = document.createElement('div')
    __fictEnableResumable()
    let dispose: (() => void) | undefined
    try {
      dispose = render(
        () => ({
          type: 'div',
          props: {
            children: [
              {
                type: 'svg',
                props: {
                  id: 'svg-case',
                  children: {
                    type: 'g',
                    props: {
                      children: {
                        type: CircleChild,
                        props: { id: 'svg-component-circle' },
                      },
                    },
                  },
                },
              },
              {
                type: 'math',
                props: {
                  children: [
                    {
                      type: 'mtext',
                      props: { children: { type: MiChild, props: { id: 'mtext-component-mi' } } },
                    },
                    {
                      type: 'annotation-xml',
                      props: {
                        encoding: 'text/html',
                        children: { type: SvgChild, props: { id: 'annotation-component-svg' } },
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
        container,
      )

      await nextTick()

      const svgCircle = container.querySelector('#svg-component-circle') as Element
      const mtextMi = container.querySelector('#mtext-component-mi') as Element
      const annotationSvg = container.querySelector('#annotation-component-svg') as Element
      expect(svgCircle.parentElement?.localName).toBe('fict-host')
      expect(svgCircle.parentElement?.namespaceURI).toBe(SVG_NS)
      expect(svgCircle.namespaceURI).toBe(SVG_NS)
      expect(mtextMi.parentElement?.namespaceURI).toBe(HTML_NS)
      expect(mtextMi.namespaceURI).toBe(HTML_NS)
      expect(annotationSvg.parentElement?.namespaceURI).toBe(HTML_NS)
      expect(annotationSvg.namespaceURI).toBe(SVG_NS)

      const reparsed = new DOMParser().parseFromString(
        `<!doctype html><html><body>${container.innerHTML}</body></html>`,
        'text/html',
      )
      expect(reparsed.querySelector('#svg-component-circle')?.parentElement?.namespaceURI).toBe(
        SVG_NS,
      )
      expect(reparsed.querySelector('#svg-component-circle')?.namespaceURI).toBe(SVG_NS)
      expect(reparsed.querySelector('#mtext-component-mi')?.parentElement?.namespaceURI).toBe(
        HTML_NS,
      )
      expect(reparsed.querySelector('#mtext-component-mi')?.namespaceURI).toBe(HTML_NS)
      expect(reparsed.querySelector('#annotation-component-svg')?.parentElement?.namespaceURI).toBe(
        HTML_NS,
      )
      expect(reparsed.querySelector('#annotation-component-svg')?.namespaceURI).toBe(SVG_NS)
    } finally {
      dispose?.()
      __fictDisableResumable()
    }
  })

  it('fails closed when a resumable component exposes an mtext MathML exception root', () => {
    const MixedChild = (): FictNode => [
      { type: 'span', props: { id: 'safe-first-root' } },
      { type: 'mglyph', props: { id: 'unsafe-later-root' } },
    ]
    const container = document.createElement('div')
    __fictEnableResumable()
    let dispose: (() => void) | undefined
    try {
      expect(() => {
        dispose = render(
          () => ({
            type: 'math',
            props: {
              children: {
                type: 'mtext',
                props: { children: { type: MixedChild, props: null } },
              },
            },
          }),
          container,
        )
      }).toThrowError(
        /resumable <fict-host>.*direct <mglyph>.*MathML namespace.*HTML namespace.*range-based scope anchors/i,
      )
      expect(container.childNodes).toHaveLength(0)
      expect(container.querySelector('[data-fict-s]')).toBeNull()
    } finally {
      dispose?.()
      __fictDisableResumable()
    }
  })

  it('fails closed when an HTML breakout root would escape a foreign resumable host', () => {
    const HtmlChild = (): FictNode => ({ type: 'div', props: { id: 'escaping-root' } })
    const container = document.createElement('div')
    __fictEnableResumable()
    let dispose: (() => void) | undefined
    try {
      expect(() => {
        dispose = render(
          () => ({
            type: 'svg',
            props: {
              children: {
                type: 'g',
                props: { children: { type: HtmlChild, props: null } },
              },
            },
          }),
          container,
        )
      }).toThrowError(
        /resumable <fict-host>.*direct <div>.*HTML parser would exit foreign content.*outside the host.*range-based scope anchors/i,
      )
      expect(container.childNodes).toHaveLength(0)
      expect(container.querySelector('[data-fict-s]')).toBeNull()
    } finally {
      dispose?.()
      __fictDisableResumable()
    }
  })

  it('fails closed when a resumable component exposes direct SVG in non-HTML annotation-xml', () => {
    const MixedChild = (): FictNode => [
      { type: 'mi', props: { id: 'safe-first-root' } },
      { type: 'svg', props: { id: 'unsafe-later-root' } },
    ]
    const container = document.createElement('div')
    __fictEnableResumable()
    let dispose: (() => void) | undefined
    try {
      expect(() => {
        dispose = render(
          () => ({
            type: 'math',
            props: {
              children: {
                type: 'annotation-xml',
                props: {
                  encoding: 'application/xml',
                  children: { type: MixedChild, props: null },
                },
              },
            },
          }),
          container,
        )
      }).toThrowError(
        /resumable <fict-host>.*direct <svg>.*SVG namespace.*MathML namespace.*range-based scope anchors/i,
      )
      expect(container.childNodes).toHaveLength(0)
      expect(container.querySelector('[data-fict-s]')).toBeNull()
    } finally {
      dispose?.()
      __fictDisableResumable()
    }
  })

  it('derives parent-targeted binding namespaces and owner documents from the real target', () => {
    const foreignDocument = document.implementation.createHTMLDocument('foreign-bindings')
    const math = foreignDocument.createElementNS(MATH_NS, 'math')
    const insertRow = foreignDocument.createElementNS(MATH_NS, 'mrow')
    const childRow = foreignDocument.createElementNS(MATH_NS, 'mrow')
    const assignedRow = foreignDocument.createElementNS(MATH_NS, 'mrow')
    const portalRow = foreignDocument.createElementNS(MATH_NS, 'mrow')
    const mtext = foreignDocument.createElementNS(MATH_NS, 'mtext')
    const svg = foreignDocument.createElementNS(SVG_NS, 'svg')
    const title = foreignDocument.createElementNS(SVG_NS, 'title')
    svg.appendChild(title)
    math.append(insertRow, childRow, assignedRow, portalRow, mtext)
    foreignDocument.body.append(math, svg)

    const cleanupInsert = insert(
      insertRow,
      () => ({ type: 'mi', props: { id: 'insert-mi' } }),
      createElement,
    )
    const childBinding = createChildBinding(
      childRow,
      () => ({ type: 'mi', props: { id: 'binding-mi' } }),
      createElement,
    )
    assign(assignedRow, { children: { type: 'mi', props: { id: 'assigned-mi' } } }, 'mathml')
    const portal = createPortal(
      portalRow,
      () => ({ type: 'mi', props: { id: 'portal-mi' } }),
      createElement,
    )
    const glyphBinding = createChildBinding(
      mtext,
      () => ({ type: 'mglyph', props: { id: 'binding-glyph' } }),
      createElement,
    )
    const titleBinding = createChildBinding(
      title,
      () => ({ type: 'circle', props: { id: 'title-html-circle' } }),
      createElement,
    )

    try {
      for (const id of ['insert-mi', 'binding-mi', 'assigned-mi', 'portal-mi']) {
        const element = foreignDocument.querySelector(`#${id}`)
        expect(element?.namespaceURI).toBe(MATH_NS)
        expect(element?.ownerDocument).toBe(foreignDocument)
      }
      expect(foreignDocument.querySelector('#binding-glyph')?.namespaceURI).toBe(MATH_NS)
      expect(foreignDocument.querySelector('#title-html-circle')?.namespaceURI).toBe(HTML_NS)
    } finally {
      cleanupInsert()
      childBinding.dispose?.()
      portal.dispose?.()
      glyphBinding.dispose?.()
      titleBinding.dispose?.()
    }
  })

  it('re-resolves marker-targeted bindings after their marker moves', async () => {
    const version = createSignal(0)
    const htmlParent = document.createElement('div')
    const math = document.createElementNS(MATH_NS, 'math')
    const mathParent = document.createElementNS(MATH_NS, 'mrow')
    math.appendChild(mathParent)
    document.body.append(htmlParent, math)

    const insertMarker = document.createComment('moved-insert')
    htmlParent.appendChild(insertMarker)
    const cleanupInsert = insert(
      htmlParent,
      () => {
        version()
        return { type: 'mi', props: { id: 'moved-insert-mi' } }
      },
      insertMarker,
      createElement,
    )
    const portal = createPortal(
      htmlParent,
      () => {
        version()
        return { type: 'mi', props: { id: 'moved-portal-mi' } }
      },
      createElement,
    )

    expect(htmlParent.querySelector('#moved-insert-mi')?.namespaceURI).toBe(HTML_NS)
    expect(htmlParent.querySelector('#moved-portal-mi')?.namespaceURI).toBe(HTML_NS)

    mathParent.append(insertMarker, portal.marker)
    version(1)
    await nextTick()

    try {
      expect(mathParent.querySelector('#moved-insert-mi')?.namespaceURI).toBe(MATH_NS)
      expect(mathParent.querySelector('#moved-portal-mi')?.namespaceURI).toBe(MATH_NS)
      expect(htmlParent.querySelector('mi')).toBeNull()
    } finally {
      cleanupInsert()
      portal.dispose?.()
      htmlParent.remove()
      math.remove()
    }
  })

  it('preserves a Context Provider node and call-site namespace across value updates', async () => {
    const ValueContext = createContext(0)
    const value = createSignal(0)
    const container = document.createElement('div')
    const dispose = render(
      () => ({
        type: 'math',
        props: {
          children: {
            type: 'mrow',
            props: {
              children: {
                type: ValueContext.Provider,
                props: {
                  value: __fictProp(() => value()),
                  children: { type: 'mi', props: { id: 'provider-mi' } },
                },
              },
            },
          },
        },
      }),
      container,
    )

    try {
      const initial = container.querySelector('#provider-mi')
      expect(initial?.namespaceURI).toBe(MATH_NS)

      value(1)
      await nextTick()

      const retained = container.querySelector('#provider-mi')
      expect(retained).toBe(initial)
      expect(retained?.namespaceURI).toBe(MATH_NS)
    } finally {
      dispose()
    }
  })

  it('rolls back nested resumable scopes when parent-targeted renders fail', () => {
    const registry = __fictGetScopeRegistry()
    registry.clear()
    __fictEnableResumable()

    const Nested = (): FictNode => ({ type: 'span', props: { children: 'nested' } })
    const UnsafeListItem = (): FictNode => [
      { type: Nested, props: null },
      { type: 'mglyph', props: null },
    ]
    const math = document.createElementNS(MATH_NS, 'math')
    const mtext = document.createElementNS(MATH_NS, 'mtext')
    math.appendChild(mtext)
    document.body.appendChild(math)

    const list = createKeyedList(
      () => [1],
      item => item,
      () => ({ type: UnsafeListItem, props: null }) as unknown as Node[],
      false,
      undefined,
      undefined,
      false,
      'parent',
    )
    mtext.appendChild(list.marker)

    try {
      expect(() => list.flush?.()).toThrowError(/direct <mglyph>.*range-based scope anchors/i)
      expect(registry.size).toBe(0)

      expect(() =>
        insert(
          mtext,
          () => {
            createElement({ type: Nested, props: null })
            throw new Error('getter failed')
          },
          createElement,
        ),
      ).toThrowError('getter failed')
      expect(registry.size).toBe(0)
    } finally {
      list.dispose()
      registry.clear()
      __fictDisableResumable()
      math.remove()
    }
  })
})
