import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as runtimeInternal from '../../runtime/src/internal'

import { transformCommonJS, transformWithCompilerDefaults } from './test-utils'

interface HookScenario<T> {
  initial: unknown
  update: (value: T) => void
  updated: unknown
  read: (value: T) => unknown
}

interface CompiledHook<T> {
  context: { slots: unknown[]; cursor: number }
  value: T
}

function compileAndRunHook<T>(
  source: string,
  exportName: string,
  optimize: boolean,
): CompiledHook<T> {
  const output = transformCommonJS(source, {
    dev: false,
    emitModuleMetadata: false,
    optimize,
    strictGuarantee: false,
  })

  const module: { exports: Record<string, unknown> } = { exports: {} }
  const wrapped = new Function('require', 'module', 'exports', output)

  wrapped(
    (id: string) => {
      if (id === '@fictjs/runtime/internal' || id === 'fict/internal' || id === 'fict') {
        return runtimeInternal
      }
      if (id === '@fictjs/runtime/internal/list' || id === 'fict/internal/list') {
        return runtimeInternal
      }
      throw new Error(`Unexpected import in torture test: ${id}`)
    },
    module,
    module.exports,
  )

  const hook = module.exports[exportName]
  if (typeof hook !== 'function') {
    throw new Error(`Expected export ${exportName} to be a function`)
  }

  const context = { slots: [], cursor: 0 }
  const value = runtimeInternal.__fictRender(context, () => (hook as () => T)())
  return { context, value }
}

function readHook<T>(compiled: CompiledHook<T>, read: (value: T) => unknown): unknown {
  return runtimeInternal.__fictRender(compiled.context, () => read(compiled.value))
}

function expectOptimizedAndUnoptimized<T>(
  source: string,
  exportName: string,
  scenario: HookScenario<T>,
): void {
  const optimized = compileAndRunHook<T>(source, exportName, true)
  const unoptimized = compileAndRunHook<T>(source, exportName, false)

  expect(readHook(optimized, scenario.read)).toBe(scenario.initial)
  expect(readHook(unoptimized, scenario.read)).toBe(scenario.initial)

  scenario.update(optimized.value)
  scenario.update(unoptimized.value)

  expect(readHook(optimized, scenario.read)).toBe(scenario.updated)
  expect(readHook(unoptimized, scenario.read)).toBe(scenario.updated)
}

describe('reactivity torture corpus', () => {
  beforeEach(() => {
    runtimeInternal.__fictResetContext()
  })

  afterEach(() => {
    runtimeInternal.__fictResetContext()
  })

  it('preserves destructuring, loop, and continue semantics across optimizer modes', () => {
    const source = `
      import { $state } from 'fict'

      export function useRun() {
        let mode = $state(0)
        const cells = mode === 0
          ? [{ index: 0, cell: 2 }]
          : [{ index: 0, cell: 2 }, { index: 1, cell: 3 }]
        let seen = ''

        for (const entry of cells) {
          const { index: offset, cell: currentCell } = entry
          if (currentCell === 2) {
            continue
          }
          seen += offset + ':' + currentCell + ':' + mode
        }

        return {
          toggle() {
            mode = 1
          },
          view() {
            return seen
          },
        }
      }
    `

    expectOptimizedAndUnoptimized<{ toggle: () => void; view: () => string }>(source, 'useRun', {
      initial: '',
      updated: '1:3:1',
      update: value => value.toggle(),
      read: value => value.view(),
    })
  })

  it('preserves destructuring aliases through nested branch and loop regions', () => {
    const source = `
      import { $state } from 'fict'

      export function useRun() {
        let mode = $state(0)
        let count = $state(1)
        const records = mode === 0
          ? [{ id: 'a', value: count }]
          : [{ id: 'a', value: count }, { id: 'b', value: count + 1 }]
        let label = ''

        for (const record of records) {
          const { id: currentId, value } = record
          if (currentId === 'a' && mode === 0) {
            label = currentId + ':' + value
            continue
          }
          if (currentId === 'b') {
            label = currentId + ':' + value
          }
        }

        return {
          next() {
            mode = 1
            count++
          },
          view() {
            return label
          },
        }
      }
    `

    expectOptimizedAndUnoptimized<{ next: () => void; view: () => string }>(source, 'useRun', {
      initial: 'a:1',
      updated: 'b:3',
      update: value => value.next(),
      read: value => value.view(),
    })
  })

  it('keeps unknown callback escape in the fail-closed surface', () => {
    expect(() =>
      transformWithCompilerDefaults(`
        import { $state } from 'fict'

        function runLater(callbacks) {
          return callbacks.read
        }

        export function App() {
          let count = $state(0)
          const callbacks = { ...{ read: () => count } }
          runLater(callbacks)
          return <div>{count}</div>
        }
      `),
    ).toThrow(/FICT-R002|FICT-R005/)
  })

  it('keeps dynamic property reads in the fail-closed surface', () => {
    expect(() =>
      transformWithCompilerDefaults(`
        import { $state } from 'fict'

        export function App({ field = 'name' }) {
          let user = $state({ name: 'Ada', city: 'London' })
          const bag = { ...user }
          return <div>{bag[field]}</div>
        }
      `),
    ).toThrow(/FICT-H/)
  })
})
