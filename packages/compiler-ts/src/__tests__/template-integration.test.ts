// @vitest-environment jsdom

import { createRequire } from 'module'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import * as runtime from '../../../runtime/src'
import * as runtimeJsx from '../../../runtime/src/jsx-runtime'
import { createFictTransformer } from '../index'

function compileAndLoad(source: string): {
  mount: (el: HTMLElement) => () => void
  api: { toggle(): void }
  destroyed: string[]
} {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: 'fict-runtime',
    },
    transformers: {
      before: [createFictTransformer()],
    },
  })

  const module: { exports: any } = { exports: {} }
  const prelude =
    "const __fictRuntime = require('fict-runtime');" +
    'const { createSignal: __fictSignal, createMemo: __fictMemo, createConditional: __fictConditional, createList: __fictList, insert: __fictInsert, createElement: __fictCreateElement, onDestroy: __fictOnDestroy } = __fictRuntime;'

  const dynamicRequire = createRequire(import.meta.url)

  const wrapped = new Function('require', 'module', 'exports', `${prelude}\n${result.outputText}`)
  wrapped(
    (id: string) => {
      if (id === 'fict-runtime') return runtime
      if (id === 'fict-runtime/jsx-runtime') return runtimeJsx
      if (id === 'fict') return runtime
      return dynamicRequire(id)
    },
    module,
    module.exports,
  )

  return module.exports
}

describe('compiled templates DOM integration', () => {
  it('mounts and cleans up fragment output produced via insert', () => {
    const source = `
      import { $state, onDestroy } from 'fict'
      import { render } from 'fict'

      export const destroyed: string[] = []
      export let api: { toggle(): void }

      function Child() {
        onDestroy(() => destroyed.push('child'))
        return (
          <>
            <span data-id="a">A</span>
            <span data-id="b">B</span>
          </>
        )
      }

      export function App() {
        let show = $state(true)
        api = { toggle: () => (show = !show) }
        const content = show ? <Child /> : null
        return <div>{content}</div>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `

    const mod = compileAndLoad(source)
    const container = document.createElement('div')
    const teardown = mod.mount(container)

    expect(container.querySelectorAll('span').length).toBe(2)

    mod.api.toggle()
    expect(container.querySelectorAll('span').length).toBe(0)
    expect(mod.destroyed).toEqual(['child'])

    teardown()
    expect(container.innerHTML).toBe('')
  })
})
