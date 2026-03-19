import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('compiler runtime import family selection', () => {
  it('targets fict/internal for modules that import from fict', () => {
    const output = transform(`
      import { $state } from 'fict'

      export function Counter() {
        let count = $state(0)
        return <button>{count}</button>
      }
    `)

    expect(output).toContain('from "fict/internal"')
    expect(output).not.toContain('from "@fictjs/runtime/internal"')
  })

  it('targets runtime/internal for modules that import from @fictjs/runtime', () => {
    const output = transform(`
      import { render } from '@fictjs/runtime'

      export function mount(el: HTMLElement) {
        return render(() => <div>ok</div>, el)
      }
    `)

    expect(output).toContain('from "@fictjs/runtime/internal"')
    expect(output).not.toContain('from "fict/internal"')
  })

  it('defaults to fict/internal when the source does not declare a runtime family', () => {
    const output = transform(`
      export function App() {
        return <div>hello</div>
      }
    `)

    expect(output).toContain('from "fict/internal"')
  })

  it('prefers the fict family when both package families appear in the same module', () => {
    const output = transform(`
      import { $state } from 'fict'
      import { render } from '@fictjs/runtime'

      function App() {
        let count = $state(0)
        return <button>{count}</button>
      }

      export function mount(el: HTMLElement) {
        return render(() => <App />, el)
      }
    `)

    expect(output).toContain('from "fict/internal"')
    expect(output).not.toContain('from "@fictjs/runtime/internal"')
  })
})
