import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { clearModuleMetadata, type FictCompilerOptions } from '../src/index'
import { transform } from './test-utils'

describe('Cross-Module Reactivity', () => {
  const baseDir = path.join(process.cwd(), '__fict_cross_module__')

  describe('Store Module (Exports)', () => {
    it('rejects exporting module-level state', () => {
      const source = `
        import { $state } from 'fict'
        export let count = $state(0)
      `
      expect(() => transform(source)).toThrow(
        'must be declared inside a component or hook function body',
      )
    })

    it('rejects exporting module-level derived value', () => {
      const source = `
        import { $state } from 'fict'
        const count = $state(0)
        export const double = count * 2
      `
      expect(() => transform(source)).toThrow(
        'must be declared inside a component or hook function body',
      )
    })

    it('re-exports state (valid JS) is untouched', () => {
      const source = `
        export { count } from './store'
      `
      const output = transform(source)
      // Compiler should touch this, it's just value re-export
      expect(output).toContain("export { count } from './store'")
    })

    it('re-exports alias without creating new signal', () => {
      const source = `
        import { count } from './store'
        export const alias = count
        export { alias as total }
      `
      const output = transform(source)
      expect(output).toContain('export let alias = count')
      expect(output).toContain('export { alias as total }')
      // ensure no signal/memo is created for alias
      expect(output).not.toMatch(/__fictUseSignal\(|__fictUseMemo\(/)
    })

    it('publishes namespace $store calls as store metadata', () => {
      const source = `
        import * as F from 'fict'
        export const user = F.$store({ name: 'Ada' })
      `
      const moduleMetadata = new Map()
      const storePath = path.join(baseDir, 'namespace-store.ts')

      transform(source, { moduleMetadata }, storePath)

      expect(moduleMetadata.get(path.resolve(storePath))?.exports).toEqual({
        user: 'store',
      })
    })
  })

  describe('Component Module (Imports)', () => {
    it('compiles component using imported signal as function call', () => {
      const source = `
        import { count } from './store'
        export function App() {
          return <div>{count()}</div>
        }
      `
      const output = transform(source, { fineGrainedDom: true })

      // The call should flow through unchanged and be bound reactively.
      // We now treat call expressions as dynamic children (not plain text) to avoid
      // misclassifying helpers that return arrays/JSX. Verify the insert path.
      expect(output).toContain('insert')
      expect(output).toMatch(/count\(\)/)
    })

    it('keeps resumable handlers using imported accessors at module scope', () => {
      const moduleMetadata = new Map()
      const storePath = path.join(baseDir, 'resumable-store.ts')
      const appPath = path.join(baseDir, 'app-resumable-imported-accessors.tsx')
      moduleMetadata.set(path.resolve(storePath), {
        exports: {
          default: 'signal',
          count: 'signal',
          total: 'memo',
          user: 'store',
        },
      })

      const output = transform(
        `
          import defaultCount, { count, total, user } from './resumable-store'

          export function App() {
            return (
              <button onClick$={() => {
                count(count() + 1)
                defaultCount(defaultCount() + 1)
                console.log(total(), user.name)
              }}>
                Increment
              </button>
            )
          }
        `,
        { resumable: true, moduleMetadata },
        appPath,
      )

      expect(output).toContain('setAttribute("on:click"')
      expect(output).not.toContain('useLexicalScope')
      expect(output).toContain('count(count() + 1)')
      expect(output).toContain('defaultCount(defaultCount() + 1)')
    })

    it('keeps local signal shadows restorable in resumable handlers', () => {
      const moduleMetadata = new Map()
      const storePath = path.join(baseDir, 'resumable-shadow-store.ts')
      const appPath = path.join(baseDir, 'app-resumable-shadow.tsx')
      moduleMetadata.set(path.resolve(storePath), {
        exports: {
          count: 'signal',
        },
      })

      const output = transform(
        `
          import { count } from './resumable-shadow-store'
          import { $state } from 'fict'

          export function App() {
            const count = $state(0)
            return <button onClick$={() => count(count() + 1)}>Increment</button>
          }
        `,
        { resumable: true, moduleMetadata },
        appPath,
      )

      expect(output).toContain('setAttribute("on:click"')
      expect(output).toContain('__fictUseLexicalScope(scopeId, ["count"])')
    })

    it('keeps namespace imported accessors out of resumable lexical scope', () => {
      const moduleMetadata = new Map()
      const storePath = path.join(baseDir, 'resumable-namespace-store.ts')
      const appPath = path.join(baseDir, 'app-resumable-namespace.tsx')
      moduleMetadata.set(path.resolve(storePath), {
        exports: {
          count: 'signal',
        },
      })

      const output = transform(
        `
          import * as store from './resumable-namespace-store'

          export function App() {
            return <button onClick$={() => store.count(store.count() + 1)}>Increment</button>
          }
        `,
        { resumable: true, moduleMetadata },
        appPath,
      )

      expect(output).toContain('setAttribute("on:click"')
      expect(output).not.toContain('useLexicalScope')
      expect(output).toContain('store.count(store.count() + 1)')
    })

    it('compiles usage of imported symbol in effect', () => {
      const source = `
        import { $effect } from 'fict'
        import { count } from './store'

        $effect(() => {
          console.log(count())
        })
      `
      const output = transform(source)
      // Should compile effect correctly
      expect(output).toContain('createEffect(() => {')
      expect(output).toContain('console.log(count())')
    })

    it('propagates hook return metadata across modules', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { directAccessor: "signal" } */
        export function useCounter() {
          const count = $state(0)
          return count
        }
      `
      const appSource = `
        import { useCounter } from './use-counter'

        export function App() {
          const count = useCounter()
          return <div>{count}</div>
        }
      `

      const moduleMetadata = new Map()
      transform(hookSource, { moduleMetadata }, path.join(baseDir, 'use-counter.tsx'))
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app.tsx'),
      )

      expect(output).toMatch(/count\(\)/)
    })

    it('propagates object-style direct accessor annotations for opaque hooks', () => {
      const hookSource = `
        import { readCount } from './external'

        /** @fictReturn { directAccessor: "signal" } */
        export function useCounter() {
          return readCount()
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-opaque'

        export function App() {
          const count = useCounter()
          return <div>{count}</div>
        }
      `

      const moduleMetadata = new Map()
      transform(hookSource, { moduleMetadata }, path.join(baseDir, 'use-counter-opaque.tsx'))

      expect(moduleMetadata.get(path.resolve(baseDir, 'use-counter-opaque.tsx'))?.hooks).toEqual({
        useCounter: { directAccessor: 'signal' },
      })

      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-opaque.tsx'),
      )

      expect(output).toMatch(/count\(\)/)
      expect(output).not.toMatch(/=> count[,)]/)
    })

    it('does not treat lowercase non-use utilities as hooks', () => {
      const localPath = path.join(baseDir, 'app-utility-local.tsx')
      const localSource = `
        function utility() {
          return { label: 'ok' }
        }

        export function App() {
          const value = utility()
          return <div>{value.label}</div>
        }
      `

      const localOutput = transform(localSource, { fineGrainedDom: true }, localPath)

      expect(localOutput).toMatch(/value\.label/)
      expect(localOutput).not.toMatch(/value\.label\(\)/)

      const importedPath = path.join(baseDir, 'app-utility-imported.tsx')
      const importedSource = `
        import { utility } from './lib'

        export function App() {
          const value = utility()
          return <div>{value.label}</div>
        }
      `

      const importedOutput = transform(importedSource, { fineGrainedDom: true }, importedPath)

      expect(importedOutput).toMatch(/value\.label/)
      expect(importedOutput).not.toMatch(/value\.label\(\)/)

      const hookPath = path.join(baseDir, 'hook-use-counter.tsx')
      const hookConsumerPath = path.join(baseDir, 'app-use-counter.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(hookPath), {
        version: 1,
        exports: {},
        hooks: {
          useCounter: { objectProps: { count: 'signal' } },
        },
      })
      const hookConsumerSource = `
        import { useCounter } from './hook-use-counter'

        export function App() {
          const value = useCounter()
          return <div>{value.count}</div>
        }
      `

      const hookOutput = transform(
        hookConsumerSource,
        { fineGrainedDom: true, moduleMetadata },
        hookConsumerPath,
      )

      expect(hookOutput).toMatch(/value\.count\(\)/)
    })

    it('unwraps optional hook-return signal member reads across modules', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-optional-member'

        export function App() {
          const state = useCounter()
          return state?.count
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-optional-member.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-optional-member.tsx'),
      )

      expect(output).toMatch(/return state\?\.count\?\.\(\)/)
      expect(output).not.toContain('return state?.count;')
    })

    it('unwraps optional computed hook-return signal member reads across modules', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-optional-computed-member'

        export function App() {
          const state = useCounter()
          return state?.['count']
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-optional-computed-member.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-optional-computed-member.tsx'),
      )

      expect(output).toMatch(/return state\?\.\["count"\]\?\.\(\)/)
      expect(output).not.toContain('return state?.["count"];')
    })

    it('unwraps direct hook-call signal member reads across modules', () => {
      const hookSource = `
        import { $state, $memo } from 'fict'

        /** @fictReturn { count: 'signal', doubled: 'memo' } */
        export function useCounter() {
          const count = $state(0)
          const doubled = $memo(() => count * 2)
          return { count, doubled }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-direct-member'

        export function App() {
          return useCounter().count
        }
      `
      const memoAppSource = `
        import { useCounter } from './use-counter-direct-member'

        export function App() {
          return useCounter().doubled
        }
      `

      const moduleMetadata = new Map()
      transform(hookSource, { moduleMetadata }, path.join(baseDir, 'use-counter-direct-member.tsx'))
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-direct-member.tsx'),
      )
      const memoOutput = transform(
        memoAppSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-direct-memo-member.tsx'),
      )

      expect(output).toContain('return useCounter().count();')
      expect(output).not.toContain('return useCounter().count;')
      expect(memoOutput).toContain('return useCounter().doubled();')
      expect(memoOutput).not.toContain('return useCounter().doubled;')
    })

    it('unwraps computed direct hook-call member reads across modules', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-direct-computed-member'

        export function App() {
          return useCounter()['count']
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-direct-computed-member.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-direct-computed-member.tsx'),
      )

      expect(output).toContain('return useCounter()["count"]();')
      expect(output).not.toContain('return useCounter()["count"];')
    })

    it('unwraps optional direct hook-call member reads across modules', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-direct-optional-member'

        export function App() {
          return useCounter()?.count
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-direct-optional-member.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-direct-optional-member.tsx'),
      )

      expect(output).toContain('return useCounter()?.count?.();')
      expect(output).not.toContain('return useCounter()?.count;')
    })

    it('tracks optional direct hook-call accessor returns across modules', () => {
      const hookPath = path.join(baseDir, 'use-counter-optional-direct.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(hookPath), {
        version: 1,
        exports: {},
        hooks: { useCounter: { directAccessor: 'signal' } },
      })
      const appSource = `
        import { useCounter } from './use-counter-optional-direct'

        export function App() {
          const count = useCounter?.()
          return <div>{count}</div>
        }
      `

      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-hook-optional-direct.tsx'),
      )

      expect(output).toMatch(/useCounter\?\.\(\)/)
      expect(output).toMatch(/count\(\)/)
      expect(output).not.toMatch(/=> count[,)]/)
    })

    it('keeps optional direct hook calls opaque without metadata', () => {
      const appSource = `
        import { useCounter } from './use-counter-optional-direct-missing'

        export function App() {
          const count = useCounter?.()
          return <div>{count}</div>
        }
      `

      const output = transform(
        appSource,
        { fineGrainedDom: true },
        path.join(baseDir, 'app-hook-optional-direct-missing.tsx'),
      )

      expect(output).toMatch(/useCounter\?\.\(\)/)
      expect(output).not.toMatch(/count\(\)/)
      expect(output).toMatch(/=> count[,)]/)
    })

    it('tracks optional namespace hook-call accessor returns across modules', () => {
      const hookPath = path.join(baseDir, 'use-counter-optional-namespace.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(hookPath), {
        version: 1,
        exports: {},
        hooks: { useCounter: { directAccessor: 'signal' } },
      })
      const appSource = `
        import * as hooks from './use-counter-optional-namespace'

        export function App() {
          const count = hooks.useCounter?.()
          return <div>{count}</div>
        }
      `

      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-hook-optional-namespace.tsx'),
      )

      expect(output).toMatch(/hooks\.useCounter\?\.\(\)/)
      expect(output).toMatch(/count\(\)/)
      expect(output).not.toMatch(/=> count[,)]/)
    })

    it('unwraps namespace direct hook-call member reads across modules', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import * as hooks from './use-counter-direct-namespace-member'

        export function App() {
          return hooks.useCounter().count
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-direct-namespace-member.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-direct-namespace-member.tsx'),
      )

      expect(output).toContain('return hooks.useCounter().count();')
      expect(output).not.toContain('return hooks.useCounter().count;')
    })

    it('unwraps default-import direct hook-call member reads across modules', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export default function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import useCounter from './use-counter-direct-default-member'

        export function App() {
          return useCounter().count
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-direct-default-member.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-direct-default-member.tsx'),
      )

      expect(output).toContain('return useCounter().count();')
      expect(output).not.toContain('return useCounter().count;')
    })

    it('routes direct hook-call member assignments through signal setters', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-direct-write'

        export function App() {
          useCounter().count = 2
          return useCounter().count
        }
      `

      const moduleMetadata = new Map()
      transform(hookSource, { moduleMetadata }, path.join(baseDir, 'use-counter-direct-write.tsx'))
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-direct-write.tsx'),
      )

      expect(output).toMatch(/\(__hook_\d+ => __hook_\d+\.count\(2\)\)\(useCounter\(\)\)/)
      expect(output).toContain('return useCounter().count();')
      expect(output).not.toContain('useCounter().count = 2')
    })

    it('evaluates direct hook-call compound assignment targets once', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-direct-compound-write'

        export function App() {
          useCounter().count += 2
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-direct-compound-write.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-direct-compound-write.tsx'),
      )

      expect(output).toContain('useCounter()')
      expect(output).toContain('.count(__')
      expect(output).toContain('.count() + 2')
      expect(output.match(/useCounter\(\)/g)).toHaveLength(1)
      expect(output).not.toContain('useCounter().count += 2')
    })

    it('evaluates computed direct hook-call assignment targets once', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-direct-computed-write'

        export function App() {
          const key = 'count'
          useCounter()[key] += 2
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-direct-computed-write.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-direct-computed-write.tsx'),
      )

      expect(output).toContain('=== "count"')
      expect(output).toContain('() + 2')
      expect(output.match(/useCounter\(\)/g)).toHaveLength(1)
      expect(output).not.toContain('useCounter()[key] += 2')
    })

    it('evaluates direct hook-call update targets once', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-direct-update'

        export function App() {
          return useCounter().count++
        }
      `

      const moduleMetadata = new Map()
      transform(hookSource, { moduleMetadata }, path.join(baseDir, 'use-counter-direct-update.tsx'))
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-direct-update.tsx'),
      )

      expect(output).toContain('useCounter()')
      expect(output).toContain('.count()')
      expect(output).toContain('.count(__prev_')
      expect(output.match(/useCounter\(\)/g)).toHaveLength(1)
      expect(output).not.toContain('useCounter().count++')
    })

    it('routes namespace direct hook-call member updates through signal setters', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import * as hooks from './use-counter-direct-namespace-update'

        export function App() {
          hooks.useCounter().count--
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-direct-namespace-update.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-direct-namespace-update.tsx'),
      )

      expect(output).toContain('hooks.useCounter()')
      expect(output).toContain('.count(__prev_')
      expect(output.match(/hooks\.useCounter\(\)/g)).toHaveLength(1)
      expect(output).not.toContain('hooks.useCounter().count--')
    })

    it('routes default-import direct hook-call member assignments through signal setters', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export default function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import useCounter from './use-counter-direct-default-write'

        export function App() {
          useCounter().count = 3
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-direct-default-write.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-direct-default-write.tsx'),
      )

      expect(output).toMatch(/\(__hook_\d+ => __hook_\d+\.count\(3\)\)\(useCounter\(\)\)/)
      expect(output).not.toContain('useCounter().count = 3')
    })

    it('preserves hook-return object destructuring aliases', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-destructure-object'

        export function App() {
          const { count } = useCounter()
          return count
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-destructure-object.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-destructure-object.tsx'),
      )

      expect(output).toContain('return count();')
      expect(output).not.toContain('return count;')
    })

    it('preserves aliased hook-return object destructuring aliases', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-destructure-alias'

        export function App() {
          const { count: c } = useCounter()
          return c
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-destructure-alias.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-destructure-alias.tsx'),
      )

      expect(output).toContain('return c();')
      expect(output).not.toContain('return c;')
    })

    it('preserves hook-return array destructuring aliases', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn [0: 'signal'] */
        export function useCounter() {
          const count = $state(0)
          return [count]
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-destructure-array'

        export function App() {
          const [count] = useCounter()
          return count
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-destructure-array.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-destructure-array.tsx'),
      )

      expect(output).toContain('return count();')
      expect(output).not.toContain('return count;')
    })

    it('reads hook result values for object rest destructuring', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count, label: 'ok' }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-destructure-rest'

        export function App() {
          const { count, ...rest } = useCounter()
          return rest.label
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-destructure-rest.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-destructure-rest.tsx'),
      )

      expect(output).toContain('__fictObjectRest')
      expect(output).toContain('["count"]')
    })

    it('preserves hook-return destructuring defaults', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-destructure-default-value'

        export function App() {
          const fallback = () => 1
          const { count = fallback } = useCounter()
          return count
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-destructure-default-value.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-destructure-default-value.tsx'),
      )

      expect(output).toContain('return count();')
      expect(output).not.toContain('return count;')
    })

    it('preserves hook-return array rest destructuring aliases', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn [0: 'signal'] */
        export function useCounter() {
          const count = $state(0)
          return [count, 'tail']
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-destructure-array-rest'

        export function App() {
          const [count, ...rest] = useCounter()
          return [count, rest.length]
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-destructure-array-rest.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-destructure-array-rest.tsx'),
      )

      expect(output).toContain('count()')
      expect(output).not.toContain('return [count,')
    })

    it('preserves namespace hook-return destructuring aliases', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import * as hooks from './use-counter-destructure-namespace'

        export function App() {
          const { count } = hooks.useCounter()
          return count
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-destructure-namespace.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-destructure-namespace.tsx'),
      )

      expect(output).toContain('return count();')
      expect(output).not.toContain('return count;')
    })

    it('preserves default-import hook-return destructuring aliases', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export default function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import useCounter from './use-counter-destructure-default'

        export function App() {
          const { count } = useCounter()
          return count
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-destructure-default.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-destructure-default.tsx'),
      )

      expect(output).toContain('return count();')
      expect(output).not.toContain('return count;')
    })

    it('propagates hook return metadata through pass-through wrapper modules', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { directAccessor: "signal" } */
        export function useCounter() {
          const count = $state(0)
          return count
        }
      `
      const wrapperSource = `
        import { useCounter } from './use-counter'

        export function useWrapped() {
          return useCounter()
        }
      `
      const appSource = `
        import { useWrapped } from './wrapper'

        export function App() {
          const count = useWrapped()
          return <div>{count}</div>
        }
      `

      const moduleMetadata = new Map()
      transform(hookSource, { moduleMetadata }, path.join(baseDir, 'use-counter.tsx'))
      transform(wrapperSource, { moduleMetadata }, path.join(baseDir, 'wrapper.tsx'))
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-wrapper.tsx'),
      )

      expect(output).toMatch(/count\(\)/)
    })

    it('propagates hook return metadata through namespace wrapper imports', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { directAccessor: "signal" } */
        export function useCounter() {
          const count = $state(0)
          return count
        }
      `
      const wrapperSource = `
        import { useCounter } from './use-counter'

        export function useWrapped() {
          return useCounter()
        }
      `
      const appSource = `
        import * as wrapper from './wrapper'

        export function App() {
          const count = wrapper.useWrapped()
          return <div>{count}</div>
        }
      `

      const moduleMetadata = new Map()
      transform(hookSource, { moduleMetadata }, path.join(baseDir, 'use-counter.tsx'))
      transform(wrapperSource, { moduleMetadata }, path.join(baseDir, 'wrapper.tsx'))
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-wrapper-ns.tsx'),
      )

      expect(output).toMatch(/count\(\)/)
    })

    it('propagates reactive export metadata through namespace re-exports', () => {
      const storeSource = `
        import { createSignal } from 'fict/advanced'
        export const count = createSignal(1)
      `
      const barrelSource = `
        export * as signals from './store-ns-reexport'
      `
      const appSource = `
        import { signals } from './barrel-ns-reexport'

        export function useProbe() {
          return signals.count + 1
        }
      `

      const moduleMetadata = new Map()
      transform(storeSource, { moduleMetadata }, path.join(baseDir, 'store-ns-reexport.ts'))
      transform(barrelSource, { moduleMetadata }, path.join(baseDir, 'barrel-ns-reexport.ts'))
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-ns-reexport.tsx'),
      )

      expect(output).toMatch(/signals\.count\(\) \+ 1/)
    })

    it('propagates hook return metadata through namespace re-exports', () => {
      const hookSource = `
        import { $state } from 'fict'

        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const barrelSource = `
        export * as hooks from './hooks-ns-reexport'
      `
      const appSource = `
        import { hooks } from './barrel-hooks-ns-reexport'

        export function App() {
          const state = hooks.useCounter()
          return <div>{state.count}</div>
        }
      `

      const moduleMetadata = new Map()
      transform(hookSource, { moduleMetadata }, path.join(baseDir, 'hooks-ns-reexport.tsx'))
      transform(barrelSource, { moduleMetadata }, path.join(baseDir, 'barrel-hooks-ns-reexport.ts'))
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-hooks-ns-reexport.tsx'),
      )

      expect(output).toMatch(/state\.count\(\)/)
    })

    it('omits ambiguous star-export metadata conflicts', () => {
      const aSource = `
        import { $state } from 'fict'
        import { createMemo, createSignal } from 'fict/advanced'

        export const count = createSignal(1)
        export const onlyA = createMemo(() => 1)

        export function useThing() {
          const value = $state(1)
          return { value }
        }

        export function useOnlyA() {
          const value = $state(1)
          return { value }
        }
      `
      const bSource = `
        import { $state } from 'fict'
        import { createMemo, createSignal } from 'fict/advanced'

        export const count = createMemo(() => 2)
        export const onlyB = createSignal(2)

        export function useThing() {
          const value = $state(2)
          return { value }
        }

        export function useOnlyB() {
          const value = $state(2)
          return { value }
        }
      `
      const barrelSource = `
        export * from './star-a'
        export * from './star-b'
      `
      const moduleMetadata = new Map()
      const aPath = path.join(baseDir, 'star-a.tsx')
      const bPath = path.join(baseDir, 'star-b.tsx')
      const barrelPath = path.join(baseDir, 'star-barrel.ts')

      transform(aSource, { moduleMetadata }, aPath)
      transform(bSource, { moduleMetadata }, bPath)
      transform(barrelSource, { moduleMetadata }, barrelPath)

      const meta = moduleMetadata.get(path.resolve(barrelPath))
      expect(meta?.exports).toEqual({
        onlyA: 'memo',
        onlyB: 'signal',
      })
      expect(meta?.hooks).toMatchObject({
        useOnlyA: { objectProps: { value: 'signal' } },
        useOnlyB: { objectProps: { value: 'signal' } },
      })
      expect(meta?.hooks).not.toHaveProperty('useThing')
      expect(meta?.exports).not.toHaveProperty('default')
    })

    it('lets explicit exports disambiguate star-export metadata regardless of order', () => {
      const localSource = `
        import { createMemo } from 'fict/advanced'
        export const count = createMemo(() => 1)
      `
      const starSource = `
        import { createSignal } from 'fict/advanced'
        export const count = createSignal(2)
      `
      const moduleMetadata = new Map()
      const localPath = path.join(baseDir, 'explicit-local.ts')
      const starPath = path.join(baseDir, 'explicit-star.ts')

      transform(localSource, { moduleMetadata }, localPath)
      transform(starSource, { moduleMetadata }, starPath)

      for (const [suffix, barrelSource] of [
        [
          'before',
          `
            export { count } from './explicit-local'
            export * from './explicit-star'
          `,
        ],
        [
          'after',
          `
            export * from './explicit-star'
            export { count } from './explicit-local'
          `,
        ],
      ] as const) {
        const barrelPath = path.join(baseDir, `explicit-barrel-${suffix}.ts`)
        transform(barrelSource, { moduleMetadata }, barrelPath)
        const meta = moduleMetadata.get(path.resolve(barrelPath))
        expect(meta?.exports.count).toBe('memo')
      }
    })

    it('clears star-export metadata when explicit local exports shadow it', () => {
      const sourcePath = path.join(baseDir, 'shadow-star-source.tsx')
      const plainBarrelPath = path.join(baseDir, 'shadow-star-plain-barrel.ts')
      const reactiveBarrelPath = path.join(baseDir, 'shadow-star-reactive-barrel.tsx')
      const moduleMetadata = new Map()
      const source = `
        import { $state } from 'fict'
        import { createSignal } from 'fict/advanced'

        export const value = createSignal(1)

        export function useCounter() {
          const count = $state(0)
          return count
        }

        export function useAlias() {
          const count = $state(1)
          return count
        }
      `
      const plainBarrel = `
        export * from './shadow-star-source'

        export const value = 123

        export function useCounter() {
          return 123
        }

        const useAlias = () => 123
        export { useAlias }
      `
      const reactiveBarrel = `
        import { $state } from 'fict'
        import { createMemo } from 'fict/advanced'

        export * from './shadow-star-source'

        export const value = createMemo(() => 2)

        export function useCounter() {
          const count = $state(2)
          return count
        }
      `

      transform(source, { moduleMetadata }, sourcePath)
      transform(plainBarrel, { moduleMetadata }, plainBarrelPath)
      transform(reactiveBarrel, { moduleMetadata }, reactiveBarrelPath)

      const plainMeta = moduleMetadata.get(path.resolve(plainBarrelPath))
      expect(plainMeta?.exports).toEqual({})
      expect(plainMeta?.hooks).toBeUndefined()

      const reactiveMeta = moduleMetadata.get(path.resolve(reactiveBarrelPath))
      expect(reactiveMeta?.exports).toEqual({ value: 'memo' })
      expect(reactiveMeta?.hooks).toMatchObject({
        useCounter: { directAccessor: 'signal' },
        useAlias: { directAccessor: 'signal' },
      })
    })

    it('propagates quoted source names in re-export metadata', () => {
      const sourcePath = path.join(baseDir, 'quoted-reexport-source.tsx')
      const barrelPath = path.join(baseDir, 'quoted-reexport-barrel.ts')
      const passthroughPath = path.join(baseDir, 'quoted-reexport-passthrough.ts')
      const moduleMetadata = new Map()
      const source = `
        import { $state } from 'fict'
        import { createMemo, createSignal } from 'fict/advanced'

        const count = createSignal(1)
        const doubled = createMemo(() => 2)

        export function useLocal() {
          const value = $state(0)
          return { value }
        }

        export { count as "weird-name", doubled as named, useLocal as "use-local" }
      `
      const barrel = `
        export { "weird-name" as normal, named as "odd-name", "use-local" as useQuoted } from './quoted-reexport-source'
      `
      const passthrough = `
        export { "weird-name" } from './quoted-reexport-source'
      `

      transform(source, { moduleMetadata }, sourcePath)
      transform(barrel, { moduleMetadata }, barrelPath)
      transform(passthrough, { moduleMetadata }, passthroughPath)

      expect(moduleMetadata.get(path.resolve(barrelPath))?.exports).toEqual({
        normal: 'signal',
        'odd-name': 'memo',
      })
      expect(moduleMetadata.get(path.resolve(barrelPath))?.hooks).toMatchObject({
        useQuoted: { objectProps: { value: 'signal' } },
      })
      expect(moduleMetadata.get(path.resolve(passthroughPath))?.exports).toEqual({
        'weird-name': 'signal',
      })
    })

    it('ignores type-only re-export declarations when propagating metadata', () => {
      const storeSource = `
        import { createSignal } from 'fict/advanced'
        export const count = createSignal(1)
        export type count = number
      `
      const barrelSource = `
        export type { count } from './store-type-reexport'
      `
      const appSource = `
        import { count } from './barrel-type-reexport'

        export function useProbe() {
          return count + 1
        }
      `

      const moduleMetadata = new Map()
      transform(storeSource, { moduleMetadata }, path.join(baseDir, 'store-type-reexport.ts'))
      transform(barrelSource, { moduleMetadata }, path.join(baseDir, 'barrel-type-reexport.ts'))
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-type-reexport.tsx'),
      )

      expect(output).toMatch(/return count \+ 1/)
      expect(output).not.toMatch(/count\(\)/)
    })

    it('ignores type-only re-export specifiers when propagating metadata', () => {
      const storeSource = `
        import { createSignal } from 'fict/advanced'
        export const count = createSignal(1)
        export type count = number
        export type Label = string
      `
      const barrelSource = `
        export { count as valueCount, type count as Count, type Label } from './store-type-specifier'
      `
      const appSource = `
        import { valueCount, Count } from './barrel-type-specifier'

        export function useProbe() {
          return valueCount + Count
        }
      `

      const moduleMetadata = new Map()
      transform(storeSource, { moduleMetadata }, path.join(baseDir, 'store-type-specifier.ts'))
      transform(barrelSource, { moduleMetadata }, path.join(baseDir, 'barrel-type-specifier.ts'))
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-type-specifier.tsx'),
      )

      expect(output).toMatch(/valueCount\(\) \+ Count/)
      expect(output).not.toMatch(/\bCount\(\)/)
    })

    it('ignores type-only imports when applying reactive metadata', () => {
      const storeSource = `
        import { createSignal } from 'fict/advanced'
        export const count = createSignal(1)
      `
      const appSource = `
        import type { count } from './store-type-import'

        export function useProbe() {
          return count + 1
        }
      `

      const moduleMetadata = new Map()
      transform(storeSource, { moduleMetadata }, path.join(baseDir, 'store-type-import.ts'))
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-type-import.tsx'),
      )

      expect(output).toMatch(/return count \+ 1/)
      expect(output).not.toMatch(/count\(\)/)
    })

    it('ignores type-only hook re-exports when propagating hook metadata', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { directAccessor: "signal" } */
        export function useCounter() {
          const count = $state(0)
          return count
        }
      `
      const barrelSource = `
        export type { useCounter } from './hook-type-reexport'
      `
      const appSource = `
        import { useCounter } from './barrel-hook-type-reexport'

        export function useProbe() {
          const count = useCounter()
          return count * 2
        }
      `

      const moduleMetadata = new Map()
      transform(hookSource, { moduleMetadata }, path.join(baseDir, 'hook-type-reexport.tsx'))
      transform(
        barrelSource,
        { moduleMetadata },
        path.join(baseDir, 'barrel-hook-type-reexport.ts'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-type-reexport.tsx'),
      )

      expect(output).toMatch(/return count \* 2/)
      expect(output).not.toMatch(/count\(\) \* 2/)
    })

    it('propagates createSignal exports from advanced modules (alias)', () => {
      const storeSource = `
        import { createSignal as makeSignal } from 'fict/advanced'
        export const count = makeSignal(0)
      `
      const appSource = `
        import { count } from './store-advanced'

        export function App() {
          return <div>{count()}</div>
        }
      `

      const moduleMetadata = new Map()
      transform(storeSource, { moduleMetadata }, path.join(baseDir, 'store-advanced.ts'))
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-advanced.tsx'),
      )

      expect(output).toMatch(/count\(\)/)
    })

    it('publishes imported reactive aliases as memo metadata', () => {
      const sourcePath = path.join(baseDir, 'reactive-source.ts')
      const producerPath = path.join(baseDir, 'reactive-alias-producer.ts')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(sourcePath), {
        version: 1,
        exports: {
          count: 'signal',
          doubled: 'memo',
          state: 'store',
        },
      })

      const producerSource = `
        import { count, doubled, state } from './reactive-source'

        const countAlias = count
        const memoAlias = doubled
        const storeAlias = state
        export const directAlias = count
        export { countAlias, memoAlias, storeAlias }
        export default countAlias
      `

      transform(producerSource, { moduleMetadata }, producerPath)

      expect(moduleMetadata.get(path.resolve(producerPath))?.exports).toEqual({
        countAlias: 'memo',
        memoAlias: 'memo',
        storeAlias: 'memo',
        directAlias: 'memo',
        default: 'memo',
      })
    })

    it('publishes namespace imported signal and memo aliases as memo metadata', () => {
      const sourcePath = path.join(baseDir, 'reactive-namespace-source.ts')
      const producerPath = path.join(baseDir, 'reactive-namespace-alias-producer.ts')
      const consumerPath = path.join(baseDir, 'reactive-namespace-alias-consumer.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(sourcePath), {
        version: 1,
        exports: {
          count: 'signal',
          doubled: 'memo',
        },
      })

      const producerSource = `
        import * as source from './reactive-namespace-source'

        const countAlias = source.count
        const memoAlias = source.doubled
        export const directAlias = source.count
        const defaultAlias = source.doubled

        export { countAlias, memoAlias }
        export default defaultAlias

        export function readCount() {
          return source.count
        }
      `

      const producerOutput = transform(producerSource, { moduleMetadata }, producerPath)

      expect(producerOutput).not.toContain('const countAlias = source.count();')
      expect(producerOutput).not.toContain('const memoAlias = source.doubled();')
      expect(producerOutput).not.toContain('export const directAlias = source.count();')
      expect(producerOutput).toMatch(/countAlias\s*=\s*createMemo\(\(\) => source\.count\(\)/)
      expect(producerOutput).toMatch(/memoAlias\s*=\s*createMemo\(\(\) => source\.doubled\(\)/)
      expect(producerOutput).toMatch(/directAlias\s*=\s*createMemo\(\(\) => source\.count\(\)/)
      expect(producerOutput).toMatch(/return source\.count\(\)/)
      expect(moduleMetadata.get(path.resolve(producerPath))?.exports).toEqual({
        countAlias: 'memo',
        memoAlias: 'memo',
        directAlias: 'memo',
        default: 'memo',
      })

      const consumerSource = `
        import { countAlias, directAlias, memoAlias } from './reactive-namespace-alias-producer'

        export function App() {
          return <div>{countAlias}{directAlias}{memoAlias}</div>
        }
      `
      const consumerOutput = transform(
        consumerSource,
        { fineGrainedDom: true, moduleMetadata },
        consumerPath,
      )

      expect(consumerOutput).toMatch(/countAlias\(\)/)
      expect(consumerOutput).toMatch(/directAlias\(\)/)
      expect(consumerOutput).toMatch(/memoAlias\(\)/)
    })

    it('publishes namespace imported store aliases as store metadata', () => {
      const sourcePath = path.join(baseDir, 'reactive-namespace-store-source.ts')
      const producerPath = path.join(baseDir, 'reactive-namespace-store-alias-producer.ts')
      const consumerPath = path.join(baseDir, 'reactive-namespace-store-alias-consumer.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(sourcePath), {
        version: 1,
        exports: {
          state: 'store',
        },
      })

      const producerSource = `
        import * as source from './reactive-namespace-store-source'

        const storeAlias = source.state
        export const directAlias = source.state
        const defaultAlias = source.state

        export { storeAlias }
        export default defaultAlias
      `

      const producerOutput = transform(producerSource, { moduleMetadata }, producerPath)

      expect(producerOutput).toContain('const storeAlias = source.state;')
      expect(producerOutput).toContain('export const directAlias = source.state;')
      expect(producerOutput).not.toContain('source.state()')
      expect(moduleMetadata.get(path.resolve(producerPath))?.exports).toEqual({
        storeAlias: 'store',
        directAlias: 'store',
        default: 'store',
      })

      const consumerSource = `
        import defaultAlias, { directAlias, storeAlias } from './reactive-namespace-store-alias-producer'

        export function App() {
          const doubled = storeAlias.count * 2
          const tripled = directAlias.count * 3
          const fallback = defaultAlias.count * 4
          return <div>{doubled}{tripled}{fallback}</div>
        }
      `
      const consumerOutput = transform(
        consumerSource,
        { fineGrainedDom: true, moduleMetadata },
        consumerPath,
      )

      expect(consumerOutput).toContain(
        'const doubled = __fictUseMemo(__fictCtx, () => storeAlias.count * 2',
      )
      expect(consumerOutput).toContain(
        'const tripled = __fictUseMemo(__fictCtx, () => directAlias.count * 3',
      )
      expect(consumerOutput).toContain(
        'const fallback = __fictUseMemo(__fictCtx, () => defaultAlias.count * 4',
      )
    })

    it('publishes hook metadata for imported accessor returns', () => {
      const sourcePath = path.join(baseDir, 'imported-accessor-source.ts')
      const hookPath = path.join(baseDir, 'imported-accessor-hooks.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(sourcePath), {
        version: 1,
        exports: {
          count: 'signal',
          doubled: 'memo',
          state: 'store',
        },
      })

      const hookSource = `
        import { count, doubled, state } from './imported-accessor-source'

        export function useDirect() {
          return count
        }

        export function useObject() {
          return { count, doubled, state }
        }

        export function useArrayAlias() {
          const alias = doubled
          return [count, alias]
        }

        export function useShadow(count) {
          return count
        }
      `

      transform(hookSource, { moduleMetadata }, hookPath)

      expect(moduleMetadata.get(path.resolve(hookPath))?.hooks).toMatchObject({
        useDirect: { directAccessor: 'signal' },
        useObject: { objectProps: { count: 'signal', doubled: 'memo' } },
        useArrayAlias: { arrayProps: { 0: 'signal', 1: 'memo' } },
      })
      expect(moduleMetadata.get(path.resolve(hookPath))?.hooks).not.toHaveProperty('useShadow')
    })

    it('preserves namespace imported accessor hook returns with metadata', () => {
      const sourcePath = path.join(baseDir, 'namespace-accessor-source.ts')
      const hookPath = path.join(baseDir, 'namespace-accessor-hooks.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(sourcePath), {
        version: 1,
        exports: {
          count: 'signal',
          doubled: 'memo',
          state: 'store',
        },
      })

      const hookSource = `
        import * as source from './namespace-accessor-source'

        export function useCount() {
          return source.count
        }

        export function useDoubled() {
          return source.doubled
        }

        export function useObject() {
          return { count: source.count, doubled: source.doubled, state: source.state }
        }

        export function useTuple() {
          return [source.count, source.doubled]
        }
      `

      const output = transform(hookSource, { moduleMetadata }, hookPath)

      expect(output).toMatch(/return source\.count;/)
      expect(output).toMatch(/return source\.doubled;/)
      expect(output).not.toMatch(/source\.count\(\)/)
      expect(output).not.toMatch(/source\.doubled\(\)/)
      expect(moduleMetadata.get(path.resolve(hookPath))?.hooks).toMatchObject({
        useCount: { directAccessor: 'signal' },
        useDoubled: { directAccessor: 'memo' },
        useObject: { objectProps: { count: 'signal', doubled: 'memo' } },
        useTuple: { arrayProps: { 0: 'signal', 1: 'memo' } },
      })
    })

    it('propagates hook metadata through local imported hook aliases', () => {
      const sourcePath = path.join(baseDir, 'hook-alias-source.tsx')
      const wrapperPath = path.join(baseDir, 'hook-alias-wrapper.ts')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(sourcePath), {
        version: 1,
        exports: {},
        hooks: {
          useCounter: { directAccessor: 'signal' },
        },
      })

      const wrapperSource = `
        import { useCounter } from './hook-alias-source'

        const useAlias = useCounter
        export { useAlias }

        export const useExportedAlias = useCounter

        const useDefaultAlias = useAlias
        export default useDefaultAlias

        const useChain = useDefaultAlias
        export { useChain }

        const usePlain = () => null
        const usePlainAlias = usePlain
        export { usePlainAlias }
      `

      transform(wrapperSource, { moduleMetadata }, wrapperPath)

      expect(moduleMetadata.get(path.resolve(wrapperPath))?.hooks).toMatchObject({
        useAlias: { directAccessor: 'signal' },
        useExportedAlias: { directAccessor: 'signal' },
        default: { directAccessor: 'signal' },
        useChain: { directAccessor: 'signal' },
      })
      expect(moduleMetadata.get(path.resolve(wrapperPath))?.hooks).not.toHaveProperty(
        'usePlainAlias',
      )
    })

    it('preserves hook return accessors inside branch returns before publishing metadata', () => {
      const hookPath = path.join(baseDir, 'branch-hook-returns.tsx')
      const moduleMetadata = new Map()
      const hookSource = `
        import { $state } from 'fict'

        export function useObj(flag: boolean) {
          const count = $state(0)
          if (flag) {
            return { count }
          }
          return { count }
        }

        export function useVal(flag: boolean) {
          const count = $state(0)
          switch (flag) {
            case true:
              return count
            default:
              return count
          }
        }

        export function useCond(flag: boolean) {
          const count = $state(0)
          return flag ? count : count
        }
      `

      const output = transform(hookSource, { moduleMetadata }, hookPath)

      expect(output).not.toMatch(/count:\s*count\(\)/)
      expect(output).not.toMatch(/return count\(\)/)
      expect(output).not.toMatch(/flag \? count\(\) : count\(\)/)
      expect(moduleMetadata.get(path.resolve(hookPath))?.hooks).toMatchObject({
        useObj: { objectProps: { count: 'signal' } },
        useVal: { directAccessor: 'signal' },
      })
    })

    it('preserves composite hook accessor returns with metadata', () => {
      const hookPath = path.join(baseDir, 'composite-hook-returns.tsx')
      const appPath = path.join(baseDir, 'composite-hook-consumer.tsx')
      const moduleMetadata = new Map()
      const hookSource = `
        import { $memo, $state } from 'fict'

        export function useConditional(flag: boolean) {
          const count = $state(0)
          const other = $state(1)
          return flag ? count : other
        }

        export function useLogical() {
          const count = $state(0)
          return true && count
        }

        export function useSequence() {
          const count = $state(0)
          return (0, count)
        }

        export function useIife() {
          const count = $state(0)
          return (() => count)()
        }

        export function useObjectSlot(flag: boolean) {
          const count = $state(0)
          const doubled = $memo(() => count() * 2)
          return { value: flag ? count : count, doubled: (0, doubled) }
        }

        export function useMixed(flag: boolean) {
          const count = $state(0)
          return flag && count
        }
      `

      const hookOutput = transform(hookSource, { moduleMetadata }, hookPath)

      expect(hookOutput).toMatch(/return flag \? count : other;/)
      expect(hookOutput).toMatch(/return true && count;/)
      expect(hookOutput).toMatch(/return \(?0, count\)?;/)
      expect(hookOutput).toMatch(/return \(\(\) => count\)\(\);/)
      expect(hookOutput).not.toMatch(/flag \? count\(\) : other\(\)/)
      expect(hookOutput).not.toMatch(/true && count\(\)/)
      expect(hookOutput).not.toMatch(/return \(?0, count\(\)\)?;/)
      expect(hookOutput).not.toMatch(/return \(\(\) => count\(\)\)\(\);/)
      expect(moduleMetadata.get(path.resolve(hookPath))?.hooks).toMatchObject({
        useConditional: { directAccessor: 'signal' },
        useLogical: { directAccessor: 'signal' },
        useSequence: { directAccessor: 'signal' },
        useIife: { directAccessor: 'signal' },
        useObjectSlot: { objectProps: { value: 'signal', doubled: 'memo' } },
      })
      expect(moduleMetadata.get(path.resolve(hookPath))?.hooks).not.toHaveProperty('useMixed')

      const appSource = `
        import { useConditional, useSequence } from './composite-hook-returns'

        export function App() {
          const v = useConditional(true)
          const seq = useSequence()
          return <div>{v}{seq}</div>
        }
      `
      const appOutput = transform(appSource, { fineGrainedDom: true, moduleMetadata }, appPath)

      expect(appOutput).toMatch(/v\(\)/)
      expect(appOutput).toMatch(/seq\(\)/)
    })

    it('propagates createSignal exports from advanced modules (namespace)', () => {
      const storeSource = `
        import * as runtime from 'fict/advanced'
        export const count = runtime.createSignal(0)
      `
      const appSource = `
        import { count } from './store-advanced-ns'

        export function App() {
          return <div>{count()}</div>
        }
      `

      const moduleMetadata = new Map()
      transform(storeSource, { moduleMetadata }, path.join(baseDir, 'store-advanced-ns.ts'))
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-advanced-ns.tsx'),
      )

      expect(output).toMatch(/count\(\)/)
    })

    it('does not double-call namespace imported signal accessors used as calls', () => {
      const storeSource = `
        import { createSignal } from 'fict/advanced'
        export const count = createSignal(1)
      `
      const appSource = `
        import * as store from './store-ns-call'

        export function App() {
          return <div>{store.count()}</div>
        }
      `

      const moduleMetadata = new Map()
      transform(storeSource, { moduleMetadata }, path.join(baseDir, 'store-ns-call.ts'))
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-ns-call.tsx'),
      )

      expect(output).toMatch(/store\.count\(\)/)
      expect(output).not.toMatch(/store\.count\(\)\(\)/)
    })

    it('does not double-call optional namespace imported signal accessors', () => {
      const storeSource = `
        import { createSignal } from 'fict/advanced'
        export const count = createSignal(1)
      `
      const appSource = `
        import * as store from './store-ns-optional-call'

        export function App() {
          return <div>{store.count?.()}</div>
        }
      `

      const moduleMetadata = new Map()
      transform(storeSource, { moduleMetadata }, path.join(baseDir, 'store-ns-optional-call.ts'))
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-ns-optional-call.tsx'),
      )

      expect(output).toMatch(/store\.count\?\.\(\)/)
      expect(output).not.toMatch(/store\.count\?\.\(\)\?\.\(\)/)
    })

    it('unwraps optional namespace signal member reads', () => {
      const storeSource = `
        import { createSignal } from 'fict/advanced'
        export const count = createSignal(1)
      `
      const appSource = `
        import * as store from './store-ns-optional-member'

        export function App() {
          return store?.count
        }
      `

      const moduleMetadata = new Map()
      transform(storeSource, { moduleMetadata }, path.join(baseDir, 'store-ns-optional-member.ts'))
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-ns-optional-member.tsx'),
      )

      expect(output).toMatch(/return store\?\.count\?\.\(\)/)
      expect(output).not.toContain('return store?.count;')
    })

    it('unwraps optional computed namespace signal member reads', () => {
      const storeSource = `
        import { createSignal } from 'fict/advanced'
        export const count = createSignal(1)
      `
      const appSource = `
        import * as store from './store-ns-optional-computed-member'

        export function App() {
          return store?.['count']
        }
      `

      const moduleMetadata = new Map()
      transform(
        storeSource,
        { moduleMetadata },
        path.join(baseDir, 'store-ns-optional-computed-member.ts'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-ns-optional-computed-member.tsx'),
      )

      expect(output).toMatch(/return store\?\.\["count"\]\?\.\(\)/)
      expect(output).not.toContain('return store?.["count"];')
    })

    it('preserves namespace signal assignment targets in non-strict mode', () => {
      const storeSource = `
        import { createSignal } from 'fict/advanced'
        export const count = createSignal(1)
      `
      const appSource = `
        import * as store from './store-ns-write'

        export function App() {
          store.count = 2
          return store.count
        }
      `

      const moduleMetadata = new Map()
      transform(storeSource, { moduleMetadata }, path.join(baseDir, 'store-ns-write.ts'))
      const output = transform(
        appSource,
        { moduleMetadata, strictGuarantee: false },
        path.join(baseDir, 'app-ns-write.tsx'),
      )

      expect(output).toContain('store.count = 2')
      expect(output).toMatch(/return store\.count\(\)/)
      expect(output).not.toMatch(/store\.count\(\)\s*=/)
    })

    it('preserves namespace signal compound assignment targets in non-strict mode', () => {
      const storeSource = `
        import { createSignal } from 'fict/advanced'
        export const count = createSignal(1)
      `
      const appSource = `
        import * as store from './store-ns-compound-write'

        export function App() {
          store.count += 2
          return store.count
        }
      `

      const moduleMetadata = new Map()
      transform(storeSource, { moduleMetadata }, path.join(baseDir, 'store-ns-compound-write.ts'))
      const output = transform(
        appSource,
        { moduleMetadata, strictGuarantee: false },
        path.join(baseDir, 'app-ns-compound-write.tsx'),
      )

      expect(output).toContain('store.count += 2')
      expect(output).toMatch(/return store\.count\(\)/)
      expect(output).not.toMatch(/store\.count\(\)\s*\+=/)
    })

    it('preserves namespace signal update targets in non-strict mode', () => {
      const storeSource = `
        import { createSignal } from 'fict/advanced'
        export const count = createSignal(1)
      `
      const appSource = `
        import * as store from './store-ns-update'

        export function App() {
          store.count++
          return store.count
        }
      `

      const moduleMetadata = new Map()
      transform(storeSource, { moduleMetadata }, path.join(baseDir, 'store-ns-update.ts'))
      const output = transform(
        appSource,
        { moduleMetadata, strictGuarantee: false },
        path.join(baseDir, 'app-ns-update.tsx'),
      )

      expect(output).toContain('store.count++')
      expect(output).toMatch(/return store\.count\(\)/)
      expect(output).not.toMatch(/store\.count\(\)\+\+/)
    })

    it('rejects statement assignment to named imported memos', () => {
      const storePath = path.join(baseDir, 'store-readonly-memo-assignment.ts')
      const appPath = path.join(baseDir, 'app-readonly-memo-assignment.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(storePath), {
        exports: { total: 'memo' },
      })

      expect(() =>
        transform(
          `
            import { total } from './store-readonly-memo-assignment'

            export function App() {
              total = 1
              return <div>{total}</div>
            }
          `,
          { fineGrainedDom: true, moduleMetadata },
          appPath,
        ),
      ).toThrow('Cannot write to imported memo binding "total"')
    })

    it('rejects compound assignment to named imported memos', () => {
      const storePath = path.join(baseDir, 'store-readonly-memo-compound.ts')
      const appPath = path.join(baseDir, 'app-readonly-memo-compound.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(storePath), {
        exports: { total: 'memo' },
      })

      expect(() =>
        transform(
          `
            import { total } from './store-readonly-memo-compound'

            export function App() {
              total += 1
              return <div>{total}</div>
            }
          `,
          { fineGrainedDom: true, moduleMetadata },
          appPath,
        ),
      ).toThrow('Cannot write to imported memo binding "total"')
    })

    it('rejects update expressions on named imported memos', () => {
      const storePath = path.join(baseDir, 'store-readonly-memo-update.ts')
      const appPath = path.join(baseDir, 'app-readonly-memo-update.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(storePath), {
        exports: { total: 'memo' },
      })

      expect(() =>
        transform(
          `
            import { total } from './store-readonly-memo-update'

            export function App() {
              total++
              return <div>{total}</div>
            }
          `,
          { fineGrainedDom: true, moduleMetadata },
          appPath,
        ),
      ).toThrow('Cannot write to imported memo binding "total"')
    })

    it('rejects update expressions on default imported memos', () => {
      const storePath = path.join(baseDir, 'store-readonly-default-memo.ts')
      const appPath = path.join(baseDir, 'app-readonly-default-memo.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(storePath), {
        exports: { default: 'memo' },
      })

      expect(() =>
        transform(
          `
            import total from './store-readonly-default-memo'

            export function App() {
              total++
              return <div>{total}</div>
            }
          `,
          { fineGrainedDom: true, moduleMetadata },
          appPath,
        ),
      ).toThrow('Cannot write to imported memo binding "total"')
    })

    it('keeps imported signals writable', () => {
      const storePath = path.join(baseDir, 'store-imported-signal-writes.ts')
      const appPath = path.join(baseDir, 'app-imported-signal-writes.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(storePath), {
        exports: { count: 'signal' },
      })

      const output = transform(
        `
          import { count } from './store-imported-signal-writes'

          export function App() {
            count++
            count = 2
            return <button>{count}</button>
          }
        `,
        { fineGrainedDom: true, moduleMetadata },
        appPath,
      )

      expect(output).toContain('count(2)')
      expect(output).not.toContain('count++')
      expect(output).toMatch(/count\(\)/)
    })

    it('rejects direct writes to imported stores', () => {
      const storePath = path.join(baseDir, 'store-readonly-store-update.ts')
      const appPath = path.join(baseDir, 'app-readonly-store-update.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(storePath), {
        exports: { state: 'store' },
      })

      expect(() =>
        transform(
          `
            import { state } from './store-readonly-store-update'

            export function App() {
              state = { count: 1 }
              return <div>{state.count}</div>
            }
          `,
          { fineGrainedDom: true, moduleMetadata },
          appPath,
        ),
      ).toThrow('Cannot write to imported store binding "state"')

      expect(() =>
        transform(
          `
            import { state } from './store-readonly-store-update'

            export function App() {
              state++
              return <div>{state.count}</div>
            }
          `,
          { fineGrainedDom: true, moduleMetadata },
          appPath,
        ),
      ).toThrow('Cannot write to imported store binding "state"')
    })

    it('rejects direct writes to namespace imported memo members', () => {
      const storePath = path.join(baseDir, 'store-readonly-ns-memo.ts')
      const appPath = path.join(baseDir, 'app-readonly-ns-memo.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(storePath), {
        exports: { total: 'memo' },
      })

      expect(() =>
        transform(
          `
            import * as store from './store-readonly-ns-memo'

            export function App() {
              store.total = 1
              return <div>{store.total}</div>
            }
          `,
          { fineGrainedDom: true, moduleMetadata },
          appPath,
        ),
      ).toThrow('Cannot write to imported memo binding "store.total"')

      expect(() =>
        transform(
          `
            import * as store from './store-readonly-ns-memo'

            export function App() {
              store.total++
              return <div>{store.total}</div>
            }
          `,
          { fineGrainedDom: true, moduleMetadata },
          appPath,
        ),
      ).toThrow('Cannot write to imported memo binding "store.total"')
    })

    it('does not double-call namespace imported memo accessors used as calls', () => {
      const storeSource = `
        import { createMemo } from 'fict/advanced'
        export const doubled = createMemo(() => 2)
      `
      const appSource = `
        import * as store from './store-ns-memo-call'

        export function App() {
          return <div>{store.doubled()}</div>
        }
      `

      const moduleMetadata = new Map()
      transform(storeSource, { moduleMetadata }, path.join(baseDir, 'store-ns-memo-call.ts'))
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-ns-memo-call.tsx'),
      )

      expect(output).toMatch(/store\.doubled\(\)/)
      expect(output).not.toMatch(/store\.doubled\(\)\(\)/)
    })

    it('propagates createMemo exports across modules', () => {
      const storeSource = `
        import { createMemo } from 'fict'
        export const doubled = createMemo(() => 2)
      `
      const appSource = `
        import { doubled } from './store-memo'

        export function App() {
          return <div>{doubled}</div>
        }
      `

      const moduleMetadata = new Map()
      transform(storeSource, { moduleMetadata }, path.join(baseDir, 'store-memo.ts'))
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-memo.tsx'),
      )

      expect(output).toMatch(/doubled\(\)/)
    })

    it('propagates hook return metadata across modules without explicit store', () => {
      clearModuleMetadata()
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { directAccessor: "signal" } */
        export function useCounter() {
          const count = $state(0)
          return count
        }
      `
      const appSource = `
        import { useCounter } from './use-counter'

        export function App() {
          const count = useCounter()
          return <div>{count}</div>
        }
      `
      mkdirSync(baseDir, { recursive: true })
      const hookPath = path.join(baseDir, 'use-counter.tsx')
      const appPath = path.join(baseDir, 'app.tsx')
      const hookMetaPath = `${hookPath}.fict.meta.json`
      const appMetaPath = `${appPath}.fict.meta.json`

      try {
        transform(hookSource, { emitModuleMetadata: true }, hookPath)
        const output = transform(
          appSource,
          { fineGrainedDom: true, emitModuleMetadata: false },
          appPath,
        )
        expect(output).toMatch(/count\(\)/)
      } finally {
        if (existsSync(hookMetaPath)) rmSync(hookMetaPath)
        if (existsSync(appMetaPath)) rmSync(appMetaPath)
      }
    })

    it('resolves module metadata with /@fs prefixed importer paths', () => {
      const hookSource = `
        import { $state } from 'fict'
        export function useCounter() {
          const count = $state(0)
          return count
        }
      `
      const appSource = `
        import { useCounter } from './use-counter'

        export function App() {
          const count = useCounter()
          return <div>{count}</div>
        }
      `

      const moduleMetadata = new Map()
      const hookPath = path.join(baseDir, 'use-counter.tsx')
      const appPath = path.join(baseDir, 'app.tsx')
      const hookFsPath = `/@fs/${hookPath}`
      const appFsPath = `/@fs/${appPath}`

      transform(hookSource, { moduleMetadata }, hookFsPath)
      const output = transform(appSource, { fineGrainedDom: true, moduleMetadata }, appFsPath)

      expect(output).toMatch(/count\(\)/)
    })

    it('keeps query-suffixed imports opaque when base module metadata exists', () => {
      const moduleMetadata = new Map()
      const depPath = path.join(baseDir, 'dep.ts')
      const appPath = path.join(baseDir, 'app-query-import.tsx')
      moduleMetadata.set(path.resolve(depPath), {
        exports: {
          default: 'signal',
        },
      })

      const output = transform(
        `
          import raw from './dep.ts?raw'

          export function App() {
            return <div>{raw}</div>
          }
        `,
        { fineGrainedDom: true, moduleMetadata },
        appPath,
      )

      expect(output).not.toContain('raw()')
      expect(output).toContain('raw')
    })

    it('resolves module metadata from sidecar files', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { directAccessor: "signal" } */
        export function useCounter() {
          const count = $state(0)
          return count
        }
      `
      const appSource = `
        import { useCounter } from './use-counter'

        export function App() {
          const count = useCounter()
          return <div>{count}</div>
        }
      `
      mkdirSync(baseDir, { recursive: true })
      const hookPath = path.join(baseDir, 'use-counter.tsx')
      const appPath = path.join(baseDir, 'app.tsx')
      const metaPath = `${hookPath}.fict.meta.json`

      try {
        transform(hookSource, { emitModuleMetadata: true }, hookPath)
        expect(existsSync(metaPath)).toBe(true)
        clearModuleMetadata()
        const output = transform(
          appSource,
          { fineGrainedDom: true, emitModuleMetadata: false },
          appPath,
        )
        expect(output).toMatch(/count\(\)/)
      } finally {
        if (existsSync(metaPath)) {
          rmSync(metaPath)
        }
        const appMetaPath = `${appPath}.fict.meta.json`
        if (existsSync(appMetaPath)) {
          rmSync(appMetaPath)
        }
      }
    })

    it('resolves hook metadata from a bare package root import', () => {
      clearModuleMetadata()
      const appSource = `
        import { useCounter } from 'fict-hook-lib'

        export function App() {
          const count = useCounter()
          const doubled = count * 2
          return <div>{doubled}</div>
        }
      `
      const packageDir = path.join(baseDir, 'node_modules', 'fict-hook-lib')
      const appPath = path.join(baseDir, 'app-package.tsx')

      try {
        mkdirSync(packageDir, { recursive: true })
        writeFileSync(
          path.join(packageDir, 'package.json'),
          JSON.stringify({
            name: 'fict-hook-lib',
            type: 'module',
            exports: './dist/index.js',
            fict: { metadata: './dist/index.fict.meta.json' },
          }),
        )
        mkdirSync(path.join(packageDir, 'dist'), { recursive: true })
        writeFileSync(
          path.join(packageDir, 'dist', 'index.fict.meta.json'),
          JSON.stringify({
            exports: {},
            hooks: { useCounter: { directAccessor: 'signal' } },
          }),
        )

        const output = transform(appSource, { fineGrainedDom: true }, appPath)
        expect(output).toMatch(/count\(\) \* 2/)
      } finally {
        clearModuleMetadata()
        if (existsSync(path.join(baseDir, 'node_modules'))) {
          rmSync(path.join(baseDir, 'node_modules'), { recursive: true, force: true })
        }
      }
    })

    it('resolves bare package hook object members only when metadata is published', () => {
      clearModuleMetadata()
      const appSource = `
        import { useCounter } from 'fict-hook-lib'

        export function App() {
          const state = useCounter()
          state.count++
          const next = state['count']
          const first = state[0]
          return <div>{state.count}{next}{first}</div>
        }
      `
      const packageDir = path.join(baseDir, 'node_modules', 'fict-hook-lib')
      const appPath = path.join(baseDir, 'app-package-member-metadata.tsx')

      try {
        mkdirSync(packageDir, { recursive: true })
        writeFileSync(
          path.join(packageDir, 'package.json'),
          JSON.stringify({
            name: 'fict-hook-lib',
            type: 'module',
            exports: './dist/index.js',
            fict: { metadata: './dist/index.fict.meta.json' },
          }),
        )
        mkdirSync(path.join(packageDir, 'dist'), { recursive: true })
        writeFileSync(
          path.join(packageDir, 'dist', 'index.fict.meta.json'),
          JSON.stringify({
            exports: {},
            hooks: {
              useCounter: {
                objectProps: { count: 'signal' },
                arrayProps: { 0: 'signal' },
              },
            },
          }),
        )

        const output = transform(appSource, { fineGrainedDom: true }, appPath)
        expect(output).toMatch(/state\.count\(\)/)
        expect(output).toMatch(/state\.count\(__prev_/)
        expect(output).toMatch(/state\["count"\]/)
        expect(output).toMatch(/next\(\)/)
        expect(output).toMatch(/state\[0\]/)
        expect(output).toMatch(/first\(\)/)
      } finally {
        clearModuleMetadata()
        if (existsSync(path.join(baseDir, 'node_modules'))) {
          rmSync(path.join(baseDir, 'node_modules'), { recursive: true, force: true })
        }
      }
    })

    it('keeps bare package hook returns opaque when package metadata is missing', () => {
      clearModuleMetadata()
      const appSource = `
        import { useCounter } from 'fict-hook-lib'

        export function App() {
          const count = useCounter()
          const doubled = count * 2
          return <div>{doubled}</div>
        }
      `
      const packageDir = path.join(baseDir, 'node_modules', 'fict-hook-lib')
      const appPath = path.join(baseDir, 'app-package-no-metadata.tsx')

      try {
        mkdirSync(packageDir, { recursive: true })
        writeFileSync(
          path.join(packageDir, 'package.json'),
          JSON.stringify({
            name: 'fict-hook-lib',
            type: 'module',
            exports: './dist/index.js',
          }),
        )

        const output = transform(appSource, { fineGrainedDom: true }, appPath)
        expect(output).not.toMatch(/count\(\) \* 2/)
        expect(output).toMatch(/count \* 2/)
      } finally {
        clearModuleMetadata()
        if (existsSync(path.join(baseDir, 'node_modules'))) {
          rmSync(path.join(baseDir, 'node_modules'), { recursive: true, force: true })
        }
      }
    })

    it('keeps bare package hook object members opaque when package metadata is missing', () => {
      clearModuleMetadata()
      const appSource = `
        import { useCounter } from 'fict-hook-lib'

        export function App() {
          const state = useCounter()
          state.count++
          const next = state['count']
          const first = state[0]
          return <div>{state.count}{next}{first}</div>
        }
      `
      const packageDir = path.join(baseDir, 'node_modules', 'fict-hook-lib')
      const appPath = path.join(baseDir, 'app-package-member-no-metadata.tsx')

      try {
        mkdirSync(packageDir, { recursive: true })
        writeFileSync(
          path.join(packageDir, 'package.json'),
          JSON.stringify({
            name: 'fict-hook-lib',
            type: 'module',
            exports: './dist/index.js',
          }),
        )

        const output = transform(appSource, { fineGrainedDom: true }, appPath)
        expect(output).not.toMatch(/state\.count\(\)/)
        expect(output).not.toMatch(/state\.count\(__prev_/)
        expect(output).not.toMatch(/state\["count"\]\(\)/)
        expect(output).not.toMatch(/state\[0\]\(\)/)
        expect(output).not.toMatch(/next\(\)/)
        expect(output).not.toMatch(/first\(\)/)
        expect(output).toMatch(/state\.count\+\+/)
        expect(output).toMatch(/state\["count"\]/)
        expect(output).toMatch(/state\[0\]/)
      } finally {
        clearModuleMetadata()
        if (existsSync(path.join(baseDir, 'node_modules'))) {
          rmSync(path.join(baseDir, 'node_modules'), { recursive: true, force: true })
        }
      }
    })

    it('resolves hook metadata for package subpaths used by CommonJS builds', () => {
      clearModuleMetadata()
      const appSource = `
        import { useCounter } from 'fict-hook-lib/cjs'

        export function App() {
          const count = useCounter()
          return <div>{count}</div>
        }
      `
      const packageDir = path.join(baseDir, 'node_modules', 'fict-hook-lib')
      const appPath = path.join(baseDir, 'app-package-cjs.tsx')

      try {
        mkdirSync(packageDir, { recursive: true })
        writeFileSync(
          path.join(packageDir, 'package.json'),
          JSON.stringify({
            name: 'fict-hook-lib',
            main: './dist/index.cjs',
            exports: {
              '.': {
                import: './dist/index.js',
                require: './dist/index.cjs',
              },
              './cjs': './dist/index.cjs',
            },
            fict: {
              exports: {
                '.': './dist/index.fict.meta.json',
                './cjs': './dist/index.fict.meta.json',
              },
            },
          }),
        )
        mkdirSync(path.join(packageDir, 'dist'), { recursive: true })
        writeFileSync(
          path.join(packageDir, 'dist', 'index.fict.meta.json'),
          JSON.stringify({
            exports: {},
            hooks: { useCounter: { directAccessor: 'signal' } },
          }),
        )

        const output = transform(appSource, { fineGrainedDom: true }, appPath)
        expect(output).toMatch(/count\(\)/)
      } finally {
        clearModuleMetadata()
        if (existsSync(path.join(baseDir, 'node_modules'))) {
          rmSync(path.join(baseDir, 'node_modules'), { recursive: true, force: true })
        }
      }
    })

    it('auto mode emits metadata to cache and avoids adjacent sidecar files', () => {
      clearModuleMetadata()
      const hookSource = `
        import { $state } from 'fict'
        export function useCounter() {
          const count = $state(0)
          return count
        }
      `
      const appSource = `
        import { useCounter } from './use-counter'
        export function App() {
          const count = useCounter()
          return <div>{count}</div>
        }
      `
      mkdirSync(baseDir, { recursive: true })
      const cacheDir = path.join(baseDir, '.cache-meta')
      const hookPath = path.join(baseDir, 'use-counter.tsx')
      const appPath = path.join(baseDir, 'app.tsx')
      const hookMetaPath = `${hookPath}.fict.meta.json`
      const appMetaPath = `${appPath}.fict.meta.json`

      try {
        transform(
          hookSource,
          {
            emitModuleMetadata: 'auto',
            moduleMetadataCacheDir: cacheDir,
          },
          hookPath,
        )
        expect(existsSync(hookMetaPath)).toBe(false)

        clearModuleMetadata()
        const output = transform(
          appSource,
          {
            fineGrainedDom: true,
            emitModuleMetadata: false,
            moduleMetadataCacheDir: cacheDir,
          },
          appPath,
        )
        expect(output).toMatch(/count\(\)/)
      } finally {
        clearModuleMetadata()
        if (existsSync(hookMetaPath)) rmSync(hookMetaPath)
        if (existsSync(appMetaPath)) rmSync(appMetaPath)
        if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true, force: true })
      }
    })
  })
})
