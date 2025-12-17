import { describe, it, expect } from 'vitest'
import { transformFineGrained } from './test-utils'

describe('Template Cloning Strategy', () => {
  const compile = (code: string) => {
    return transformFineGrained(code, { fineGrainedDom: true })
  }

  it('compiles specific static JSX to template cloning', () => {
    const code = `
      export function Counter() {
        return (
          <div class="counter">
            <h1>Count</h1>
            <button>Increment</button>
          </div>
        )
      }
    `
    const output = compile(code)

    // Expected Output Structure (approximate):
    // const _tmpl$ = _$template(`<div class="counter"><h1>Count</h1><button>Increment</button></div>`);
    // ...
    // const _root = _tmpl$();

    expect(output).toContain(
      'template("<div class=\\"counter\\"><h1>Count</h1><button>Increment</button></div>")',
    )
    expect(output).toContain('tmpl$()')
  })

  it('handles dynamic text binding with template cloning', () => {
    const code = `
      import { $state } from 'fict'
      export function TextBinding() {
        const count = $state(0)
        return <div>Count: {count}</div>
      }
    `
    const output = compile(code)

    // Expect template to have a placeholder or split text?
    // For now, let's assume we split text or use a marker.
    // Ideally: <div>Count: <!----></div> or just <div>Count: </div> and we insert after.

    // Simplest first step:
    // const _tmpl$ = _$template(`<div>Count: </div>`);
    // ...
    // _$insert(_root, () => count.value)

    expect(output).toContain('template("<div>Count: <!----></div>")')
    expect(output).toContain('insert')
  })
})
