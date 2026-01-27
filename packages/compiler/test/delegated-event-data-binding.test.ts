import { describe, expect, it } from 'vitest'
import { transform } from './test-utils'

describe('Delegated event data binding', () => {
  it('extracts data binding for handler(data) pattern', () => {
    const source = `
      export function App() {
        const handleClick = function (id) {
          return id
        }
        return <button onClick={() => handleClick(1)}>Click</button>
      }
    `
    const output = transform(source)

    expect(output).toContain('$$clickData')
    expect(output).toMatch(/\$\$click\s*=\s*\(__data, _e\)\s*=>\s*handleClick\(__data\)/)
  })
})
