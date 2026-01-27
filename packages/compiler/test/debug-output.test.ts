import { describe, it } from 'vitest'
import { transform } from './test-utils'

describe('debug output', () => {
  it('shows compiled control flow', () => {
    const source = `
      import { $state, $effect, render } from 'fict'

      function Counter() {
        let count = $state(0)
        let count1 = $state(0)
        const doubled = count * 2
        $effect(() => {
          document.title = \`Count: \${count}\`
        })
        if (!(count % 2)) {
          console.log('test')
          return (
            <>
              <button onClick={() => count++} data-testid="count">
                Count: {count} is divisible by 2, doubled: {doubled}
              </button>
              <button onClick={() => count1++} data-testid="count1">
                Count1: {count1}
              </button>
            </>
          )
        }
        console.log('test1')
        return (
          <>
            <button onClick={() => count++} data-testid="count">
              Count: {count} is not divisible by 2, count1: {doubled}
            </button>
            <button onClick={() => count1++} data-testid="count1">
              Count1: {count1}
            </button>
          </>
        )
      }

      export function mount(el) {
        return render(() => <Counter />, el)
      }
    `

    const output = transform(source)
    console.log('=== COMPILED OUTPUT ===')
    console.log(output)
    console.log('=== END OUTPUT ===')
  })
})
