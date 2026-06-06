import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('destructured props generated name collisions', () => {
  it('renames generated props source params when the body declares __props', () => {
    const output = transform(
      `
        export function Child({ name }) {
          const __props = (globalThis as any).__fictPropsCollision ?? 'user'
          return <span>{__props}:{name}</span>
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toMatch(/function Child\(__props_1\)/)
    expect(output).toContain('const __props = globalThis.__fictPropsCollision ?? "user";')
    expect(output).toContain('prop(() => __props_1.name)')
  })

  it('renames generated default props params when the body declares __propsParam', () => {
    const output = transform(
      `
        export function Child({ name } = {}) {
          const __propsParam = (globalThis as any).__fictPropsParamCollision ?? 'user'
          return <span>{__propsParam}:{name}</span>
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toMatch(/function Child\(__propsParam_1\)/)
    expect(output).toContain('const __propsParam = globalThis.__fictPropsParamCollision ?? "user";')
    expect(output).toMatch(/const __props = __propsParam_1 === void 0 \? \{\} : __propsParam_1/)
    expect(output).toContain('prop(() => __props.name)')
  })

  it('renames generated props source params for rest props', () => {
    const output = transform(
      `
        export function Child({ name, ...rest }) {
          const __props = (globalThis as any).__fictPropsRestCollision ?? 'user'
          return <span>{__props}:{name}:{rest.title}</span>
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toMatch(/function Child\(__props_1\)/)
    expect(output).toContain('const __props = globalThis.__fictPropsRestCollision ?? "user";')
    expect(output).toContain('prop(() => __props_1.name)')
    expect(output).toMatch(/__fictPropsRest\(__props_1, \["name"\]\)/)
  })

  it('keeps default generated props names for unrelated nested-scope declarations', () => {
    const output = transform(
      `
        export function Child({ name }) {
          function readNested() {
            const __props = 'nested'
            return __props
          }
          return <span>{name}:{readNested()}</span>
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toMatch(/function Child\(__props\)/)
    expect(output).toContain('const __props = "nested";')
    expect(output).toContain('prop(() => __props.name)')
    expect(output).not.toMatch(/function Child\(__props_1\)/)
  })
})
