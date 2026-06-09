import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

const regionCollisionLocals = Array.from(
  { length: 24 },
  (_, index) => `const __region_${index} = (globalThis as any).__fictRegion${index} ?? 'r${index}'`,
).join('\n')

const regionCollisionRead = Array.from({ length: 24 }, (_, index) => `__region_${index}`).join(
  ` + '|' + `,
)

function generatedRegionMemos(output: string): string[] {
  return Array.from(output.matchAll(/const (__region_\d+) = __fictUseMemo/g), match => match[1]!)
}

function expectNonCollidingRegionMemo(output: string): string {
  const regionName = generatedRegionMemos(output).find(name => {
    const index = Number(name.replace('__region_', ''))
    return Number.isInteger(index) && index >= 24
  })
  expect(regionName).toBeTruthy()
  return regionName as string
}

describe('region memo generated name collisions', () => {
  it('renames region memo controllers when source locals use region names', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        export function App() {
          ${regionCollisionLocals}
          let count = $state(1)
          const doubled = count * 2
          const tripled = count * 3
          const userRegions = ${regionCollisionRead}
          return <span>{userRegions}:{doubled}:{tripled}</span>
        }
      `,
      { dev: false, optimize: true, lazyConditional: true },
    )

    const regionName = expectNonCollidingRegionMemo(output)
    expect(output).toContain(`} = ${regionName}();`)
    expect(output).toContain('const __region_0 = globalThis.__fictRegion0 ?? "r0";')
  })

  it('renames conditional-derived region controllers when source locals use region names', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        export function App() {
          ${regionCollisionLocals}
          let show = $state(false)
          let count = $state(1)
          const fallback = count + 1
          const rich = count * 10
          const chosen = show ? rich : fallback
          const userRegions = ${regionCollisionRead}

          return (
            <section data-user={userRegions}>
              <span>{chosen}</span>
            </section>
          )
        }
      `,
      { dev: false, optimize: true, lazyConditional: true },
    )

    const regionName = expectNonCollidingRegionMemo(output)
    expect(output).toContain(`const {`)
    expect(output).toContain(`} = ${regionName}();`)
    expect(output).toContain('show() ? rich() : fallback()')
    expect(output).toContain('const __region_0 = globalThis.__fictRegion0 ?? "r0";')
  })

  it('keeps default region memo names for unrelated nested-scope declarations', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        export function App() {
          function readNested() {
            const __region_0 = 'nested'
            return __region_0
          }
          let count = $state(1)
          const doubled = count * 2
          const tripled = count * 3
          return <span>{readNested()}:{doubled}:{tripled}</span>
        }
      `,
      { dev: false, optimize: true, lazyConditional: true },
    )

    expect(output).toMatch(/const __region_\d+ = __fictUseMemo/)
    expect(generatedRegionMemos(output).length).toBeGreaterThan(0)
    expect(output).not.toMatch(/const __region_\d+_1 = __fictUseMemo/)
  })
})
