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
      /addEventListener\([^,]+,\s*"click",\s*\[handleClick,\s*1,\s*"__fictDataOnlyPlain"\],\s*true\)/,
    )
  })

  it('does not extract data binding for reassigned handlers', () => {
    const source = `
      export function App() {
        let handleClick = function (id) {
          return id
        }
        handleClick = function (id) {
          return id + 1
        }
        return <button onClick={() => handleClick(1)}>Click</button>
      }
    `
    const output = transform(source)

    expect(output).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(output).toContain('handleClick(1)')
    expect(output).not.toMatch(/addEventListener\([^,]+,\s*"click",\s*\[handleClick,\s*1/)
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

  it.each([
    ['sequence expression', 'select((0, event.type))'],
    ['new expression', 'select(new Box(event.type))'],
    ['assignment expression', 'select((last = event.type))'],
    ['tagged template expression', 'select(tag`${event.type}`)'],
  ])('does not extract data that reads the event param through %s', (_name, expression) => {
    const source = `
      export function App() {
        let last = ''
        function Box(value) {
          this.value = value
        }
        function tag(strings, value) {
          return strings[0] + value
        }
        function select(value) {
          last = String(value)
        }
        return <button onClick={(event) => ${expression}}>Click</button>
      }
    `
    const output = transform(source)

    expect(output).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(output).not.toContain('__fictDataOnly')
    expect(output).not.toMatch(/addEventListener\([^,]+,\s*"click",\s*\[select,/)
  })

  it.each([
    ['arrow closure', 'select(() => event.type)'],
    ['function closure', 'select(function read() { return event.type })'],
    ['object closure property', 'select({ read: () => event.type })'],
    ['object method closure', 'select({ read() { return event.type } })'],
    ['array closure element', 'select([() => event.type])'],
    ['iife returned closure', 'select((() => () => event.type)())'],
  ])('does not extract data that captures the event param through %s', (_name, expression) => {
    const source = `
      export function App() {
        function select(value) {
          return value
        }
        return <button onClick={(event) => ${expression}}>Click</button>
      }
    `
    const output = transform(source)

    expect(output).toMatch(/addEventListener\([^,]+,\s*"click",/)
    expect(output).not.toContain('__fictDataOnly')
    expect(output).not.toMatch(/addEventListener\([^,]+,\s*"click",\s*\[select,/)
  })

  it('still extracts closure data when it does not capture the event param', () => {
    const source = `
      export function App() {
        const label = 'safe'
        function select(read) {
          return read()
        }
        return <button onClick={(event) => select(() => label)}>Click</button>
      }
    `
    const output = transform(source)

    expect(output).toMatch(/addEventListener\([^,]+,\s*"click",\s*\[select,/)
    expect(output).toContain('__fictDataOnly')
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
