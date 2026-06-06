import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('scope analysis excludes $store macro callee', () => {
  it('does not treat $store as a dependency read', () => {
    const output = transform(`
      import { $store } from 'fict/plus'
      function Component() {
        const store = $store({ x: 1 })
        return store.x
      }
    `)

    // If $store were treated as a read dependency, we might see extra memoization on the call.
    // We only care that the transform succeeds and does not wrap the $store callee in memo.
    expect(output).toContain(`const store = $store`)
    expect(output).not.toContain(`__fictUseMemo(__fictCtx, () => $store`)
  })

  it('does not memo-wrap store initializers that read state', () => {
    const cases = [
      {
        name: 'direct store',
        importSource: "import { $state, $store } from 'fict'",
        declaration: 'const box = $store({ value: count })',
      },
      {
        name: 'aliased store',
        importSource: "import { $state, $store as store } from 'fict'",
        declaration: 'const box = store({ value: count })',
      },
      {
        name: 'computed key',
        importSource: "import { $state, $store } from 'fict'",
        declaration: 'const box = $store({ [count]: 1, value: count })',
      },
      {
        name: 'nested value',
        importSource: "import { $state, $store } from 'fict'",
        declaration: 'const box = $store({ nested: { value: count }, value: count })',
      },
      {
        name: 'sequence store',
        importSource: "import { $state, $store } from 'fict'",
        declaration: 'const box = (0, $store)({ value: count })',
      },
      {
        name: 'namespace store',
        importSource: "import { $state } from 'fict'; import * as Fict from 'fict'",
        declaration: 'const box = Fict.$store({ value: count })',
      },
    ]

    for (const testCase of cases) {
      const warnings: string[] = []
      const output = transform(
        `
          ${testCase.importSource}

          export function App() {
            const count = $state(1)
            ${testCase.declaration}
            return <span>{box.value}</span>
          }
        `,
        {
          onWarn: warning => warnings.push(warning.code),
        },
      )

      expect(output, testCase.name).toContain('const box = ')
      expect(output, testCase.name).not.toMatch(/const box = __fictUseMemo\(__fictCtx,\s*\(\) =>/)
      expect(output, testCase.name).toMatch(/box\.value/)
      expect(output, testCase.name).not.toMatch(/box\(\)\.value/)
      expect(warnings, testCase.name).not.toContain('FICT-R002')
    }
  })

  it('does not escalate reactive store initializer arguments in strict guarantee mode', () => {
    expect(() =>
      transform(
        `
          import { $state, $store } from 'fict'

          export function App() {
            const count = $state(1)
            const box = $store({ value: count })
            return <span>{box.value}</span>
          }
        `,
        { strictGuarantee: true, dev: false },
      ),
    ).not.toThrow(/FICT-R002/)
  })
})
