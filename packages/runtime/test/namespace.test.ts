import { describe, expect, it } from 'vitest'

import { createElement, render } from '../src/index'

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
          children: () => ({ type: 'circle', props: { r: 2 } }),
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

  it('creates MathML content with preserved namespace', () => {
    const math = createElement({
      type: 'math',
      props: { children: { type: 'mi', props: { children: 'x' } } },
    }) as Element

    expect(math.namespaceURI).toBe(MATH_NS)
    const child = math.firstChild as Element | null
    expect(child?.namespaceURI).toBe(MATH_NS)
  })
})
