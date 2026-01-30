import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('semantic regressions', () => {
  it('preserves large numeric string property access', () => {
    const output = transform(`
      function App(props) {
        return <div>{props['9007199254740993']}</div>
      }
    `)

    expect(output).toMatch(/\["9007199254740993"\]/)
  })
})
