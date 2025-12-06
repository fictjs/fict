import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { createFictTransformer } from '../index'

const transform = (source: string) => {
  return ts.transpileModule(source, {
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
}

describe('semantic validation', () => {
  it('throws when $state is declared inside a loop', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        for (let i = 0; i < 10; i++) {
          const x = $state(i)
        }
      }
    `
    expect(() => transform(source)).toThrow(/cannot be declared inside loops/)
  })

  it('throws when $state is declared inside a conditional', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        if (true) {
          const x = $state(0)
        }
      }
    `
    expect(() => transform(source)).toThrow(/cannot be declared inside loops or conditionals/)
  })

  it('throws when $state is declared inside a nested function (closure)', () => {
    const source = `
      import { $state } from 'fict'
      function App() {
        const handleClick = () => {
          const x = $state(0)
        }
      }
    `
    expect(() => transform(source)).toThrow(/cannot be declared inside nested functions/)
  })

  it('throws when $effect is used inside a loop', () => {
    const source = `
      import { $state, $effect } from 'fict'
      function App() {
        for(let i=0; i<5; i++) {
          $effect(() => console.log(i))
        }
      }
    `
    expect(() => transform(source)).toThrow(/cannot be called inside loops/)
  })

  it('throws when destructuring $state result', () => {
    // Rule: const { x } = $state(...) is illegal
    const source = `
      import { $state } from 'fict'
      function App() {
        const { x } = $state({ x: 1 })
      }
     `
    expect(() => transform(source)).toThrow(/Destructuring \$state is not supported/)
  })

  it('throws when $state assignment target is not an identifier', () => {
    const source = `
      import { $state } from 'fict'
      const [x] = $state(0)
    `
    expect(() => transform(source)).toThrow(/Destructuring \$state is not supported/)
  })

  it('throws when assigning to $state call result', () => {
    const source = `
      import { $state } from 'fict'
      let count = $state(0)
      $state(1) = 2
    `
    expect(() => transform(source)).toThrow(/\$state\(\) must assign to an identifier/)
  })

  it('throws on spread/object left assignment of reactive', () => {
    const source = `
      import { $state } from 'fict'
      let count = $state(0)
      ;[count] = [1]
    `
    expect(() => transform(source)).toThrow(/Illegal assignment target/)
  })
})
