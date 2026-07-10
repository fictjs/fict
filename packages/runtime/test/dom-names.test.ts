import { describe, expect, it } from 'vitest'

import { createElement } from '../src/index'
import {
  assertValidDOMAttributeName,
  assertValidDOMElementName,
  assign,
  setAttr,
} from '../src/internal'

function expectInvalidCharacterError(fn: () => unknown): void {
  let error: unknown
  try {
    fn()
  } catch (caught) {
    error = caught
  }

  expect(error).toBeInstanceOf(DOMException)
  expect((error as DOMException).name).toBe('InvalidCharacterError')
}

function expectNamespaceError(fn: () => unknown): void {
  let error: unknown
  try {
    fn()
  } catch (caught) {
    error = caught
  }

  expect(error).toBeInstanceOf(DOMException)
  expect((error as DOMException).name).toBe('NamespaceError')
}

describe('DOM name handling', () => {
  it.each(['1div', 'div name', 'div><script data-fict-xss="tag">', 'svg/onload'])(
    'rejects an invalid dynamic element name before DOM creation: %s',
    name => {
      expectInvalidCharacterError(() =>
        createElement({
          type: name,
          props: { children: 'unsafe' },
          key: undefined,
        }),
      )
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

  it.each(['xml:widget', 'xmlns:widget', 'xmlns'])(
    'rejects a reserved prefix in SVG and MathML namespaces: %s',
    name => {
      for (const root of ['svg', 'math'] as const) {
        expectNamespaceError(() =>
          createElement({
            type: root,
            props: { children: { type: name, props: {}, key: undefined } },
            key: undefined,
          }),
        )
      }
    },
  )

  it.each(['data-safe"><script data-fict-xss="attribute">', 'data unsafe', '1data-value'])(
    'rejects an invalid dynamic JSX attribute name: %s',
    name => {
      expectInvalidCharacterError(() =>
        createElement({
          type: 'div',
          props: { [name]: 'unsafe' },
          key: undefined,
        }),
      )
    },
  )

  it('validates forced, spread, direct, and namespaced attribute paths', () => {
    const div = document.createElement('div')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'use')

    expectInvalidCharacterError(() => assign(div, { 'attr:data unsafe': 'value' }))
    expectInvalidCharacterError(() => assign(div, { 'bool:data>unsafe': true }))
    expectInvalidCharacterError(() => setAttr(div, 'data unsafe', 'value'))
    expectInvalidCharacterError(() => setAttr(svg, 'xlink::href', '#icon'))
    expectInvalidCharacterError(() => setAttr(svg, 'xlink:1href', '#icon'))

    assign(div, { 'data-mode': 'client', 'aria-label': 'application' })
    setAttr(svg, 'xlink:href', '#icon')

    expect(div.getAttribute('data-mode')).toBe('client')
    expect(div.getAttribute('aria-label')).toBe('application')
    expect(svg.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe('#icon')
    expect(svg.getAttribute('xlink:href')).toBe('#icon')
  })

  it('implements the XML Name and QName boundary ranges', () => {
    const validStartBoundaries = [
      0x3a, 0x41, 0x5a, 0x5f, 0x61, 0x7a, 0xc0, 0xd6, 0xd8, 0xf6, 0xf8, 0x2ff, 0x370, 0x37d, 0x37f,
      0x1fff, 0x200c, 0x200d, 0x2070, 0x218f, 0x2c00, 0x2fef, 0x3001, 0xd7ff, 0xf900, 0xfdcf,
      0xfdf0, 0xfffd, 0x10000, 0xeffff,
    ]
    const invalidStartBoundaries = [
      0x0, 0x2d, 0x30, 0xb7, 0xd7, 0xf7, 0x300, 0x36f, 0x37e, 0x200b, 0x200e, 0x206f, 0x2190,
      0x2bff, 0x2ff0, 0x3000, 0xd800, 0xf8ff, 0xfdd0, 0xfffe, 0xffff, 0xf0000, 0x10ffff,
    ]

    for (const codePoint of validStartBoundaries) {
      expect(() => assertValidDOMElementName(String.fromCodePoint(codePoint))).not.toThrow()
    }
    for (const codePoint of invalidStartBoundaries) {
      expectInvalidCharacterError(() => assertValidDOMElementName(String.fromCodePoint(codePoint)))
    }

    for (const codePoint of [0x2d, 0x2e, 0x30, 0x39, 0xb7, 0x300, 0x36f, 0x203f, 0x2040]) {
      expect(() => assertValidDOMAttributeName(`a${String.fromCodePoint(codePoint)}`)).not.toThrow()
    }

    for (const name of ['a:b', 'état:名', 'emoji:😀']) {
      expect(() => assertValidDOMAttributeName(name, true)).not.toThrow()
    }
    for (const name of [':a', 'a:', 'a:b:c', '1a:b', 'a:1b', 'a b']) {
      expectInvalidCharacterError(() => assertValidDOMAttributeName(name, true))
    }

    expect(() =>
      assertValidDOMAttributeName('xml:lang', true, 'http://www.w3.org/XML/1998/namespace'),
    ).not.toThrow()
    expect(() =>
      assertValidDOMAttributeName('xmlns:xlink', true, 'http://www.w3.org/2000/xmlns/'),
    ).not.toThrow()
    expectNamespaceError(() =>
      assertValidDOMAttributeName('xml:lang', true, 'http://www.w3.org/2000/svg'),
    )
    expectNamespaceError(() =>
      assertValidDOMAttributeName('xmlns:xlink', true, 'http://www.w3.org/1999/xlink'),
    )
  })
})
