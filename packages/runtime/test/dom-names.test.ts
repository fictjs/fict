import { describe, expect, it } from 'vitest'

import { createElement } from '../src/index'
import { assign, setAttr } from '../src/internal'

describe('DOM name validation', () => {
  it.each(['1div', 'div name', 'div><script data-fict-xss="tag">', 'svg/onload'])(
    'rejects an invalid dynamic element name before DOM creation: %s',
    name => {
      expect(() =>
        createElement({
          type: name,
          props: { children: 'unsafe' },
          key: undefined,
        }),
      ).toThrowError(/Invalid element name/)
    },
  )

  it('accepts browser-valid HTML, custom-element, Unicode, and namespace-aware names', () => {
    const customElement = createElement({
      type: 'fict-widget',
      props: { children: 'custom' },
      key: undefined,
    }) as Element
    const unicodeElement = createElement({
      type: 'emoji-😀',
      props: { children: 'unicode' },
      key: undefined,
    }) as Element
    const svg = createElement({
      type: 'svg',
      props: {
        children: {
          type: 'icon:use',
          props: { 'xlink:href': '#icon', 'aria-label': 'icon' },
          key: undefined,
        },
      },
      key: undefined,
    }) as SVGElement

    expect(customElement.localName).toBe('fict-widget')
    expect(unicodeElement.localName).toBe('emoji-😀')
    expect(svg.firstElementChild?.localName).toBe('use')
    expect(svg.firstElementChild?.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe(
      '#icon',
    )
    expect(svg.firstElementChild?.getAttribute('aria-label')).toBe('icon')
  })

  it.each(['data-safe"><script data-fict-xss="attribute">', 'data unsafe', '1data-value'])(
    'rejects an invalid dynamic JSX attribute name: %s',
    name => {
      expect(() =>
        createElement({
          type: 'div',
          props: { [name]: 'unsafe' },
          key: undefined,
        }),
      ).toThrowError(/Invalid attribute name/)
    },
  )

  it('validates forced, spread, direct, and namespaced attribute paths', () => {
    const div = document.createElement('div')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'use')

    expect(() => assign(div, { 'attr:data unsafe': 'value' })).toThrowError(
      /Invalid attribute name/,
    )
    expect(() => assign(div, { 'bool:data>unsafe': true })).toThrowError(/Invalid attribute name/)
    expect(() => setAttr(div, 'data unsafe', 'value')).toThrowError(/Invalid attribute name/)
    expect(() => setAttr(svg, 'xlink::href', '#icon')).toThrowError(/Invalid attribute name/)
    expect(() => setAttr(svg, 'xlink:1href', '#icon')).toThrowError(/Invalid attribute name/)

    assign(div, { 'data-mode': 'client', 'aria-label': 'application' })
    setAttr(svg, 'xlink:href', '#icon')

    expect(div.getAttribute('data-mode')).toBe('client')
    expect(div.getAttribute('aria-label')).toBe('application')
    expect(svg.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe('#icon')
  })
})
