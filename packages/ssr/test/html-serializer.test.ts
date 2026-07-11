import { describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'

import { render } from '@fictjs/runtime'

import { serializeHtmlNode } from '../src/html-serializer'

describe('SSR HTML serializer DOM name validation', () => {
  it('rejects an invalid element accepted by a permissive server DOM', () => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const name = 'div><script data-fict-xss="tag">'
    const element = document.createElement(name)

    expect(element.localName).toBe(name)
    expect(() => serializeHtmlNode(element)).toThrowError(/Invalid element name/)
  })

  it('rejects an invalid attribute accepted by a permissive server DOM', () => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const name = 'data-safe"><script data-fict-xss="attribute">'
    const element = document.createElement('div')
    element.setAttribute(name, 'unsafe')

    expect(element.hasAttribute(name)).toBe(true)
    expect(() => serializeHtmlNode(element)).toThrowError(/Invalid attribute name/)
  })

  it('rejects an invalid doctype name from a permissive DOM', () => {
    const doctype = {
      nodeType: 10,
      name: 'html><script data-fict-xss="doctype">',
      publicId: '',
      systemId: '',
    } as unknown as DocumentType

    expect(() => serializeHtmlNode(doctype)).toThrowError(/Invalid element name/)
  })

  it('keeps processing-instruction data inert when reparsed as HTML', () => {
    const instruction = {
      nodeType: 7,
      nodeName: 'fict',
      nodeValue: '><script data-fict-xss="processing-instruction">unsafe</script>',
    } as unknown as Node

    const html = serializeHtmlNode(instruction)
    const { document } = parseHTML(`<html><body>${html}</body></html>`)

    expect(html).toContain('<!--?fict')
    expect(document.querySelector('[data-fict-xss="processing-instruction"]')).toBeNull()
  })

  it.each(['>', '->'])('keeps comment data starting with %s inert when reparsed', prefix => {
    const comment = {
      nodeType: 8,
      nodeValue: `${prefix}<script data-fict-xss="comment">unsafe</script>`,
    } as unknown as Node

    const html = serializeHtmlNode(comment)
    const { document } = parseHTML(`<html><body>${html}</body></html>`)

    expect(html).toMatch(/^<!-- [>-]/)
    expect(document.querySelector('[data-fict-xss="comment"]')).toBeNull()
    expect(document.body.childNodes).toHaveLength(1)
    expect(document.body.firstChild?.nodeType).toBe(8)
  })

  it('preserves a qualified element name from namespace-aware DOMs', () => {
    const element = {
      nodeType: 1,
      localName: 'item',
      tagName: 'fict:item',
      prefix: 'fict',
      namespaceURI: 'urn:fict:test',
      attributes: [],
      childNodes: [],
    } as unknown as Element

    expect(serializeHtmlNode(element)).toBe('<fict:item></fict:item>')
  })

  it('keeps empty namespaced nodes from swallowing later HTML siblings', () => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const container = document.createElement('div')
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    const sibling = document.createElement('span')
    sibling.textContent = 'after'
    container.append(circle, sibling)

    const html = serializeHtmlNode(container)
    const reparsed = parseHTML(`<!doctype html><html><body>${html}</body></html>`).document
    const reparsedContainer = reparsed.body.firstElementChild!

    expect(html).toContain('<circle></circle><span>after</span>')
    expect(reparsedContainer.childNodes).toHaveLength(2)
    expect(reparsedContainer.lastElementChild?.localName).toBe('span')
    expect(reparsedContainer.lastElementChild?.parentElement).toBe(reparsedContainer)
  })
})

describe('direct runtime rendering with a permissive server DOM', () => {
  it('rejects an invalid element before linkedom can materialize it', () => {
    const { document } = parseHTML('<!doctype html><html><body><main></main></body></html>')
    const name = 'div><script data-fict-xss="runtime-tag">'
    const container = document.querySelector('main') as HTMLElement

    expect(() => document.createElement(name)).not.toThrow()
    expect(() =>
      render(() => ({ type: name, props: { children: 'unsafe' } }), container),
    ).toThrowError(/Invalid element name/)
    expect(container.querySelector('[data-fict-xss="runtime-tag"]')).toBeNull()
  })

  it('rejects an invalid attribute before linkedom can materialize it', () => {
    const { document } = parseHTML('<!doctype html><html><body><main></main></body></html>')
    const name = 'data-safe"><script data-fict-xss="runtime-attribute">'
    const container = document.querySelector('main') as HTMLElement
    const permissiveProbe = document.createElement('div')

    expect(() => permissiveProbe.setAttribute(name, 'unsafe')).not.toThrow()
    expect(() =>
      render(() => ({ type: 'div', props: { [name]: 'unsafe' } }), container),
    ).toThrowError(/Invalid attribute name/)
    expect(container.querySelector('[data-fict-xss="runtime-attribute"]')).toBeNull()
  })
})
