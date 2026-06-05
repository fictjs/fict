import { describe, expect, it } from 'vitest'

import { transformCommonJS } from './test-utils'

function compileModule(source: string): Record<string, unknown> {
  const output = transformCommonJS(source, {
    dev: false,
    emitModuleMetadata: false,
    fineGrainedDom: false,
    optimize: true,
    strictGuarantee: false,
  })

  const module: { exports: Record<string, unknown> } = { exports: {} }
  const wrapped = new Function('require', 'module', 'exports', output)
  wrapped(
    (id: string) => {
      throw new Error(`Unexpected import in vnode props order test: ${id}`)
    },
    module,
    module.exports,
  )
  return module.exports
}

const probeProps = (source: string) => {
  const exports = compileModule(source)
  const vnode = (exports.probe as () => { props: Record<string, unknown> })()
  return vnode.props
}

describe('VNode fallback prop order', () => {
  it('lets later spreads override earlier explicit props', () => {
    const props = probeProps(`
      export function probe() {
        const spread = { id: 'spread' }
        return <div id="before" {...spread} />
      }
    `)

    expect(props.id).toBe('spread')
  })

  it('lets later explicit props override earlier spreads', () => {
    const props = probeProps(`
      export function probe() {
        const spread = { id: 'spread' }
        return <div {...spread} id="after" />
      }
    `)

    expect(props.id).toBe('after')
  })

  it('preserves order across multiple spreads and explicit props', () => {
    const props = probeProps(`
      export function probe() {
        const first = { id: 'first', class: 'first' }
        const second = { id: 'second' }
        return <div id="start" {...first} class="explicit" {...second} />
      }
    `)

    expect(props.id).toBe('second')
    expect(props.class).toBe('explicit')
  })

  it('lets explicit JSX children override spread children', () => {
    const props = probeProps(`
      export function probe() {
        const spread = { children: 'spread' }
        return <div {...spread}>child</div>
      }
    `)

    expect(props.children).toBe('child')
  })

  it('preserves prop order inside use no memo functions', () => {
    const props = probeProps(`
      export function probe() {
        "use no memo"
        const spread = { id: 'spread' }
        return <div id="before" {...spread} />
      }
    `)

    expect(props.id).toBe('spread')
  })
})
