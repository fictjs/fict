import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('runtime import detection', () => {
  it('ignores type-only runtime imports', () => {
    const output = transform(`
      import type { createSignal } from 'fict'

      export function App() {
        const foo = createSignal(0)
        return <div>{foo}</div>
      }
    `)

    expect(output).not.toMatch(/foo\\(\\)/)
  })
})
