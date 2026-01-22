import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

const transformOptimized = (source: string) => transform(source, { optimize: true, dev: false })

// Snapshot updates:
// pnpm -C packages/compiler test -- optimizer-baseline.test.ts -u
describe('optimizer output baselines', () => {
  it('hook + derived accessors', () => {
    const source = `
      import { $state } from 'fict'

      export function useCounter() {
        let count = $state(0)
        const double = count * 2
        return { count, double }
      }

      export function View() {
        const { count, double } = useCounter()
        return <div>{count} / {double}</div>
      }
    `
    const output = transformOptimized(source)
    expect(output).toMatchSnapshot()
  })

  it('props destructuring + defaults', () => {
    const source = `
      function Card({ title, count = 0 }) {
        return <h1>{title} {count}</h1>
      }

      export default Card
    `
    const output = transformOptimized(source)
    expect(output).toMatchSnapshot()
  })

  it('region grouping across control flow', () => {
    const source = `
      import { $state } from 'fict'

      function Summary() {
        let count = $state(0)
        let heading
        let extra = 0
        if (count > 0) {
          const noun = count > 1 ? 'Items' : 'Item'
          heading = noun + ': ' + count
          extra = count * 10
        }
        return <div>{heading} {extra}</div>
      }
      export default Summary
    `
    const output = transformOptimized(source)
    expect(output).toMatchSnapshot()
  })

  it('keyed list rendering', () => {
    const source = `
      import { $state } from 'fict'

      function List() {
        let items = $state([{ id: 1, text: 'a' }, { id: 2, text: 'b' }])
        return (
          <ul>
            {items.map(item => (
              <li key={item.id}>{item.text}</li>
            ))}
          </ul>
        )
      }
      export default List
    `
    const output = transformOptimized(source)
    expect(output).toMatchSnapshot()
  })
})
