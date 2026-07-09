import { describe, it, expect } from 'vitest'
import { parseHTML } from 'linkedom'

import type { FictNode } from '@fictjs/runtime'
import {
  FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
  __fictQrl,
  __fictUseContext,
  __fictUseSignal,
} from '@fictjs/runtime/internal'

import { renderToDocument, renderToString } from '../src/index'

describe('@fictjs/ssr', () => {
  describe('DOM name validation', () => {
    it.each(['1div', 'div name', 'div><script data-fict-xss="tag">', 'svg/onload'])(
      'rejects an invalid dynamic element name: %s',
      tagName => {
        expect(() =>
          renderToString(() => ({ type: tagName, props: { children: 'unsafe' } }), {
            includeSnapshot: false,
          }),
        ).toThrowError(/Invalid element name/)
      },
    )

    it('rejects an invalid dynamic prop key', () => {
      const attributeName = 'data-safe"><script data-fict-xss="attribute">'

      expect(() =>
        renderToString(
          () => ({
            type: 'div',
            props: { [attributeName]: 'unsafe' },
          }),
          { includeSnapshot: false },
        ),
      ).toThrowError(/Invalid attribute name/)
    })

    it.each(['main><script data-fict-xss="container">', '1main', 'main shell'])(
      'rejects an invalid containerTag: %s',
      containerTag => {
        expect(() =>
          renderToString(() => 'safe', {
            containerTag,
            includeContainer: true,
            includeSnapshot: false,
          }),
        ).toThrowError(/Invalid element name/)
      },
    )

    it('rejects invalid containerAttributes, including omitted values', () => {
      const attributeName = 'data-safe"><script data-fict-xss="container-attribute">'

      expect(() =>
        renderToString(() => 'safe', {
          containerAttributes: { [attributeName]: null },
          includeContainer: true,
          includeSnapshot: false,
        }),
      ).toThrowError(/Invalid attribute name/)
    })

    it('preserves valid custom, data, aria, Unicode, and namespaced names', () => {
      const result = renderToDocument(
        () => ({
          type: 'svg',
          props: {
            children: {
              type: 'use',
              props: { 'xlink:href': '#icon', 'aria-label': 'icon' },
            },
          },
        }),
        {
          containerTag: 'fict-shell',
          containerAttributes: {
            'data-mode': 'ssr',
            'aria-label': 'application',
            état: 'ready',
            'xml:lang': 'en',
          },
          includeContainer: true,
          includeSnapshot: false,
        },
      )

      try {
        const use = result.container.querySelector('use')
        expect(result.container.localName).toBe('fict-shell')
        expect(result.container.getAttribute('data-mode')).toBe('ssr')
        expect(result.container.getAttribute('aria-label')).toBe('application')
        expect(result.container.getAttribute('état')).toBe('ready')
        expect(result.container.getAttribute('xml:lang')).toBe('en')
        expect(use?.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe('#icon')
        expect(use?.getAttribute('aria-label')).toBe('icon')
      } finally {
        result.dispose()
      }
    })
  })

  it.each(['title', 'textarea', 'style', 'script'] as const)(
    'keeps text inside <%s> inert when SSR output is parsed as HTML',
    tagName => {
      const attack = `</${tagName}><script data-fict-xss="${tagName}">globalThis.__fictXss=1</script>`
      const html = renderToString(() => ({ type: tagName, props: { children: attack } }), {
        includeSnapshot: false,
      })

      const { document } = parseHTML(
        `<!doctype html><html><head></head><body>${html}</body></html>`,
      )

      expect(document.querySelector(`[data-fict-xss="${tagName}"]`)).toBeNull()
    },
  )

  it.each(['style', 'script'] as const)(
    'neutralizes a </%s> end tag split across adjacent text nodes',
    tagName => {
      const splitAt = Math.floor(tagName.length / 2)
      const html = renderToString(
        () => ({
          type: tagName,
          props: {
            children: [
              `</${tagName.slice(0, splitAt)}`,
              `${tagName.slice(splitAt)}><script data-fict-xss="split"></script>`,
            ],
          },
        }),
        { includeSnapshot: false },
      )

      const { document } = parseHTML(
        `<!doctype html><html><head></head><body>${html}</body></html>`,
      )
      expect(document.querySelector('[data-fict-xss="split"]')).toBeNull()
    },
  )

  it('preserves literal ampersands in attributes across HTML reparsing', () => {
    const href = 'javascript&colon;globalThis.__fictXss=1'
    const note = 'a&copy;b"<unsafe>'
    const encodedSrcdoc = '&lt;script data-fict-xss="srcdoc"&gt;parent.__fictXss=1&lt;/script&gt;'
    const html = renderToString(
      () => ({
        type: 'div',
        props: {
          children: [
            { type: 'a', props: { href, 'data-note': note } },
            { type: 'iframe', props: { srcdoc: encodedSrcdoc } },
          ],
        },
      }),
      { includeSnapshot: false },
    )

    const { document } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`)
    const anchor = document.querySelector('a')
    const iframe = document.querySelector('iframe')

    expect(anchor?.getAttribute('href')).toBe(href)
    expect(anchor?.getAttribute('data-note')).toBe(note)
    expect(iframe?.getAttribute('srcdoc')).toBe(encodedSrcdoc)

    const srcdoc = iframe?.getAttribute('srcdoc') ?? ''
    const nested = parseHTML(`<!doctype html><html><body>${srcdoc}</body></html>`)
    expect(nested.document.querySelector('[data-fict-xss="srcdoc"]')).toBeNull()
  })

  it('does not replace process DOM globals by default', () => {
    const globals = globalThis as Record<string, unknown>
    const hadDocument = Object.prototype.hasOwnProperty.call(globals, 'document')
    const hadWindow = Object.prototype.hasOwnProperty.call(globals, 'window')
    const previousDocument = globals.document
    const previousWindow = globals.window
    const sentinelDocument = { sentinel: 'document' }
    const sentinelWindow = { sentinel: 'window' }
    let seenDocument: unknown
    let seenWindow: unknown

    try {
      globals.document = sentinelDocument
      globals.window = sentinelWindow

      const result = renderToDocument(
        () => {
          seenDocument = globals.document
          seenWindow = globals.window
          return { type: 'div', props: { children: 'safe' } }
        },
        { includeSnapshot: false },
      )

      expect(result.html).toContain('<div>safe</div>')
      expect(seenDocument).toBe(sentinelDocument)
      expect(seenWindow).toBe(sentinelWindow)
      expect(globals.document).toBe(sentinelDocument)
      expect(globals.window).toBe(sentinelWindow)
      result.dispose()
      expect(globals.document).toBe(sentinelDocument)
      expect(globals.window).toBe(sentinelWindow)
    } finally {
      if (hadDocument) {
        globals.document = previousDocument
      } else {
        delete globals.document
      }
      if (hadWindow) {
        globals.window = previousWindow
      } else {
        delete globals.window
      }
    }
  })

  it('exposes and restores process DOM globals only when explicitly requested', () => {
    const globals = globalThis as Record<string, unknown>
    const hadDocument = Object.prototype.hasOwnProperty.call(globals, 'document')
    const hadWindow = Object.prototype.hasOwnProperty.call(globals, 'window')
    const previousDocument = globals.document
    const previousWindow = globals.window
    let seenDocument: unknown
    let seenWindow: unknown

    try {
      delete globals.document
      delete globals.window

      const result = renderToDocument(
        () => {
          seenDocument = globals.document
          seenWindow = globals.window
          return { type: 'div', props: { children: 'compat' } }
        },
        { exposeGlobals: true, includeSnapshot: false },
      )

      expect(result.html).toContain('<div>compat</div>')
      expect(seenDocument).toBe(result.document)
      expect(seenWindow).toBe(result.window)
      expect(globals.document).toBe(result.document)
      expect(globals.window).toBe(result.window)
      result.dispose()
      expect(Object.prototype.hasOwnProperty.call(globals, 'document')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(globals, 'window')).toBe(false)
    } finally {
      if (hadDocument) {
        globals.document = previousDocument
      } else {
        delete globals.document
      }
      if (hadWindow) {
        globals.window = previousWindow
      } else {
        delete globals.window
      }
    }
  })

  it('renders snapshot script with scope data', () => {
    function Counter(props: { initial: number }): FictNode {
      const ctx = __fictUseContext()
      const count = __fictUseSignal(ctx, props.initial, { name: 'count' })
      return { type: 'span', props: { children: String(count()) } }
    }

    ;(Counter as any).__fictMeta = { id: 'Counter@test', resume: 'counter#resume' }

    const html = renderToString(() => ({ type: Counter as any, props: { initial: 5 } }))

    expect(html).toContain('<fict-host')
    expect(html).toContain('data-fict-s=')
    expect(html).toContain('data-fict-t="Counter@test"')
    expect(html).toContain('data-fict-h="counter#resume"')

    const match = html.match(
      /<script id="__FICT_SNAPSHOT__" type="application\/json">([^<]*)<\/script>/,
    )
    expect(match).not.toBeNull()
    const state = JSON.parse(match?.[1] ?? '{}') as {
      v: number
      scopes: Record<
        string,
        { slots: Array<[number, string, unknown]>; props?: Record<string, unknown> }
      >
    }
    const scopeIds = Object.keys(state.scopes ?? {})
    expect(scopeIds.length).toBe(1)
    expect(state.v).toBe(FICT_SSR_SNAPSHOT_SCHEMA_VERSION)
    const scope = state.scopes[scopeIds[0]!]!
    expect(scope.props?.initial).toBe(5)
    expect(scope.slots).toEqual([[0, 'sig', 5]])
  })

  it('escapes snapshot payload to avoid script breakout', () => {
    const attack = '</script><script>globalThis.__fictXss=1</script>'

    function Counter(): FictNode {
      const ctx = __fictUseContext()
      const message = __fictUseSignal(ctx, attack, { name: 'message' })
      return { type: 'span', props: { children: String(message()) } }
    }

    ;(Counter as any).__fictMeta = { id: 'Counter@xss', resume: 'counter#resume' }

    const html = renderToString(() => ({ type: Counter, props: {} }))
    expect(html).not.toContain('</script><script>globalThis.__fictXss=1</script>')
    expect(html).toContain('\\u003c/script\\u003e\\u003cscript\\u003eglobalThis.__fictXss=1')

    const match = html.match(
      /<script id="__FICT_SNAPSHOT__" type="application\/json">([^<]*)<\/script>/,
    )
    expect(match).not.toBeNull()
    const state = JSON.parse(match?.[1] ?? '{}') as {
      scopes: Record<string, { slots: Array<[number, string, unknown]> }>
    }
    const scope = state.scopes[Object.keys(state.scopes)[0]!]!
    expect(scope.slots[0]?.[2]).toBe(attack)
  })

  it('installs manifest mapping for QRL resolution', () => {
    const manifest = {
      'file:///counter.tsx': '/assets/counter.js',
    }
    let qrl = ''

    const result = renderToDocument(
      () => {
        qrl = __fictQrl('file:///counter.tsx', '__fict_r0')
        return { type: 'div', props: {} }
      },
      {
        includeSnapshot: false,
        manifest,
      },
    )

    try {
      expect(qrl).toBe('/assets/counter.js#__fict_r0')
      expect((globalThis as Record<string, unknown>).__FICT_MANIFEST__).toBeUndefined()
    } finally {
      result.dispose()
    }
  })

  it('keeps manifest mappings scoped to nested SSR sessions', () => {
    const seen: string[] = []

    const html = renderToString(
      () => {
        seen.push(__fictQrl('file:///shared.tsx', '__fict_outer0'))
        renderToString(
          () => {
            seen.push(__fictQrl('file:///shared.tsx', '__fict_inner0'))
            return { type: 'span', props: { children: 'inner' } }
          },
          {
            includeSnapshot: false,
            manifest: { 'file:///shared.tsx': '/assets/inner.js' },
          },
        )
        seen.push(__fictQrl('file:///shared.tsx', '__fict_outer1'))
        return { type: 'div', props: { children: 'outer' } }
      },
      {
        includeSnapshot: false,
        manifest: { 'file:///shared.tsx': '/assets/outer.js' },
      },
    )

    expect(html).toContain('<div>outer</div>')
    expect(seen).toEqual([
      '/assets/outer.js#__fict_outer0',
      '/assets/inner.js#__fict_inner0',
      '/assets/outer.js#__fict_outer1',
    ])
    expect((globalThis as Record<string, unknown>).__FICT_MANIFEST__).toBeUndefined()
  })
})
