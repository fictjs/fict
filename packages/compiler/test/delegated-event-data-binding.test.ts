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

    expect(output).toMatch(
      /addEventListener\([^,]+,\s*"click",\s*\[handleClick,\s*1,\s*"__fictDataOnly"\],\s*true\)/,
    )
  })

  it('preserves explicit delegated event handler tuples', () => {
    const source = `
      export function App() {
        const handleClick = function (data, event) {
          return data + event.type
        }
        return <button onClick={[handleClick, 123]}>Click</button>
      }
    `
    const output = transform(source)

    expect(output).toMatch(/addEventListener\([^,]+,\s*"click",\s*\[handleClick,\s*123\],\s*true\)/)
    expect(output).not.toContain('.call(this')
  })

  it('wraps reactive explicit delegated event tuple data in a getter', () => {
    const source = `
      import { $state } from 'fict'

      export function App() {
        const id = $state(1)
        const handleClick = function (data, event) {
          return data + event.type
        }
        return <button onClick={[handleClick, id]}>Click</button>
      }
    `
    const output = transform(source)

    expect(output).toMatch(/addEventListener\([^,]+,\s*"click",\s*\[handleClick,\s*__fictReactive/)
    expect(output).toContain('() => id()')
    expect(output).not.toContain('[handleClick, id]')
    expect(output).not.toContain('.call(this')
  })

  it('preserves explicit event tuples on non-delegated option paths', () => {
    const source = `
      export function App() {
        const handleClick = function (data, event) {
          return data + event.type
        }
        return <button onClickCapture={[handleClick, 123]}>Click</button>
      }
    `
    const output = transform(source)

    expect(output).toMatch(/bindEvent\([^,]+,\s*"click",\s*\[handleClick,\s*123\]/)
    expect(output).toContain('capture: true')
    expect(output).not.toContain('.call(this')
  })

  it('passes delegated $state handler accessors to the runtime', () => {
    const source = `
      import { $state } from 'fict'

      export function App() {
        const handler = $state((event) => event.type)
        return <button onClick={handler}>Click</button>
      }
    `
    const output = transform(source)

    expect(output).toMatch(/addEventListener\([^,]+,\s*"click",\s*handler,\s*true\)/)
    expect(output).not.toContain('handler.call(this')
  })

  it('keeps delegated $state handler accessors swappable', () => {
    const source = `
      import { $state } from 'fict'

      export function App() {
        const first = (event) => event.type
        const second = (event) => event.currentTarget
        const handler = $state(first)
        return (
          <>
            <button onClick={handler}>Click</button>
            <button onClick={() => handler(second)}>Swap</button>
          </>
        )
      }
    `
    const output = transform(source)

    expect(output).toMatch(/addEventListener\([^,]+,\s*"click",\s*handler,\s*true\)/)
    expect(output).not.toContain('handler.call(this')
  })
})
