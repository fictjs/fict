import { describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'

import { render } from '@fictjs/runtime'
import type { FictNode } from '@fictjs/runtime'

import { serializeHtmlNode } from '../src/html-serializer'
import { renderToString } from '../src/index'

function createResumableHost(document: Document, scopeId = 'scope-1'): Element {
  const host = document.createElement('fict-host')
  host.setAttribute('data-fict-host', '')
  host.setAttribute('data-fict-s', scopeId)
  host.setAttribute('data-fict-h', '/entry.js#resume')
  const child = document.createElement('span')
  child.textContent = 'content'
  host.appendChild(child)
  return host
}

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

describe('resumable host HTML parser context validation', () => {
  it.each([
    'table',
    'tbody',
    'thead',
    'tfoot',
    'tr',
    'colgroup',
    'select',
    'optgroup',
    'option',
    'iframe',
    'noembed',
    'noframes',
    'noscript',
    'script',
    'style',
    'xmp',
    'textarea',
    'title',
    'plaintext',
    'head',
    'html',
    'frameset',
  ])('rejects a resumable host inside <%s>', contextTag => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const context = document.createElement(contextTag)
    context.appendChild(createResumableHost(document))

    let thrown: unknown
    try {
      serializeHtmlNode(context)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('Cannot serialize resumable <fict-host>')
    expect((thrown as Error).message).toContain(`<${contextTag}>`)
    expect((thrown as Error).message).toContain('HTML parser')
    expect((thrown as Error).message).toContain('Move the component')
  })

  it('rejects a real resumable row component before returning corrupt table HTML', () => {
    function Row(): FictNode {
      return {
        type: 'tr',
        props: {
          children: {
            type: 'td',
            props: { children: 'row' },
          },
        },
      }
    }

    expect(() =>
      renderToString(() => ({
        type: 'table',
        props: {
          children: {
            type: 'tbody',
            props: { children: { type: Row, props: {} } },
          },
        },
      })),
    ).toThrowError(/resumable <fict-host>.*<tbody>/)
  })

  it('allows a resumable component inside a table cell', () => {
    function CellContent(): FictNode {
      return { type: 'button', props: { children: 'safe' } }
    }

    const html = renderToString(() => ({
      type: 'table',
      props: {
        children: {
          type: 'tbody',
          props: {
            children: {
              type: 'tr',
              props: {
                children: {
                  type: 'td',
                  props: { children: { type: CellContent, props: {} } },
                },
              },
            },
          },
        },
      },
    }))

    expect(html).toContain('<td><fict-host')
    expect(html).toContain('<button>safe</button>')
  })

  it('does not treat a namespaced SVG host as an unsafe HTML parser host', () => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
    const host = document.createElementNS('http://www.w3.org/2000/svg', 'fict-host')
    host.setAttribute('data-fict-host', '')
    host.setAttribute('data-fict-s', 'svg-scope')
    host.appendChild(document.createTextNode('safe'))
    title.appendChild(host)
    svg.appendChild(title)

    expect(serializeHtmlNode(svg)).toContain('<title><fict-host')
  })

  it('does not reserve the fict-host tag name without internal scope markers', () => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const table = document.createElement('table')
    const userElement = document.createElement('fict-host')
    userElement.textContent = 'user-defined'
    table.appendChild(userElement)

    expect(serializeHtmlNode(table)).toBe('<table><fict-host>user-defined</fict-host></table>')
  })

  it('rejects a resumable scope inside template content', () => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const template = document.createElement('template')
    template.content.appendChild(createResumableHost(document, 'template-scope'))

    expect(() => serializeHtmlNode(template)).toThrowError(/template.*resumable scope.*cloned/i)
  })

  it('rejects a resumable event QRL inside template content', () => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const template = document.createElement('template')
    const button = document.createElement('button')
    button.setAttribute('on:click', '/entry.js#handler')
    template.content.appendChild(button)

    expect(() => serializeHtmlNode(template)).toThrowError(/template.*resumable event.*cloned/i)
  })

  it('finds resumable scopes inside nested template content', () => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const outer = document.createElement('template')
    const inner = document.createElement('template')
    inner.content.appendChild(createResumableHost(document, 'nested-template-scope'))
    outer.content.appendChild(inner)

    expect(() => serializeHtmlNode(outer)).toThrowError(/template.*resumable scope.*cloned/i)
  })

  it('continues to serialize inert template content', () => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const template = document.createElement('template')
    const span = document.createElement('span')
    span.textContent = 'static'
    template.content.appendChild(span)

    expect(serializeHtmlNode(template)).toBe('<template><span>static</span></template>')
  })
})

describe('HTML void element child validation', () => {
  it.each([
    'area',
    'base',
    'basefont',
    'bgsound',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'keygen',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
  ])('rejects child nodes that HTML serialization would discard from <%s>', tagName => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const element = document.createElement(tagName)
    element.append(document.createTextNode('lost'))

    expect(() => serializeHtmlNode(element)).toThrowError(
      new RegExp(`Cannot serialize <${tagName}> with 1 child node`),
    )
  })

  it('rejects even empty text and comment children because node identity cannot round-trip', () => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const br = document.createElement('br')
    br.append(document.createTextNode(''), document.createComment('lost'))

    expect(() => serializeHtmlNode(br)).toThrowError(/<br> with 2 child nodes/)
  })

  it('rejects an orphaned resumable scope inside a void element', () => {
    function LostChild(): FictNode {
      return { type: 'span', props: { children: 'lost scope' } }
    }

    expect(() =>
      renderToString(() => ({
        type: 'input',
        props: { children: { type: LostChild, props: {} } },
      })),
    ).toThrowError(/Cannot serialize <input> with 1 child node.*resumable scope/i)
  })

  it('continues to serialize empty HTML void elements without closing tags', () => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const input = document.createElement('input')
    input.setAttribute('value', 'safe')

    expect(serializeHtmlNode(input)).toBe('<input value="safe">')
  })

  it('keeps same-named foreign-namespace elements out of HTML void rules', () => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const input = document.createElementNS('http://www.w3.org/2000/svg', 'input')
    const child = document.createElementNS('http://www.w3.org/2000/svg', 'value')
    child.textContent = 'safe'
    input.appendChild(child)

    expect(serializeHtmlNode(input)).toBe('<input><value>safe</value></input>')
  })
})
