import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('dynamic key props wrapping', () => {
  it('wraps computed props when key is reactive even if object is plain', () => {
    const output = transform(`
      import { $state } from 'fict'
      function Parent() {
        const key = $state('a')
        const obj = { a: 1, b: 2 }
        return <Child value={obj[key]} />
      }
    `)

    expect(output).toContain('keyed(')
    expect(output).toMatch(/keyed\(obj,\s*\(\)\s*=>\s*key\(\)\)/)
  })
})
