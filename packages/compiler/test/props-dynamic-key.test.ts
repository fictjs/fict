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

  it('keeps computed component spread keys reactive', () => {
    const output = transform(`
      import { $state } from 'fict'
      function Parent() {
        let key = $state('a')
        let value = $state('A')
        return <Child {...{ [key]: value }} k={key} />
      }
    `)

    expect(output).toContain('mergeProps')
    expect(output).toMatch(/__fictProp\(\(\) => \(\{\s*\[key\(\)\]/)
    expect(output).toMatch(/k:\s*__fictProp\(\(\) => key\(\)\)/)
  })
})
