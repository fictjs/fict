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
  it('rejects HTML plaintext before it can consume following markup', () => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const container = document.createElement('div')
    const plaintext = document.createElement('plaintext')
    plaintext.textContent = 'before <b>literal</b>'
    const trailing = document.createElement('span')
    trailing.id = 'after-plaintext'
    trailing.textContent = 'after'
    container.append(plaintext, trailing)

    expect(() => serializeHtmlNode(container)).toThrowError(
      /Cannot serialize HTML <plaintext>.*no closing tag.*snapshot script.*<pre>.*text\/plain/i,
    )
  })

  it('rejects plaintext in fragment output even when snapshots are disabled', () => {
    expect(() =>
      renderToString(
        () => ({
          type: 'div',
          props: {
            children: [
              { type: 'plaintext', props: { children: 'terminal-looking text' } },
              { type: 'span', props: { id: 'after-plaintext', children: 'after' } },
            ],
          },
        }),
        { includeSnapshot: false },
      ),
    ).toThrowError(/Cannot serialize HTML <plaintext>/)
  })

  it('rejects plaintext before a full-document snapshot can be swallowed', () => {
    function Content(): FictNode {
      return {
        type: 'div',
        props: {
          children: { type: 'plaintext', props: { children: 'unsafe tail' } },
        },
      }
    }

    expect(() =>
      renderToString(() => ({ type: Content, props: {} }), {
        fullDocument: true,
      }),
    ).toThrowError(/Cannot serialize HTML <plaintext>.*snapshot script/i)
  })

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

  it('rejects an internal SVG host even below an HTML integration point', () => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
    const host = document.createElementNS('http://www.w3.org/2000/svg', 'fict-host')
    host.setAttribute('data-fict-host', '')
    host.setAttribute('data-fict-s', 'svg-scope')
    host.appendChild(document.createTextNode('safe'))
    title.appendChild(host)
    svg.appendChild(title)

    expect(() => serializeHtmlNode(svg)).toThrowError(
      /resumable <fict-host>.*SVG.*range-based scope anchors/i,
    )
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

describe('host-sensitive HTML direct-child validation', () => {
  const conditionalCases = [
    { contextTag: 'details', sensitiveTag: 'summary' },
    { contextTag: 'fieldset', sensitiveTag: 'legend' },
    { contextTag: 'audio', sensitiveTag: 'source' },
    { contextTag: 'audio', sensitiveTag: 'track' },
    { contextTag: 'video', sensitiveTag: 'source' },
    { contextTag: 'video', sensitiveTag: 'track' },
    { contextTag: 'ruby', sensitiveTag: 'rt' },
    { contextTag: 'ruby', sensitiveTag: 'rp' },
    { contextTag: 'figure', sensitiveTag: 'figcaption' },
    { contextTag: 'map', sensitiveTag: 'area' },
  ] as const

  const safeFlowCases = [
    { contextTag: 'details', rootTag: 'p' },
    { contextTag: 'fieldset', rootTag: 'div' },
    { contextTag: 'audio', rootTag: 'p' },
    { contextTag: 'video', rootTag: 'p' },
    { contextTag: 'ruby', rootTag: 'span' },
    { contextTag: 'figure', rootTag: 'img' },
    { contextTag: 'map', rootTag: 'span' },
  ] as const

  function renderComponentInContext(contextTag: string, output: FictNode): string {
    function Content(): FictNode {
      return output
    }

    return renderToString(() => ({
      type: contextTag,
      props: { children: { type: Content, props: {} } },
    }))
  }

  function createSensitiveElement(document: Document, tagName: string): Element {
    const element = document.createElement(tagName)
    if (!['area', 'img', 'source', 'track'].includes(tagName)) {
      element.textContent = 'sensitive content'
    }
    return element
  }

  it.each(['source', 'span'])(
    'rejects every resumable component boundary directly inside <picture>, including <%s> roots',
    rootTag => {
      expect(() =>
        renderComponentInContext('picture', {
          type: rootTag,
          props: rootTag === 'source' ? {} : { children: 'content' },
        }),
      ).toThrowError(
        /resumable <fict-host>.*<picture>.*<source>.*<img>.*make .* own <picture>.*range-based scope anchors \(range-v3\)/i,
      )
    },
  )

  it.each(conditionalCases)(
    'rejects a resumable component exposing <$sensitiveTag> directly to <$contextTag>',
    ({ contextTag, sensitiveTag }) => {
      expect(() =>
        renderComponentInContext(contextTag, {
          type: sensitiveTag,
          props: ['area', 'source', 'track'].includes(sensitiveTag) ? {} : { children: 'content' },
        }),
      ).toThrowError(
        new RegExp(
          `resumable <fict-host>.*<${contextTag}>.*<${sensitiveTag}>.*make .* own <${contextTag}>.*range-based scope anchors \\(range-v3\\)`,
          'i',
        ),
      )
    },
  )

  it.each(conditionalCases)(
    'looks through consecutive internal hosts for <$contextTag> / <$sensitiveTag>',
    ({ contextTag, sensitiveTag }) => {
      const { document } = parseHTML('<!doctype html><html><body></body></html>')
      const context = document.createElement(contextTag)
      const outerHost = createResumableHost(document, 'outer-scope')
      const innerHost = createResumableHost(document, 'inner-scope')
      innerHost.replaceChildren(createSensitiveElement(document, sensitiveTag))
      outerHost.replaceChildren(innerHost)
      context.appendChild(outerHost)

      expect(() => serializeHtmlNode(context)).toThrowError(
        new RegExp(`<${contextTag}>.*<${sensitiveTag}>.*range-v3`, 'i'),
      )
    },
  )

  it.each(safeFlowCases)(
    'allows an ordinary <$rootTag> component directly inside <$contextTag>',
    ({ contextTag, rootTag }) => {
      const html = renderComponentInContext(contextTag, {
        type: rootTag,
        props: rootTag === 'img' ? {} : { children: 'safe flow content' },
      })

      expect(html).toContain(`<${contextTag}><fict-host`)
      expect(html).toContain(`<${rootTag}`)
    },
  )

  it.each(conditionalCases)(
    'does not inspect <$sensitiveTag> below a non-transparent element in <$contextTag>',
    ({ contextTag, sensitiveTag }) => {
      const { document } = parseHTML('<!doctype html><html><body></body></html>')
      const context = document.createElement(contextTag)
      const outerHost = createResumableHost(document, 'outer-scope')
      const wrapper = document.createElement('div')
      const innerHost = createResumableHost(document, 'inner-scope')
      innerHost.replaceChildren(createSensitiveElement(document, sensitiveTag))
      wrapper.appendChild(innerHost)
      outerHost.replaceChildren(wrapper)
      context.appendChild(outerHost)

      expect(() => serializeHtmlNode(context)).not.toThrow()
    },
  )

  it.each([{ contextTag: 'picture', sensitiveTag: 'source' }, ...conditionalCases])(
    'does not reserve an unmarked user <fict-host> in <$contextTag> around <$sensitiveTag>',
    ({ contextTag, sensitiveTag }) => {
      const { document } = parseHTML('<!doctype html><html><body></body></html>')
      const context = document.createElement(contextTag)
      const userHost = document.createElement('fict-host')
      userHost.replaceChildren(createSensitiveElement(document, sensitiveTag))
      context.appendChild(userHost)

      expect(serializeHtmlNode(context)).toContain('<fict-host>')
    },
  )

  it('stops transparent traversal at an unmarked user <fict-host>', () => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const details = document.createElement('details')
    const internalHost = createResumableHost(document, 'internal-scope')
    const userHost = document.createElement('fict-host')
    userHost.replaceChildren(document.createElement('summary'))
    internalHost.replaceChildren(userHost)
    details.appendChild(internalHost)

    expect(() => serializeHtmlNode(details)).not.toThrow()
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

describe('foreign-namespace resumable host validation', () => {
  it('rejects a resumable SVG component wrapper that suppresses rendered graphics', () => {
    const legacyDocument = parseHTML(
      '<!doctype html><html><body><svg><fict-host><circle cx="10" cy="10" r="5"></circle></fict-host></svg></body></html>',
    ).document
    const legacyCircle = legacyDocument.querySelector('circle')

    expect(legacyCircle?.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(legacyCircle?.parentElement?.localName).toBe('fict-host')

    function Graphic(): FictNode {
      return { type: 'circle', props: { cx: 10, cy: 10, r: 5 } }
    }

    expect(() =>
      renderToString(() => ({
        type: 'svg',
        props: {
          viewBox: '0 0 20 20',
          children: { type: Graphic, props: {} },
        },
      })),
    ).toThrowError(/resumable <fict-host>.*SVG.*range-based scope anchors/i)
  })

  it('rejects a resumable MathML wrapper that changes fixed-arity fraction children', () => {
    const legacyDocument = parseHTML(
      '<!doctype html><html><body><math><mfrac><fict-host><mi>numerator</mi><mi>denominator</mi></fict-host></mfrac></math></body></html>',
    ).document
    const legacyFraction = legacyDocument.querySelector('mfrac')

    expect(Array.from(legacyFraction?.children ?? [], child => child.localName)).toEqual([
      'fict-host',
    ])
    expect(
      Array.from(legacyFraction?.querySelectorAll('mi') ?? [], child => child.textContent),
    ).toEqual(['numerator', 'denominator'])

    function FractionParts(): FictNode {
      return [
        { type: 'mi', props: { children: 'numerator' } },
        { type: 'mi', props: { children: 'denominator' } },
      ]
    }

    expect(() =>
      renderToString(() => ({
        type: 'math',
        props: {
          children: {
            type: 'mfrac',
            props: { children: { type: FractionParts, props: {} } },
          },
        },
      })),
    ).toThrowError(/resumable <fict-host>.*MathML.*range-based scope anchors/i)
  })

  it('allows an HTML resumable component inside SVG foreignObject', () => {
    function HtmlIsland(): FictNode {
      return { type: 'div', props: { children: 'HTML island' } }
    }

    const html = renderToString(() => ({
      type: 'svg',
      props: {
        children: {
          type: 'foreignObject',
          props: { children: { type: HtmlIsland, props: {} } },
        },
      },
    }))

    expect(html).toContain('<foreignObject><fict-host')
    expect(html).toContain('<div>HTML island</div>')
  })

  it('does not reserve a namespaced fict-host without internal scope markers', () => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>')
    const host = document.createElementNS('http://www.w3.org/2000/svg', 'fict-host')
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    host.appendChild(circle)

    expect(serializeHtmlNode(host)).toBe('<fict-host><circle></circle></fict-host>')
  })
})
