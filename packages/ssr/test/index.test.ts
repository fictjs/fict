import { describe, it, expect } from 'vitest'
import { parseHTML } from 'linkedom'

import { Suspense, createSuspenseToken, onDestroy, type FictNode } from '@fictjs/runtime'
import {
  FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
  __fictQrl,
  __fictUseContext,
  __fictUseSignal,
  setProp,
} from '@fictjs/runtime/internal'

import {
  createSSRDocument,
  renderToDocument,
  renderToString,
  renderToStringAsync,
} from '../src/index'

describe('@fictjs/ssr', () => {
  it('keeps Preview snapshots default-off and requires an explicit opt-in', () => {
    const view = (): FictNode => ({ type: 'div', props: { children: 'supported SSR' } })

    expect(renderToString(view)).not.toContain('__FICT_SNAPSHOT__')
    expect(renderToString(view, { includeSnapshot: true })).toContain('__FICT_SNAPSHOT__')
  })

  describe('form property bindings', () => {
    it('serializes a select property binding when the SSR DOM exposes a read-only getter', () => {
      const { document } = createSSRDocument()
      const select = document.createElement('select')
      select.innerHTML =
        '<option value="standard">Standard</option><option value="elevated">Elevated</option>'

      setProp(select, 'value', 'elevated')

      expect(select.value).toBe('elevated')
      expect(select.querySelector('option[value="elevated"]')?.hasAttribute('selected')).toBe(true)
      expect(select.querySelector('option[value="standard"]')?.hasAttribute('selected')).toBe(false)
    })
  })

  describe('renderToStringAsync', () => {
    it('waits for Suspense boundaries and returns their final content', async () => {
      const pending = createSuspenseToken()
      let ready = false

      const AsyncChild = (): FictNode => {
        if (!ready) throw pending.token
        return { type: 'span', props: { children: 'resolved content' } }
      }

      const htmlPromise = renderToStringAsync(
        () => ({
          type: Suspense as any,
          props: {
            fallback: { type: 'span', props: { children: 'loading content' } },
            children: { type: AsyncChild, props: {} },
          },
        }),
        { includeSnapshot: false },
      )
      let settled = false
      void htmlPromise.then(() => {
        settled = true
      })

      await Promise.resolve()
      await Promise.resolve()
      expect(settled).toBe(false)

      ready = true
      pending.resolve()

      const html = await htmlPromise
      expect(html).toContain('resolved content')
      expect(html).not.toContain('loading content')
    })

    it('keeps renderToString synchronous and fallback-first', () => {
      const pending = createSuspenseToken()
      const AsyncChild = (): FictNode => {
        throw pending.token
      }

      const html = renderToString(
        () => ({
          type: Suspense as any,
          props: {
            fallback: { type: 'span', props: { children: 'synchronous fallback' } },
            children: { type: AsyncChild, props: {} },
          },
        }),
        { includeSnapshot: false },
      )

      expect(html).toContain('synchronous fallback')
      pending.resolve()
    })
  })

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

    it.each(['xml:widget', 'xmlns:widget', 'xmlns'])(
      'rejects a reserved prefix in SVG and MathML namespaces: %s',
      tagName => {
        for (const root of ['svg', 'math'] as const) {
          expect(() =>
            renderToString(
              () => ({ type: root, props: { children: { type: tagName, props: {} } } }),
              { includeSnapshot: false },
            ),
          ).toThrowError(/Invalid namespace for element name/)
        }
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

    it('rejects a pre-created invalid container at the final serialization boundary', () => {
      const dom = createSSRDocument()
      const container = dom.document.createElement(
        'main><script data-fict-xss="container">',
      ) as HTMLElement
      dom.document.body.appendChild(container)
      const globals = globalThis as Record<string, unknown>
      const hadDocument = Object.prototype.hasOwnProperty.call(globals, 'document')
      const previousDocument = globals.document
      let destroyed = false

      expect(() =>
        renderToString(
          () => {
            onDestroy(() => {
              destroyed = true
              throw new Error('cleanup must not replace serialization failure')
            })
            return 'safe'
          },
          {
            dom,
            container,
            exposeGlobals: true,
            includeContainer: true,
            includeSnapshot: false,
          },
        ),
      ).toThrowError(/Invalid element name/)

      expect(destroyed).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(globals, 'document')).toBe(hadDocument)
      expect(globals.document).toBe(previousDocument)
    })

    it.each(['publicId', 'systemId'] as const)(
      'keeps a hostile document doctype %s inert at the final serialization boundary',
      property => {
        const dom = createSSRDocument()
        const doctype = dom.document.doctype
        expect(doctype).not.toBeNull()
        Object.defineProperty(doctype!, property, {
          value: '"><script data-fict-xss="doctype">unsafe</script>',
          configurable: true,
        })

        const html = renderToString(() => ({ type: 'main', props: { children: 'safe' } }), {
          dom,
          fullDocument: true,
          includeSnapshot: false,
        })
        const { document } = parseHTML(html)

        expect(document.querySelector('[data-fict-xss="doctype"]')).toBeNull()
        expect(document.querySelector('main')?.textContent).toBe('safe')
      },
    )

    it('tears down a completed render when snapshot serialization fails', () => {
      let destroyed = false

      function InvalidSnapshot(): FictNode {
        const ctx = __fictUseContext()
        __fictUseSignal(ctx, [() => 'not serializable'], { name: 'value' })
        onDestroy(() => {
          destroyed = true
        })
        return { type: 'span', props: { children: 'unsafe snapshot' } }
      }

      ;(InvalidSnapshot as { __fictMeta?: unknown }).__fictMeta = {
        id: 'InvalidSnapshot@test',
        resume: 'invalid-snapshot#resume',
      }

      expect(() =>
        renderToString(() => ({ type: InvalidSnapshot, props: {} }), {
          includeSnapshot: true,
        }),
      ).toThrowError(/Cannot serialize function/)
      expect(destroyed).toBe(true)
    })

    it('rejects all-ready serialization failures and tears down the render', async () => {
      const dom = createSSRDocument()
      const invalidNode = dom.document.createElement(
        'div><script data-fict-xss="all-ready">',
      ) as unknown as FictNode
      let destroyed = false

      await expect(
        renderToStringAsync(
          () => {
            onDestroy(() => {
              destroyed = true
            })
            return invalidNode
          },
          { dom, includeSnapshot: false },
        ),
      ).rejects.toThrow(/Invalid element name/)

      expect(destroyed).toBe(true)
    })

    it('preserves valid custom, data, aria, Unicode, and namespaced names', () => {
      const result = renderToDocument(
        () => ({
          type: 'svg',
          props: {
            children: {
              type: 'use',
              props: { 'xlink:href': '#icon', 'xml:lang': 'en', 'aria-label': 'icon' },
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
        // linkedom does not expose namespaceURI for qualified attributes, so
        // the SSR contract is verified at the serialized qualified-name layer.
        expect(use?.getAttribute('xlink:href')).toBe('#icon')
        expect(use?.getAttribute('xml:lang')).toBe('en')
        expect(use?.getAttribute('aria-label')).toBe('icon')
        expect(result.html).toContain('xlink:href="#icon"')
        expect(result.html).toContain('xml:lang="en"')

        const { document } = parseHTML(`<html><body>${result.html}</body></html>`)
        const reparsedUse = document.querySelector('use')
        expect(reparsedUse?.getAttribute('xlink:href')).toBe('#icon')
        expect(reparsedUse?.getAttribute('xml:lang')).toBe('en')
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

  it('holds the compatibility-global lease until renderToDocument disposal', () => {
    const result = renderToDocument(() => 'leased', {
      exposeGlobals: true,
      includeSnapshot: false,
    })

    try {
      let defaultRenderCalled = false
      expect(() =>
        renderToString(() => {
          defaultRenderCalled = true
          return globalThis.document?.body?.textContent ?? 'no-global-document'
        }),
      ).toThrowError(/including renders that do not expose globals/)
      expect(defaultRenderCalled).toBe(false)

      expect(() =>
        renderToDocument(() => 'overlap', {
          exposeGlobals: true,
          includeSnapshot: false,
        }),
      ).toThrowError(/cannot be used by overlapping or nested renders/)
    } finally {
      result.dispose()
    }

    expect(() =>
      renderToString(() => 'after-dispose', {
        exposeGlobals: true,
        includeSnapshot: false,
      }),
    ).not.toThrow()
  })

  it('prevents compatibility globals from starting during an ordinary document render', () => {
    const result = renderToDocument(() => 'ordinary-render', { includeSnapshot: false })

    try {
      let compatibilityRenderCalled = false
      expect(() =>
        renderToString(
          () => {
            compatibilityRenderCalled = true
            return 'compatibility-overlap'
          },
          { exposeGlobals: true, includeSnapshot: false },
        ),
      ).toThrowError(/including renders that do not expose globals/)
      expect(compatibilityRenderCalled).toBe(false)
    } finally {
      result.dispose()
    }

    expect(() =>
      renderToString(() => 'compatibility-after-dispose', {
        exposeGlobals: true,
        includeSnapshot: false,
      }),
    ).not.toThrow()
  })

  it('restores process DOM globals when explicit disposal throws', () => {
    const globals = globalThis as Record<string, unknown>
    const hadDocument = Object.prototype.hasOwnProperty.call(globals, 'document')
    const hadWindow = Object.prototype.hasOwnProperty.call(globals, 'window')
    const previousDocument = globals.document
    const previousWindow = globals.window
    const sentinelDocument = { sentinel: 'document' }
    const sentinelWindow = { sentinel: 'window' }

    try {
      globals.document = sentinelDocument
      globals.window = sentinelWindow

      const result = renderToDocument(
        () => {
          onDestroy(() => {
            throw new Error('dispose cleanup failed')
          })
          return { type: 'div', props: { children: 'cleanup' } }
        },
        { exposeGlobals: true, includeSnapshot: false },
      )

      expect(globals.document).toBe(result.document)
      expect(globals.window).toBe(result.window)
      expect(() => result.dispose()).toThrow('dispose cleanup failed')
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

  it('renders snapshot script with scope data', () => {
    function Counter(props: { initial: number }): FictNode {
      const ctx = __fictUseContext()
      const count = __fictUseSignal(ctx, props.initial, { name: 'count' })
      return { type: 'span', props: { children: String(count()) } }
    }

    ;(Counter as any).__fictMeta = { id: 'Counter@test', resume: 'counter#resume' }

    const html = renderToString(() => ({ type: Counter as any, props: { initial: 5 } }), {
      includeSnapshot: true,
    })

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

    const html = renderToString(() => ({ type: Counter, props: {} }), {
      includeSnapshot: true,
    })
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
