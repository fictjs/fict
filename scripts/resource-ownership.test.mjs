import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { JSDOM } = require('../packages/runtime/node_modules/jsdom')
const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

for (const format of ['esm', 'cjs']) {
  test(`distributed ${format} shares resource ownership with Suspense`, async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>')
    const globals = new Map()
    for (const key of [
      'window',
      'document',
      'Node',
      'Element',
      'HTMLElement',
      'Document',
      'DocumentFragment',
      'Text',
      'Comment',
    ]) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value: dom.window[key],
      })
    }
    const disposers = []
    try {
      const runtime =
        format === 'esm'
          ? {
              ...(await import('../packages/runtime/dist/index.js')),
              ...(await import('../packages/runtime/dist/advanced.js')),
            }
          : {
              ...require('../packages/runtime/dist/index.cjs'),
              ...require('../packages/runtime/dist/advanced.cjs'),
            }
      const { resource } =
        format === 'esm'
          ? await import('../packages/fict/dist/plus.js')
          : require('../packages/fict/dist/plus.cjs')
      for (const graph of [false, true]) {
        const requests = []
        const query = resource({
          suspense: true,
          cache: { mode: 'none' },
          fetch: ({ signal }) => new Promise(resolve => requests.push({ signal, resolve })),
        })
        const mount = () => {
          const container = document.createElement('div')
          const dispose = runtime.render(
            () => ({
              type: runtime.Suspense,
              props: {
                fallback: 'loading',
                children: {
                  type: () => {
                    const result = query.read('shared')
                    return {
                      type: 'span',
                      props: {
                        children: graph ? runtime.reactive(() => result.data) : result.data,
                      },
                    }
                  },
                  props: {},
                },
              },
            }),
            container,
          )
          disposers.push(dispose)
          return { container, dispose }
        }
        const first = mount(),
          second = mount()
        assert.equal(requests.length, 1)
        assert.equal(second.container.textContent, 'loading')
        first.dispose()
        assert.equal(requests[0].signal.aborted, false)
        second.dispose()
        assert.equal(requests[0].signal.aborted, true)
        const next = mount()
        assert.equal(requests.length, 2)
        requests[0].resolve('obsolete')
        await drain()
        assert.equal(next.container.textContent, 'loading')
        requests[1].resolve('ready')
        await drain()
        assert.equal(next.container.textContent, 'ready')
        assert.equal(requests.length, 2)
        next.dispose()
      }
    } finally {
      while (disposers.length) disposers.pop()()
      dom.window.close()
      for (const [key, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globalThis[key]
      }
    }
  })
}
