import { describe, expect, it } from 'vitest'

import type { FictCompilerOptions } from '../src'

import { transform } from './test-utils'

function compileForSnapshot(
  source: string,
  options: FictCompilerOptions = {},
  filename = 'snapshot.tsx',
): string {
  return transform(
    source,
    {
      dev: false,
      emitModuleMetadata: false,
      strictGuarantee: false,
      ...options,
    },
    filename,
  )
}

describe('compiler output golden snapshots', () => {
  it('stabilizes reactive prop getter marker output', () => {
    const output = compileForSnapshot(`
      import { $state } from 'fict'

      export function Parent() {
        let count = $state(0)
        const doubled = count * 2
        return <Child value={doubled} />
      }

      function Child(props) {
        return <span>{props.value}</span>
      }
    `)

    expect(output).toMatchSnapshot()
  })

  it('stabilizes control-flow fallback output shape', () => {
    const output = compileForSnapshot(`
      import { $state } from 'fict'

      export function Branch() {
        let count = $state(0)
        if (count > 1) {
          return <button onClick={() => count++}>High {count}</button>
        }
        return <button onClick={() => count++}>Low {count}</button>
      }
    `)

    expect(output).toMatchSnapshot()
  })

  it('stabilizes cross-module direct accessor metadata output', () => {
    const output = compileForSnapshot(
      `
        import { useCounter } from 'counter-lib'

        export function App() {
          const count = useCounter()
          return <div>{count}</div>
        }
      `,
      {
        resolveModuleMetadata: source =>
          source === 'counter-lib'
            ? {
                version: 1,
                exports: {},
                hooks: {
                  useCounter: { directAccessor: 'signal' },
                },
              }
            : undefined,
      },
      'metadata-consumer.tsx',
    )

    expect(output).toMatchSnapshot()
  })
})
