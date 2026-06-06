import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  clearModuleMetadata,
  MODULE_REACTIVE_METADATA_VERSION,
  type FictCompilerOptions,
} from '../src/index'
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

    it('preserves special string-named reactive export metadata keys', () => {
      const source = `
        import { createMemo } from 'fict'
        const value = createMemo(() => 1)
        export { value as "__proto__", value as "constructor", value as "toString" }
      `
      const moduleMetadata = new Map()
      const sourcePath = path.join(baseDir, 'special-string-export.ts')

      transform(source, { moduleMetadata }, sourcePath)

      const exports = moduleMetadata.get(path.resolve(sourcePath))?.exports
      for (const key of ['__proto__', 'constructor', 'toString']) {
        expect(Object.prototype.hasOwnProperty.call(exports, key)).toBe(true)
        expect(exports?.[key]).toBe('memo')
      }
    })

    it('preserves special string-named hook export metadata keys', () => {
      const sourcePath = path.join(baseDir, 'special-string-hook-export.tsx')
      const appPath = path.join(baseDir, 'app-special-string-hook-export.tsx')
      const moduleMetadata = new Map()
      const source = `
        import { $state } from 'fict'

        function useDirect() {
          const count = $state(1)
          return count
        }

        function useObject() {
          const count = $state(2)
          return { count }
        }

        function useArray() {
          const count = $state(3)
          return [count]
        }

        export {
          useDirect as "__proto__",
          useObject as "constructor",
          useArray as "toString",
          useDirect as normal,
        }
      `

      transform(source, { moduleMetadata }, sourcePath)

      const hooks = moduleMetadata.get(path.resolve(sourcePath))?.hooks
      expect(Object.prototype.hasOwnProperty.call(hooks, '__proto__')).toBe(true)
      expect(hooks?.['__proto__']).toMatchObject({ directAccessor: 'signal' })
      expect(hooks?.constructor).toMatchObject({ objectProps: { count: 'signal' } })
      expect(hooks?.toString).toMatchObject({ arrayProps: { '0': 'signal' } })
      expect(hooks?.normal).toMatchObject({ directAccessor: 'signal' })

      const output = transform(
        `
          import {
            "__proto__" as useProto,
            constructor as useCtor,
            toString as useToString,
            normal,
          } from './special-string-hook-export'

          export function App() {
            const direct = useProto()
            const object = useCtor()
            const array = useToString()
            const ordinary = normal()
            return <div>{direct}{object.count}{array[0]}{ordinary}</div>
          }
        `,
        { fineGrainedDom: true, moduleMetadata },
        appPath,
      )

      expect(output).toContain('direct()')
      expect(output).toContain('object.count()')
      expect(output).toContain('array[0]()')
      expect(output).toContain('ordinary()')
    })

    it('preserves special string-named reactive metadata through star exports', () => {
      const source = `
        import { createMemo } from 'fict'
        const value = createMemo(() => 1)
        export { value as "__proto__" }
      `
      const barrel = `
        export * from './special-source'
      `
      const moduleMetadata = new Map()
      const sourcePath = path.join(baseDir, 'special-source.ts')
      const barrelPath = path.join(baseDir, 'special-barrel.ts')

      transform(source, { moduleMetadata }, sourcePath)
      transform(barrel, { moduleMetadata }, barrelPath)

      const exports = moduleMetadata.get(path.resolve(barrelPath))?.exports
      expect(Object.prototype.hasOwnProperty.call(exports, '__proto__')).toBe(true)
      expect(exports?.['__proto__']).toBe('memo')
    })

    it('publishes metadata for destructured runtime reactive creator exports', () => {
      const signalSource = `
        import { createSignal } from 'fict/advanced'
        export const [count] = [createSignal(0)]
      `
      const memoSource = `
        import { createMemo } from 'fict/advanced'
        const readDoubled = () => 2
        export const [doubled] = [createMemo(readDoubled)]
      `
      const storeSource = `
        import * as runtime from 'fict/advanced'
        export const { user } = { user: runtime.createStore({ name: 'Ada' }) }
      `
      const namespaceMemoSource = `
        import * as runtime from 'fict/advanced'
        const readTotal = () => 3
        export const { total } = { total: runtime.createMemo(readTotal) }
      `
      const appSource = `
        import { count } from './destructured-signal-export'

        export function App() {
          return <div>{count}</div>
        }
      `
      const moduleMetadata = new Map()
      const signalPath = path.join(baseDir, 'destructured-signal-export.ts')
      const memoPath = path.join(baseDir, 'destructured-memo-export.ts')
      const storePath = path.join(baseDir, 'destructured-store-export.ts')
      const namespaceMemoPath = path.join(baseDir, 'destructured-namespace-memo-export.ts')

      transform(signalSource, { moduleMetadata }, signalPath)
      transform(memoSource, { moduleMetadata }, memoPath)
      transform(storeSource, { moduleMetadata }, storePath)
      transform(namespaceMemoSource, { moduleMetadata }, namespaceMemoPath)
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-destructured-runtime-exports.tsx'),
      )

      expect(moduleMetadata.get(path.resolve(signalPath))?.exports).toEqual({
        count: 'signal',
      })
      expect(moduleMetadata.get(path.resolve(memoPath))?.exports).toEqual({
        doubled: 'memo',
      })
      expect(moduleMetadata.get(path.resolve(storePath))?.exports).toEqual({
        user: 'store',
      })
      expect(moduleMetadata.get(path.resolve(namespaceMemoPath))?.exports).toEqual({
        total: 'memo',
      })
      expect(output).toMatch(/count\(\)/)
    })

    it('publishes metadata for sequence-wrapped runtime reactive creator exports', () => {
      const signalSource = `
        import { createSignal } from 'fict/advanced'
        export const count = (0, createSignal)(0)
      `
      const storeSource = `
        import { createStore } from 'fict/advanced'
        export const user = (0, createStore)({ name: 'Ada' })
      `
      const memoSource = `
        import { createMemo } from 'fict/advanced'
        const readDoubled = () => 2
        export const doubled = (0, createMemo)(readDoubled)
      `
      const namespaceSource = `
        import * as runtime from 'fict/advanced'
        export const nsCount = (0, runtime.createSignal)(1)
      `
      const defaultSource = `
        import { createSignal } from 'fict/advanced'
        export default (0, createSignal)(0)
      `
      const nonRuntimeSource = `
        function createSignal(value: number) {
          return value
        }

        export const plain = (0, createSignal)(0)
      `
      const appSource = `
        import { count } from './sequence-signal-export'

        export function App() {
          return <div>{count}</div>
        }
      `
      const moduleMetadata = new Map()
      const signalPath = path.join(baseDir, 'sequence-signal-export.ts')
      const storePath = path.join(baseDir, 'sequence-store-export.ts')
      const memoPath = path.join(baseDir, 'sequence-memo-export.ts')
      const namespacePath = path.join(baseDir, 'sequence-namespace-export.ts')
      const defaultPath = path.join(baseDir, 'sequence-default-export.ts')
      const nonRuntimePath = path.join(baseDir, 'sequence-non-runtime-export.ts')

      transform(signalSource, { moduleMetadata }, signalPath)
      transform(storeSource, { moduleMetadata }, storePath)
      transform(memoSource, { moduleMetadata }, memoPath)
      transform(namespaceSource, { moduleMetadata }, namespacePath)
      transform(defaultSource, { moduleMetadata }, defaultPath)
      transform(nonRuntimeSource, { moduleMetadata }, nonRuntimePath)
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-sequence-signal-export.tsx'),
      )

      expect(moduleMetadata.get(path.resolve(signalPath))?.exports).toEqual({
        count: 'signal',
      })
      expect(moduleMetadata.get(path.resolve(storePath))?.exports).toEqual({
        user: 'store',
      })
      expect(moduleMetadata.get(path.resolve(memoPath))?.exports).toEqual({
        doubled: 'memo',
      })
      expect(moduleMetadata.get(path.resolve(namespacePath))?.exports).toEqual({
        nsCount: 'signal',
      })
      expect(moduleMetadata.get(path.resolve(defaultPath))?.exports).toEqual({
        default: 'signal',
      })
      expect(moduleMetadata.get(path.resolve(nonRuntimePath))?.exports).toEqual({})
      expect(output).toMatch(/count\(\)/)
    })

    it('keeps internal createStore tuple exports opaque unless destructured', () => {
      const internalSource = `
        import { createStore } from 'fict/internal'
        export const pair = createStore({ count: 1 })
      `
      const runtimeInternalSource = `
        import { createStore } from '@fictjs/runtime/internal'
        export const pair = createStore({ count: 1 })
      `
      const namespaceSource = `
        import * as internal from 'fict/internal'
        export const pair = internal.createStore({ count: 1 })
      `
      const tupleSource = `
        import { createStore } from 'fict/internal'
        export const [store] = createStore({ count: 1 })
      `
      const namespaceTupleSource = `
        import * as internal from '@fictjs/runtime/internal'
        export const [store] = internal.createStore({ count: 1 })
      `
      const publicSource = `
        import { $store } from 'fict'
        export const user = $store({ name: 'Ada' })
      `
      const moduleMetadata = new Map()
      const internalPath = path.join(baseDir, 'internal-create-store-direct.ts')
      const runtimeInternalPath = path.join(baseDir, 'runtime-internal-create-store-direct.ts')
      const namespacePath = path.join(baseDir, 'internal-create-store-namespace.ts')
      const tuplePath = path.join(baseDir, 'internal-create-store-tuple.ts')
      const namespaceTuplePath = path.join(baseDir, 'internal-create-store-namespace-tuple.ts')
      const publicPath = path.join(baseDir, 'public-store-control.ts')

      transform(internalSource, { moduleMetadata }, internalPath)
      transform(runtimeInternalSource, { moduleMetadata }, runtimeInternalPath)
      transform(namespaceSource, { moduleMetadata }, namespacePath)
      transform(tupleSource, { moduleMetadata }, tuplePath)
      transform(namespaceTupleSource, { moduleMetadata }, namespaceTuplePath)
      transform(publicSource, { moduleMetadata }, publicPath)

      expect(moduleMetadata.get(path.resolve(internalPath))?.exports).toEqual({})
      expect(moduleMetadata.get(path.resolve(runtimeInternalPath))?.exports).toEqual({})
      expect(moduleMetadata.get(path.resolve(namespacePath))?.exports).toEqual({})
      expect(moduleMetadata.get(path.resolve(tuplePath))?.exports).toEqual({
        store: 'store',
      })
      expect(moduleMetadata.get(path.resolve(namespaceTuplePath))?.exports).toEqual({
        store: 'store',
      })
      expect(moduleMetadata.get(path.resolve(publicPath))?.exports).toEqual({
        user: 'store',
      })
    })

    it('keeps destructured metadata conservative for defaults rest and non-reactive values', () => {
      const arrayDefaultSource = `
        import { createSignal } from 'fict/advanced'

        export const [fallback = createSignal(0), ...rest] = [undefined, 123]
      `
      const arrayNonReactiveSource = `
        function local() {
          return 1
        }

        export const [plain] = [local()]
      `
      const objectDefaultSource = `
        import { createMemo } from 'fict/advanced'

        const readMissing = () => 1
        export const { missing = createMemo(readMissing), ...bag } = { plain: 1 }
      `
      const objectProvidedSource = `
        import { createSignal } from 'fict/advanced'

        export const { provided, ...bag } = { provided: createSignal(2), plain: 1 }
      `
      const objectDefaultedSource = `
        import { createSignal } from 'fict/advanced'

        export const { defaulted = createSignal(3), ...bag } = { defaulted: undefined }
      `
      const moduleMetadata = new Map()
      const arrayDefaultPath = path.join(baseDir, 'destructured-runtime-array-default.ts')
      const arrayNonReactivePath = path.join(baseDir, 'destructured-runtime-array-nonreactive.ts')
      const objectDefaultPath = path.join(baseDir, 'destructured-runtime-object-default.ts')
      const objectProvidedPath = path.join(baseDir, 'destructured-runtime-object-provided.ts')
      const objectDefaultedPath = path.join(baseDir, 'destructured-runtime-object-defaulted.ts')

      transform(arrayDefaultSource, { moduleMetadata }, arrayDefaultPath)
      transform(arrayNonReactiveSource, { moduleMetadata }, arrayNonReactivePath)
      transform(objectDefaultSource, { moduleMetadata }, objectDefaultPath)
      transform(objectProvidedSource, { moduleMetadata }, objectProvidedPath)
      transform(objectDefaultedSource, { moduleMetadata }, objectDefaultedPath)

      expect(moduleMetadata.get(path.resolve(arrayDefaultPath))?.exports).toEqual({
        fallback: 'signal',
      })
      expect(moduleMetadata.get(path.resolve(arrayNonReactivePath))?.exports).toEqual({})
      expect(moduleMetadata.get(path.resolve(objectDefaultPath))?.exports).toEqual({
        missing: 'memo',
      })
      expect(moduleMetadata.get(path.resolve(objectProvidedPath))?.exports).toEqual({
        provided: 'signal',
      })
      expect(moduleMetadata.get(path.resolve(objectDefaultedPath))?.exports).toEqual({
        defaulted: 'signal',
      })
    })
  })

  describe('Component Module (Imports)', () => {
    it('tracks sequence-wrapped local runtime creator calls', () => {
      const source = `
        import { createSignal } from 'fict/advanced'

        export function App() {
          const count = (0, createSignal)(0)
          return <div>{count}</div>
        }
      `
      const output = transform(source, { fineGrainedDom: true })

      expect(output).toMatch(/count\(\)/)
    })

    it('unwraps same-module top-level runtime creator accessors in components', () => {
      const source = `
        import { createMemo, createSignal, createStore } from 'fict/advanced'
        import * as runtime from 'fict/advanced'

        const localSignal = createSignal(1)
        export const exportedSignal = createSignal(2)
        const localMemo = createMemo(() => 3)
        export const exportedMemo = createMemo(() => 4)
        const localStore = createStore({ name: 'Ada' })
        const namespaceSignal = runtime.createSignal(5)

        function createSignalLocal(value: number) {
          return () => value
        }
        const shadowed = createSignalLocal(6)

        export function App() {
          return (
            <div>
              {localSignal}
              {exportedSignal}
              {localMemo}
              {exportedMemo}
              {localStore.name}
              {namespaceSignal}
              {shadowed}
            </div>
          )
        }
      `
      const output = transform(source, { fineGrainedDom: true })

      expect(output).toMatch(/localSignal\(\)/)
      expect(output).toMatch(/exportedSignal\(\)/)
      expect(output).toMatch(/localMemo\(\)/)
      expect(output).toMatch(/exportedMemo\(\)/)
      expect(output).toMatch(/localStore\.name/)
      expect(output).not.toMatch(/localStore\(\)\.name/)
      expect(output).toMatch(/namespaceSignal\(\)/)
      expect(output).not.toMatch(/shadowed\(\)/)
    })

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

    it('does not mark Object.prototype-named imports reactive from empty metadata', () => {
      const moduleMetadata = new Map()
      const depPath = path.join(baseDir, 'empty-object-prototype-names.ts')
      const appPath = path.join(baseDir, 'app-empty-object-prototype-names.tsx')
      moduleMetadata.set(path.resolve(depPath), {
        version: MODULE_REACTIVE_METADATA_VERSION,
        exports: {},
      })

      const output = transform(
        `
          import {
            toString as value,
            hasOwnProperty as hasOwn,
            constructor as ctor,
          } from './empty-object-prototype-names'

          export function App() {
            const derived = value + 1
            const combined = hasOwn + ctor
            return <div>{derived}{combined}</div>
          }
        `,
        { fineGrainedDom: true, moduleMetadata },
        appPath,
      )

      expect(output).toContain('const derived = value + 1')
      expect(output).toContain('const combined = hasOwn + ctor')
      expect(output).not.toContain('__fictUseMemo(__fictCtx, () => value + 1')
      expect(output).not.toContain('derived()')
      expect(output).not.toContain('combined()')
    })

    it('unwraps reactive bindings named __proto__', () => {
      const moduleMetadata = new Map()
      const depPath = path.join(baseDir, 'reactive-proto-binding-source.ts')
      const appPath = path.join(baseDir, 'app-reactive-proto-binding.tsx')
      moduleMetadata.set(path.resolve(depPath), {
        version: MODULE_REACTIVE_METADATA_VERSION,
        exports: {
          value: 'signal',
        },
      })

      const output = transform(
        `
          import { $memo, $state } from 'fict'
          import { value as __proto__ } from './reactive-proto-binding-source'

          export function StateApp() {
            const __proto__ = $state(1)
            return <div>{__proto__}</div>
          }

          export function MemoApp() {
            const __proto__ = $memo(() => 2)
            return <div>{__proto__}</div>
          }

          export function ImportedApp() {
            return <div>{__proto__}</div>
          }
        `,
        { fineGrainedDom: true, moduleMetadata },
        appPath,
      )

      expect(output.match(/__proto__\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
      expect(output).not.toContain('() => __proto__,')
      expect(output).not.toContain('() => __proto__)')
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

    it('does not unwrap hook-result members when nested bindings shadow hook results', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const moduleMetadata = new Map()
      transform(hookSource, { moduleMetadata }, path.join(baseDir, 'use-counter-shadow.tsx'))

      const cases = [
        {
          name: 'arrow param',
          source: `
            export function App() {
              const counter = useCounter()
              const read = counter => counter.count
              return read({ count: 1 }) + counter.count
            }
          `,
          inner: /\(counter => counter\.count\)\(\{/,
          forbidden: /counter => counter\.count\(\)/,
          outer: /counter\.count\(\)/,
        },
        {
          name: 'function expression param',
          source: `
            export function App() {
              const counter = useCounter()
              const read = function (counter) {
                return counter.count
              }
              return read({ count: 2 }) + counter.count
            }
          `,
          inner: /function \(counter\) {\s*return counter\.count;\s*}/s,
          forbidden: /function \(counter\) {\s*return counter\.count\(\);/s,
          outer: /counter\.count\(\)/,
        },
        {
          name: 'function declaration param',
          source: `
            export function App() {
              const counter = useCounter()
              function read(counter) {
                return counter.count
              }
              return read({ count: 3 }) + counter.count
            }
          `,
          inner: /function read\(counter\) {\s*return counter\.count;\s*}/s,
          forbidden: /function read\(counter\) {\s*return counter\.count\(\);/s,
          outer: /counter\.count\(\)/,
        },
        {
          name: 'destructured param',
          source: `
            export function App() {
              const counter = useCounter()
              const read = ({ counter }) => counter.count
              return read({ counter: { count: 4 } }) + counter.count
            }
          `,
          inner: /\(\{\s*counter\s*\}\) => counter\.count/,
          forbidden: /\(\{\s*counter\s*\}\) => counter\.count\(\)/,
          outer: /counter\.count\(\)/,
        },
        {
          name: 'catch param',
          source: `
            export function App() {
              const counter = useCounter()
              const read = input => {
                try {
                  throw input
                } catch (counter) {
                  return counter.count
                }
              }
              return read({ count: 5 }) + counter.count
            }
          `,
          inner: /catch \(counter\) {\s*return counter\.count;\s*}/s,
          forbidden: /catch \(counter\) {\s*return counter\.count\(\);/s,
          outer: /counter\.count\(\)/,
        },
        {
          name: 'block local',
          source: `
            export function App() {
              const counter = useCounter()
              const read = () => {
                {
                  const counter = { count: 6 }
                  return counter.count
                }
              }
              return read() + counter.count
            }
          `,
          inner: /const counter = {\s*count: 6\s*};\s*return counter\.count;/s,
          forbidden: /const counter = {\s*count: 6\s*};\s*return counter\.count\(\);/s,
          outer: /counter\.count\(\)/,
        },
        {
          name: 'shadow alias',
          source: `
            export function App() {
              const counter = useCounter()
              const read = counter => {
                const alias = counter
                return alias.count
              }
              return read({ count: 7 }) + counter.count
            }
          `,
          inner: /(?:const|let) alias = counter;\s*return alias\.count;/s,
          forbidden: /alias\.count\(\)/,
          outer: /counter\.count\(\)/,
        },
        {
          name: 'shadow writes and updates',
          source: `
            export function App() {
              const counter = useCounter()
              const mutate = counter => {
                counter.count = 8
                counter.count++
                return counter.count
              }
              return mutate({ count: 7 }) + counter.count
            }
          `,
          inner: /counter\.count = 8;\s*counter\.count\+\+;\s*return counter\.count;/s,
          forbidden: /counter\.count\(8\)|counter\.count\(\+\+/,
          outer: /counter\.count\(\)/,
        },
      ] as const

      for (const scenario of cases) {
        const output = transform(
          `
            import { useCounter } from './use-counter-shadow'
            ${scenario.source}
          `,
          { moduleMetadata },
          path.join(baseDir, `app-hook-result-shadow-${scenario.name.replace(/ /g, '-')}.tsx`),
        )

        expect(output, scenario.name).toMatch(scenario.inner)
        expect(output, scenario.name).not.toMatch(scenario.forbidden)
        expect(output, scenario.name).toMatch(scenario.outer)
      }
    })

    it('does not unwrap shadowed hook-result members in JSX text expressions', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-shadow-jsx'

        export function App() {
          const counter = useCounter()
          const read = counter => counter.count
          return <span>{read({ count: 1 })}:{counter.count}</span>
        }
      `

      const moduleMetadata = new Map()
      transform(hookSource, { moduleMetadata }, path.join(baseDir, 'use-counter-shadow-jsx.tsx'))
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-hook-result-shadow-jsx.tsx'),
      )

      expect(output).toMatch(/const read = counter => counter\.count;/)
      expect(output).not.toMatch(/counter => counter\.count\(\)/)
      expect(output).toMatch(/counter\.count\(\)/)
    })

    it('does not unwrap direct hook results when nested bindings shadow them', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { directAccessor: 'signal' } */
        export function useCount() {
          const count = $state(0)
          return count
        }
      `
      const appSource = `
        import { useCount } from './use-count-shadow-direct'

        export function App() {
          const count = useCount()
          const read = count => count
          return read(1) + count
        }
      `

      const moduleMetadata = new Map()
      transform(hookSource, { moduleMetadata }, path.join(baseDir, 'use-count-shadow-direct.tsx'))
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-use-count-shadow-direct.tsx'),
      )

      expect(output).toMatch(/\(count => count\)\(1\) \+ count\(\)/)
      expect(output).not.toMatch(/count => count\(\)/)
    })

    it('still unwraps unshadowed hook-result members inside nested functions', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-unshadowed-nested'

        export function App() {
          const counter = useCounter()
          const read = () => counter.count
          return read() + counter["count"]
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-unshadowed-nested.tsx'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-hook-result-unshadowed-nested.tsx'),
      )

      expect(output).toMatch(/return \(\(\) => counter\.count\(\)\)\(\) \+ counter\["count"\]\(\);/)
    })

    it('does not treat non-computed __proto__ hook returns as own props', () => {
      const hookPath = path.join(baseDir, 'hook-return-proto-object.tsx')
      const appPath = path.join(baseDir, 'app-hook-return-proto-object.tsx')
      const moduleMetadata = new Map()
      const hookSource = `
        import { $state } from 'fict'

        export function useThing() {
          const count = $state(1)
          return { __proto__: count, normal: count, constructor: count }
        }

        export function useComputedThing() {
          const count = $state(2)
          return { ["__proto__"]: count }
        }

        export function SameFileApp() {
          const thing = useThing()
          thing.__proto__ = { marker: true }
          thing.normal = 2
          thing.constructor++
          const computed = useComputedThing()
          computed.__proto__ = 3
          return <div>{thing.__proto__}{thing.normal}{thing.constructor}{computed.__proto__}</div>
        }
      `
      const hookOutput = transform(hookSource, { fineGrainedDom: true, moduleMetadata }, hookPath)
      const hookInfo = moduleMetadata.get(path.resolve(hookPath))?.hooks

      expect(hookInfo?.useThing?.objectProps).toEqual({
        normal: 'signal',
        constructor: 'signal',
      })
      expect(
        Object.prototype.hasOwnProperty.call(hookInfo?.useThing?.objectProps, '__proto__'),
      ).toBe(false)
      expect(hookInfo?.useComputedThing?.objectProps).toEqual({ ['__proto__']: 'signal' })

      expect(hookOutput).toContain('thing.__proto__ = {')
      expect(hookOutput).not.toContain('thing.__proto__({')
      expect(hookOutput).not.toContain('thing.__proto__()')
      expect(hookOutput).toContain('thing.normal(2)')
      expect(hookOutput).toContain('thing.normal()')
      expect(hookOutput).toContain('thing.constructor(')
      expect(hookOutput).toContain('thing.constructor()')
      expect(hookOutput).toContain('computed.__proto__(3)')
      expect(hookOutput).toContain('computed.__proto__()')

      const consumerOutput = transform(
        `
          import { useComputedThing, useThing } from './hook-return-proto-object'

          export function App() {
            const thing = useThing()
            thing.__proto__ = { marker: true }
            thing.normal = 2
            thing.constructor++
            const computed = useComputedThing()
            computed.__proto__ = 3
            return <div>{thing.__proto__}{thing.normal}{thing.constructor}{computed.__proto__}</div>
          }
        `,
        { fineGrainedDom: true, moduleMetadata },
        appPath,
      )

      expect(consumerOutput).toContain('thing.__proto__ = {')
      expect(consumerOutput).not.toContain('thing.__proto__({')
      expect(consumerOutput).not.toContain('thing.__proto__()')
      expect(consumerOutput).toContain('thing.normal(2)')
      expect(consumerOutput).toContain('thing.normal()')
      expect(consumerOutput).toContain('thing.constructor(')
      expect(consumerOutput).toContain('thing.constructor()')
      expect(consumerOutput).toContain('computed.__proto__(3)')
      expect(consumerOutput).toContain('computed.__proto__()')
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

    it('keeps Object.prototype namespace hook metadata opaque', () => {
      const emptyPath = path.join(baseDir, 'namespace-empty-hook-prototype.ts')
      const inheritedPath = path.join(baseDir, 'namespace-inherited-hook-prototype.ts')
      const missingPath = path.join(baseDir, 'namespace-missing-hooks-prototype.ts')
      const validPath = path.join(baseDir, 'namespace-valid-hook-control.ts')
      const malformedPath = path.join(baseDir, 'namespace-malformed-hook-control.ts')
      const appPath = path.join(baseDir, 'app-namespace-empty-hook-prototype.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(emptyPath), {
        version: 1,
        exports: {},
        hooks: {},
      })
      moduleMetadata.set(path.resolve(inheritedPath), {
        version: 1,
        exports: {},
        hooks: Object.create({
          toString: { objectProps: { foo: 'signal' } },
        }),
      })
      moduleMetadata.set(path.resolve(missingPath), {
        version: 1,
        exports: {},
      })
      moduleMetadata.set(path.resolve(validPath), {
        version: 1,
        exports: {},
        hooks: {
          useCounter: { objectProps: { count: 'signal' } },
        },
      })
      const malformedHook = Object.assign(
        function malformedHook() {
          return ''
        },
        {
          objectProps: { foo: 'signal' },
        },
      )
      moduleMetadata.set(path.resolve(malformedPath), {
        version: 1,
        exports: {},
        hooks: {
          useBad: malformedHook,
        },
      })

      const output = transform(
        `
          import * as empty from './namespace-empty-hook-prototype'
          import * as inherited from './namespace-inherited-hook-prototype'
          import * as missing from './namespace-missing-hooks-prototype'
          import * as valid from './namespace-valid-hook-control'
          import * as malformed from './namespace-malformed-hook-control'

          export function App() {
            const bad = empty.toString()
            const inheritedResult = inherited.toString()
            const ctor = empty.constructor()
            const has = empty.hasOwnProperty()
            const val = empty.valueOf()
            const missingResult = missing.toString()
            const real = valid.useCounter()
            const malformedResult = malformed.useBad()
            return (
              <div>
                {bad.foo}
                {inheritedResult.foo}
                {ctor.foo}
                {has.foo}
                {val.foo}
                {missingResult.foo}
                {real.count}
                {malformedResult.foo}
              </div>
            )
          }
        `,
        { fineGrainedDom: true, moduleMetadata },
        appPath,
      )

      for (const name of [
        'bad',
        'inheritedResult',
        'ctor',
        'has',
        'val',
        'missingResult',
        'malformedResult',
      ]) {
        expect(output).toContain(`${name}.foo`)
        expect(output).not.toContain(`${name}.foo()`)
      }
      expect(output).toContain('real.count()')
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

    it('rejects writes to memo hook-return object members', () => {
      const hookPath = path.join(baseDir, 'memo-hook-object-write.tsx')
      const appPath = path.join(baseDir, 'app-memo-hook-object-write.tsx')
      const moduleMetadata = new Map()
      const hookSource = `
        import { $memo, $state } from 'fict'

        export function useThing() {
          const count = $state(1)
          const doubled = $memo(() => count * 2)
          return { count, doubled, plain: 1 }
        }
      `

      expect(() =>
        transform(
          `
            import { $memo, $state } from 'fict'

            function useThing() {
              const count = $state(1)
              const doubled = $memo(() => count * 2)
              return { count, doubled, plain: 1 }
            }

            export function App() {
              const thing = useThing()
              thing.doubled = 5
              return <div>{thing.doubled}</div>
            }
          `,
          { fineGrainedDom: true },
          path.join(baseDir, 'same-file-memo-hook-object-write.tsx'),
        ),
      ).toThrow('Cannot write to hook-return memo member')

      transform(hookSource, { moduleMetadata }, hookPath)

      for (const statement of [
        'thing.doubled = 5',
        'thing.doubled += 5',
        'thing.doubled++',
        '++thing.doubled',
        'thing["doubled"] = 5',
      ]) {
        expect(() =>
          transform(
            `
              import { useThing } from './memo-hook-object-write'

              export function App() {
                const thing = useThing()
                ${statement}
                return <div>{thing.doubled}</div>
              }
            `,
            { fineGrainedDom: true, moduleMetadata },
            appPath,
          ),
        ).toThrow('Cannot write to hook-return memo member')
      }

      const controlOutput = transform(
        `
          import { useThing } from './memo-hook-object-write'

          export function App() {
            const thing = useThing()
            thing.count = 2
            thing.plain = 3
            const called = thing.doubled()
            return <div>{thing.count}{thing.plain}{called}</div>
          }
        `,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-memo-hook-object-write-control.tsx'),
      )

      expect(controlOutput).toContain('thing.count(2)')
      expect(controlOutput).toContain('thing.plain = 3')
      expect(controlOutput).toContain('thing.doubled()')
      expect(controlOutput).not.toContain('thing.doubled()()')
    })

    it('rejects writes to memo hook-return array members', () => {
      const hookPath = path.join(baseDir, 'memo-hook-array-write.tsx')
      const appPath = path.join(baseDir, 'app-memo-hook-array-write.tsx')
      const moduleMetadata = new Map()
      const hookSource = `
        import { $memo, $state } from 'fict'

        export function usePair() {
          const count = $state(1)
          const doubled = $memo(() => count * 2)
          return [doubled, count, 1]
        }
      `

      expect(() =>
        transform(
          `
            import { $memo, $state } from 'fict'

            function usePair() {
              const count = $state(1)
              const doubled = $memo(() => count * 2)
              return [doubled, count, 1]
            }

            export function App() {
              const pair = usePair()
              pair[0] = 5
              return <div>{pair[0]}</div>
            }
          `,
          { fineGrainedDom: true },
          path.join(baseDir, 'same-file-memo-hook-array-write.tsx'),
        ),
      ).toThrow('Cannot write to hook-return memo member')

      transform(hookSource, { moduleMetadata }, hookPath)

      for (const statement of ['pair[0] = 5', 'pair[0] += 5', 'pair[0]++', '++pair[0]']) {
        expect(() =>
          transform(
            `
              import { usePair } from './memo-hook-array-write'

              export function App() {
                const pair = usePair()
                ${statement}
                return <div>{pair[0]}</div>
              }
            `,
            { fineGrainedDom: true, moduleMetadata },
            appPath,
          ),
        ).toThrow('Cannot write to hook-return memo member')
      }

      const controlOutput = transform(
        `
          import { usePair } from './memo-hook-array-write'

          export function App() {
            const pair = usePair()
            pair[1] = 2
            pair[2] = 3
            const called = pair[0]()
            return <div>{pair[1]}{pair[2]}{called}</div>
          }
        `,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-memo-hook-array-write-control.tsx'),
      )

      expect(controlOutput).toContain('pair[1](2)')
      expect(controlOutput).toMatch(/: pair\[__key_\d+\] = 3/)
      expect(controlOutput).not.toContain('pair[2](3)')
      expect(controlOutput).toContain('pair[0]()')
      expect(controlOutput).not.toContain('pair[0]()()')
    })

    it('rejects delete on hook-return accessor members', () => {
      const hookPath = path.join(baseDir, 'delete-hook-accessor.tsx')
      const appPath = path.join(baseDir, 'app-delete-hook-accessor.tsx')
      const moduleMetadata = new Map()
      const hookSource = `
        import { $memo, $state } from 'fict'

        export function useThing() {
          const count = $state(1)
          const doubled = $memo(() => count * 2)
          return { count, doubled, plain: 1 }
        }

        export function usePair() {
          const count = $state(1)
          const doubled = $memo(() => count * 2)
          return [count, doubled, 1]
        }
      `

      expect(() =>
        transform(
          `
            import { $memo, $state } from 'fict'

            function useThing() {
              const count = $state(1)
              const doubled = $memo(() => count * 2)
              return { count, doubled, plain: 1 }
            }

            export function App() {
              const thing = useThing()
              return delete thing.count
            }
          `,
          { fineGrainedDom: true },
          path.join(baseDir, 'same-file-delete-hook-accessor.tsx'),
        ),
      ).toThrow('Cannot delete hook-return accessor member')

      transform(hookSource, { moduleMetadata }, hookPath)

      for (const statement of [
        'delete thing.count',
        'delete thing.doubled',
        'delete thing?.count',
        'delete pair[0]',
        'delete pair[1]',
      ]) {
        expect(() =>
          transform(
            `
              import { usePair, useThing } from './delete-hook-accessor'

              export function App() {
                const thing = useThing()
                const pair = usePair()
                return ${statement}
              }
            `,
            { fineGrainedDom: true, moduleMetadata },
            appPath,
          ),
        ).toThrow('Cannot delete hook-return accessor member')
      }

      const controlOutput = transform(
        `
          import { usePair, useThing } from './delete-hook-accessor'

          export function App() {
            const thing = useThing()
            const pair = usePair()
            const removed = delete thing.plain
            const optionalRemoved = delete thing?.plain
            const slotRemoved = delete pair[2]
            return <div>{removed}{optionalRemoved}{slotRemoved}{thing.count}{thing.doubled}{pair[0]}{pair[1]}</div>
          }
        `,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-delete-hook-accessor-control.tsx'),
      )

      expect(controlOutput).toContain('delete thing.plain')
      expect(controlOutput).toContain('delete thing?.plain')
      expect(controlOutput).toContain('delete pair[2]')
      expect(controlOutput).not.toContain('delete thing.plain()')
      expect(controlOutput).not.toContain('delete pair[2]()')
      expect(controlOutput).toContain('thing.count()')
      expect(controlOutput).toContain('thing.doubled()')
      expect(controlOutput).toContain('pair[0]()')
      expect(controlOutput).toContain('pair[1]()')
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

    it('narrows hook-result metadata for object rest exclusions', () => {
      const hookSource = `
        import { $memo, $state } from 'fict'

        /** @fictReturn { count: 'signal', other: 'signal', doubled: 'memo' } */
        export function useCounter() {
          const count = $state(0)
          const other = $state(2)
          const doubled = $memo(() => count * 2)
          return { count, other, doubled }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-rest-narrow'

        export function App() {
          const state = useCounter()
          const { count, doubled, ...rest } = state
          return <span>{String(rest.count)}:{String(rest.doubled)}:{rest.other}</span>
        }
      `

      const moduleMetadata = new Map()
      transform(hookSource, { moduleMetadata }, path.join(baseDir, 'use-counter-rest-narrow.tsx'))
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-hook-rest-narrow.tsx'),
      )

      expect(output).toContain('__fictObjectRest')
      expect(output).toContain('["count", "doubled"]')
      expect(output).toMatch(/String\(rest\.count\)/)
      expect(output).toMatch(/String\(rest\.doubled\)/)
      expect(output).toMatch(/rest\.other\(\)/)
      expect(output).not.toMatch(/rest\.count\(\)/)
      expect(output).not.toMatch(/rest\.doubled\(\)/)
    })

    it('keeps retained hook-result rest properties reactive while preserving excluded writes', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal', other: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          const other = $state(2)
          return { count, other }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-rest-write'

        export function App() {
          const state = useCounter()
          const { count, ...rest } = state
          rest.count = 1
          rest.count++
          rest.other = 2
          return <span>{rest.count}:{rest.other}</span>
        }
      `

      const moduleMetadata = new Map()
      transform(hookSource, { moduleMetadata }, path.join(baseDir, 'use-counter-rest-write.tsx'))
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-hook-rest-write.tsx'),
      )

      expect(output).toContain('rest.count = 1')
      expect(output).toContain('rest.count++')
      expect(output).toContain('rest.other(2)')
      expect(output).toMatch(/rest\.other\(\)/)
      expect(output).not.toContain('rest.count(1)')
      expect(output).not.toMatch(/rest\.count\(\+\+/)
    })

    it('narrows array-like hook-result rest metadata for numeric exclusions', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn [0: 'signal', 1: 'signal'] */
        export function usePair() {
          const first = $state(1)
          const second = $state(2)
          return [first, second]
        }
      `
      const appSource = `
        import { usePair } from './use-pair-object-rest-numeric'

        export function App() {
          const pair = usePair()
          const { 0: first, ...rest } = pair
          return <span>{String(rest[0])}:{rest[1]}</span>
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-pair-object-rest-numeric.tsx'),
      )
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-hook-rest-numeric.tsx'),
      )

      expect(output).toMatch(/String\(rest\[0\]\)/)
      expect(output).toMatch(/rest\[1\]\(\)/)
      expect(output).not.toMatch(/rest\[0\]\(\)/)
    })

    it('narrows hook-result rest metadata for computed static exclusions', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal', other: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          const other = $state(2)
          return { count, other }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-rest-computed'

        export function App() {
          const state = useCounter()
          const { ["count"]: count, ...rest } = state
          return <span>{String(rest.count)}:{rest.other}</span>
        }
      `

      const moduleMetadata = new Map()
      transform(hookSource, { moduleMetadata }, path.join(baseDir, 'use-counter-rest-computed.tsx'))
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-hook-rest-computed.tsx'),
      )

      expect(output).toMatch(/String\(rest\.count\)/)
      expect(output).toMatch(/rest\.other\(\)/)
      expect(output).not.toMatch(/rest\.count\(\)/)
    })

    it('drops hook-result rest metadata for dynamic exclusions', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal', other: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          const other = $state(2)
          return { count, other }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-rest-dynamic'

        export function App() {
          const state = useCounter()
          const key = 'count'
          const { [key]: removed, ...rest } = state
          return <span>{rest.other}</span>
        }
      `

      const moduleMetadata = new Map()
      transform(hookSource, { moduleMetadata }, path.join(baseDir, 'use-counter-rest-dynamic.tsx'))
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-hook-rest-dynamic.tsx'),
      )

      expect(output).toContain('__fictObjectRest')
      expect(output).toMatch(/rest\.other/)
      expect(output).not.toMatch(/rest\.other\(\)/)
    })

    it('preserves hook-result metadata for plain aliases', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { count: 'signal' } */
        export function useCounter() {
          const count = $state(0)
          return { count }
        }
      `
      const appSource = `
        import { useCounter } from './use-counter-rest-alias-control'

        export function App() {
          const state = useCounter()
          const rest = state
          return <span>{rest.count}</span>
        }
      `

      const moduleMetadata = new Map()
      transform(
        hookSource,
        { moduleMetadata },
        path.join(baseDir, 'use-counter-rest-alias-control.tsx'),
      )
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-hook-rest-alias-control.tsx'),
      )

      expect(output).toMatch(/rest\.count\(\)/)
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

    it('propagates hook return metadata through namespace hook-call wrappers', () => {
      const hookSource = `
        import { $state } from 'fict'

        /** @fictReturn { directAccessor: "signal" } */
        export function useCounter() {
          const count = $state(0)
          return count
        }

        /** @fictReturn { count: "signal" } */
        export function useObjectCounter() {
          const count = $state(0)
          return { count }
        }

        /** @fictReturn [0: "signal"] */
        export function useArrayCounter() {
          const count = $state(0)
          return [count]
        }
      `
      const wrapperSource = `
        import * as hooks from './use-counter-namespace-wrapper-source'

        export function useWrapped() {
          return hooks.useCounter()
        }

        export function useOptionalWrapped() {
          return hooks.useCounter?.()
        }

        export function useObjectWrapped() {
          return hooks.useObjectCounter()
        }

        export function useArrayWrapped() {
          return hooks.useArrayCounter?.()
        }
      `
      const appSource = `
        import {
          useArrayWrapped,
          useObjectWrapped,
          useOptionalWrapped,
          useWrapped,
        } from './namespace-wrapper'

        export function App() {
          const count = useWrapped()
          const optional = useOptionalWrapped()
          const { count: objectCount } = useObjectWrapped()
          const [arrayCount] = useArrayWrapped()
          return <div>{count}{optional}{objectCount}{arrayCount}</div>
        }
      `

      const moduleMetadata = new Map()
      const hookPath = path.join(baseDir, 'use-counter-namespace-wrapper-source.tsx')
      const wrapperPath = path.join(baseDir, 'namespace-wrapper.tsx')
      transform(hookSource, { moduleMetadata }, hookPath)
      transform(wrapperSource, { moduleMetadata }, wrapperPath)
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-namespace-wrapper.tsx'),
      )

      expect(moduleMetadata.get(path.resolve(wrapperPath))?.hooks).toMatchObject({
        useWrapped: { directAccessor: 'signal' },
        useOptionalWrapped: { directAccessor: 'signal' },
        useObjectWrapped: { objectProps: { count: 'signal' } },
        useArrayWrapped: { arrayProps: { 0: 'signal' } },
      })
      expect(output).toMatch(/count\(\)/)
      expect(output).toMatch(/optional\(\)/)
      expect(output).toMatch(/objectCount\(\)/)
      expect(output).toMatch(/arrayCount\(\)/)
    })

    it('keeps namespace hook-call wrappers opaque without source metadata', () => {
      const hookSource = `
        export function useOpaque() {
          return { count: 1 }
        }
      `
      const wrapperSource = `
        import * as hooks from './use-opaque-namespace-wrapper-source'

        export function useWrapped() {
          return hooks.useOpaque()
        }
      `

      const moduleMetadata = new Map()
      const hookPath = path.join(baseDir, 'use-opaque-namespace-wrapper-source.tsx')
      const wrapperPath = path.join(baseDir, 'opaque-namespace-wrapper.tsx')
      transform(hookSource, { moduleMetadata }, hookPath)
      transform(wrapperSource, { moduleMetadata }, wrapperPath)

      expect(moduleMetadata.get(path.resolve(wrapperPath))?.hooks).toBeUndefined()
    })

    it('publishes hook-call object and array slot metadata', () => {
      const hookSource = `
        import { $state } from 'fict'

        export function useCounter() {
          const count = $state(0)
          return count
        }

        export function useObjectCounter() {
          const count = $state(0)
          return { count }
        }

        export function useObjectWrapped() {
          return {
            count: useCounter(),
            opaque: useObjectCounter(),
          }
        }

        export function useArrayWrapped() {
          return [useCounter(), useObjectCounter()]
        }
      `
      const appSource = `
        import { useArrayWrapped, useObjectWrapped } from './hook-call-slot-source'

        export function App() {
          const { count, opaque } = useObjectWrapped()
          const [first, second] = useArrayWrapped()
          return <div>{count}{opaque.count}{first}{second.count}</div>
        }
      `

      const moduleMetadata = new Map()
      const hookPath = path.join(baseDir, 'hook-call-slot-source.tsx')
      transform(hookSource, { moduleMetadata }, hookPath)
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-hook-call-slot-source.tsx'),
      )

      expect(moduleMetadata.get(path.resolve(hookPath))?.hooks).toMatchObject({
        useObjectWrapped: { objectProps: { count: 'signal' } },
        useArrayWrapped: { arrayProps: { 0: 'signal' } },
      })
      expect(moduleMetadata.get(path.resolve(hookPath))?.hooks?.useObjectWrapped).not.toEqual(
        expect.objectContaining({ objectProps: expect.objectContaining({ opaque: 'signal' }) }),
      )
      expect(moduleMetadata.get(path.resolve(hookPath))?.hooks?.useArrayWrapped).not.toEqual(
        expect.objectContaining({ arrayProps: expect.objectContaining({ 1: 'signal' }) }),
      )
      expect(output).toMatch(/count\(\)/)
      expect(output).toMatch(/first\(\)/)
      expect(output).not.toMatch(/opaque\(\)/)
      expect(output).not.toMatch(/second\(\)/)
    })

    it('publishes namespace and default hook-call slot metadata', () => {
      const hookSource = `
        import { $state } from 'fict'

        export function useCounter() {
          const count = $state(0)
          return count
        }

        export default function useDefaultCounter() {
          const count = $state(1)
          return count
        }
      `
      const wrapperSource = `
        import useDefaultCounter, * as hooks from './hook-call-slot-import-source'

        export function useWrapped() {
          return {
            named: hooks.useCounter(),
            optional: hooks.useCounter?.(),
            defaulted: useDefaultCounter(),
          }
        }
      `
      const appSource = `
        import { useWrapped } from './hook-call-slot-import-wrapper'

        export function App() {
          const { named, optional, defaulted } = useWrapped()
          return <div>{named}{optional}{defaulted}</div>
        }
      `

      const moduleMetadata = new Map()
      const hookPath = path.join(baseDir, 'hook-call-slot-import-source.tsx')
      const wrapperPath = path.join(baseDir, 'hook-call-slot-import-wrapper.tsx')
      transform(hookSource, { moduleMetadata }, hookPath)
      transform(wrapperSource, { moduleMetadata }, wrapperPath)
      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata },
        path.join(baseDir, 'app-hook-call-slot-import-wrapper.tsx'),
      )

      expect(moduleMetadata.get(path.resolve(wrapperPath))?.hooks).toMatchObject({
        useWrapped: {
          objectProps: {
            defaulted: 'signal',
            named: 'signal',
            optional: 'signal',
          },
        },
      })
      expect(output).toMatch(/named\(\)/)
      expect(output).toMatch(/optional\(\)/)
      expect(output).toMatch(/defaulted\(\)/)
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

    it('does not publish Object.prototype-named re-export metadata from empty exports', () => {
      const emptyPath = path.join(baseDir, 'empty-reexport-prototype-names.ts')
      const realPath = path.join(baseDir, 'real-reexport-control.ts')
      const barrelPath = path.join(baseDir, 'barrel-empty-reexport-prototype-names.ts')
      const appPath = path.join(baseDir, 'app-empty-reexport-prototype-names.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(emptyPath), {
        version: MODULE_REACTIVE_METADATA_VERSION,
        exports: {},
      })
      moduleMetadata.set(path.resolve(realPath), {
        version: MODULE_REACTIVE_METADATA_VERSION,
        exports: {
          count: 'memo',
        },
      })

      transform(
        `
          export {
            toString as x,
            hasOwnProperty as y,
            constructor as z,
            valueOf as w,
          } from './empty-reexport-prototype-names'
          export { count } from './real-reexport-control'
        `,
        { moduleMetadata },
        barrelPath,
      )

      const meta = moduleMetadata.get(path.resolve(barrelPath))
      expect(meta?.exports).toEqual({ count: 'memo' })
      for (const name of ['x', 'y', 'z', 'w']) {
        expect(Object.prototype.hasOwnProperty.call(meta?.exports, name)).toBe(false)
      }

      const output = transform(
        `
          import { count, x } from './barrel-empty-reexport-prototype-names'

          export function App() {
            const derived = x + 1
            return <div>{count}{derived}</div>
          }
        `,
        { fineGrainedDom: true, moduleMetadata },
        appPath,
      )

      expect(output).toMatch(/count\(\)/)
      expect(output).toContain('const derived = x + 1')
      expect(output).not.toContain('x()')
    })

    it('does not publish Object.prototype-named hook re-export metadata from empty hooks', () => {
      const emptyPath = path.join(baseDir, 'empty-hook-reexport-prototype-names.ts')
      const realPath = path.join(baseDir, 'real-hook-reexport-control.ts')
      const malformedPath = path.join(baseDir, 'malformed-hook-reexport-control.ts')
      const barrelPath = path.join(baseDir, 'barrel-empty-hook-reexport-prototype-names.ts')
      const appPath = path.join(baseDir, 'app-empty-hook-reexport-prototype-names.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(emptyPath), {
        version: MODULE_REACTIVE_METADATA_VERSION,
        exports: {},
        hooks: {},
      })
      moduleMetadata.set(path.resolve(realPath), {
        version: MODULE_REACTIVE_METADATA_VERSION,
        exports: {},
        hooks: {
          useReal: { objectProps: { count: 'signal' } },
        },
      })
      moduleMetadata.set(path.resolve(malformedPath), {
        version: MODULE_REACTIVE_METADATA_VERSION,
        exports: {},
        hooks: {
          useMalformed: Object.prototype.toString,
        },
      })

      transform(
        `
          export {
            toString as useBad,
            hasOwnProperty as useHas,
            constructor as useCtor,
            valueOf as useValue,
          } from './empty-hook-reexport-prototype-names'
          export { useReal } from './real-hook-reexport-control'
          export { useMalformed } from './malformed-hook-reexport-control'
        `,
        { moduleMetadata },
        barrelPath,
      )

      const meta = moduleMetadata.get(path.resolve(barrelPath))
      expect(meta?.hooks).toEqual({
        useReal: { objectProps: { count: 'signal' } },
      })
      for (const name of ['useBad', 'useHas', 'useCtor', 'useValue', 'useMalformed']) {
        expect(Object.prototype.hasOwnProperty.call(meta?.hooks, name)).toBe(false)
      }

      const output = transform(
        `
          import { useBad, useReal } from './barrel-empty-hook-reexport-prototype-names'

          export function App() {
            const bad = useBad()
            const real = useReal()
            return <div>{bad.count}{real.count}</div>
          }
        `,
        { fineGrainedDom: true, moduleMetadata },
        appPath,
      )

      expect(output).toContain('bad.count')
      expect(output).not.toContain('bad.count()')
      expect(output).toContain('real.count()')
    })

    it('does not publish malformed imported hook metadata through local exports', () => {
      const emptyPath = path.join(baseDir, 'empty-imported-hook-prototype-names.ts')
      const inheritedPath = path.join(baseDir, 'inherited-imported-hook-prototype-names.ts')
      const realPath = path.join(baseDir, 'real-imported-hook-control.ts')
      const malformedPath = path.join(baseDir, 'malformed-imported-hook-control.ts')
      const malformedDefaultPath = path.join(baseDir, 'malformed-default-hook-control.ts')
      const barrelPath = path.join(baseDir, 'barrel-imported-hook-prototype-names.ts')
      const appPath = path.join(baseDir, 'app-imported-hook-prototype-names.tsx')
      const malformedHook = Object.assign(
        function malformedHook() {
          return ''
        },
        {
          objectProps: { count: 'signal' },
        },
      )
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(emptyPath), {
        version: MODULE_REACTIVE_METADATA_VERSION,
        exports: {},
        hooks: {},
      })
      moduleMetadata.set(path.resolve(inheritedPath), {
        version: MODULE_REACTIVE_METADATA_VERSION,
        exports: {},
        hooks: Object.create({
          toString: { objectProps: { count: 'signal' } },
        }),
      })
      moduleMetadata.set(path.resolve(realPath), {
        version: MODULE_REACTIVE_METADATA_VERSION,
        exports: {},
        hooks: {
          useReal: { objectProps: { count: 'signal' } },
        },
      })
      moduleMetadata.set(path.resolve(malformedPath), {
        version: MODULE_REACTIVE_METADATA_VERSION,
        exports: {},
        hooks: {
          useMalformed: malformedHook,
        },
      })
      moduleMetadata.set(path.resolve(malformedDefaultPath), {
        version: MODULE_REACTIVE_METADATA_VERSION,
        exports: {},
        hooks: {
          default: malformedHook,
        },
      })

      transform(
        `
          import { toString as useBad } from './empty-imported-hook-prototype-names'
          import { toString as useInherited } from './inherited-imported-hook-prototype-names'
          import { useReal } from './real-imported-hook-control'
          import { useMalformed } from './malformed-imported-hook-control'
          import useDefaultMalformed from './malformed-default-hook-control'

          export { useBad, useInherited, useReal, useMalformed, useDefaultMalformed }
        `,
        { moduleMetadata },
        barrelPath,
      )

      const meta = moduleMetadata.get(path.resolve(barrelPath))
      expect(Object.keys(meta?.hooks ?? {})).toEqual(['useReal'])
      expect(meta?.hooks?.useReal).toMatchObject({
        objectProps: { count: 'signal' },
      })
      for (const name of ['useBad', 'useInherited', 'useMalformed', 'useDefaultMalformed']) {
        expect(Object.prototype.hasOwnProperty.call(meta?.hooks, name)).toBe(false)
      }

      const output = transform(
        `
          import { useMalformed, useReal } from './barrel-imported-hook-prototype-names'

          export function App() {
            const bad = useMalformed()
            const real = useReal()
            return <div>{bad.count}{real.count}</div>
          }
        `,
        { fineGrainedDom: true, moduleMetadata },
        appPath,
      )

      expect(output).toContain('bad.count')
      expect(output).not.toContain('bad.count()')
      expect(output).toContain('real.count()')
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

    it('publishes direct default namespace reactive member metadata', () => {
      const sourcePath = path.join(baseDir, 'reactive-namespace-default-source.ts')
      const signalForwardPath = path.join(baseDir, 'reactive-namespace-default-signal.ts')
      const memoForwardPath = path.join(baseDir, 'reactive-namespace-default-memo.ts')
      const storeForwardPath = path.join(baseDir, 'reactive-namespace-default-store.ts')
      const dynamicForwardPath = path.join(baseDir, 'reactive-namespace-default-dynamic.ts')
      const consumerPath = path.join(baseDir, 'reactive-namespace-default-consumer.tsx')
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(sourcePath), {
        version: 1,
        exports: {
          count: 'signal',
          doubled: 'memo',
          state: 'store',
        },
      })

      const signalOutput = transform(
        `
          import * as source from './reactive-namespace-default-source'
          export default source.count
        `,
        { moduleMetadata },
        signalForwardPath,
      )
      transform(
        `
          import * as source from './reactive-namespace-default-source'
          export default source['doubled']
        `,
        { moduleMetadata },
        memoForwardPath,
      )
      transform(
        `
          import * as source from './reactive-namespace-default-source'
          export default source.state
        `,
        { moduleMetadata },
        storeForwardPath,
      )
      transform(
        `
          import * as source from './reactive-namespace-default-source'
          const key = 'count'
          export default source[key]
        `,
        { moduleMetadata },
        dynamicForwardPath,
      )

      expect(signalOutput).toContain('export default source.count')
      expect(moduleMetadata.get(path.resolve(signalForwardPath))?.exports).toEqual({
        default: 'signal',
      })
      expect(moduleMetadata.get(path.resolve(memoForwardPath))?.exports).toEqual({
        default: 'memo',
      })
      expect(moduleMetadata.get(path.resolve(storeForwardPath))?.exports).toEqual({
        default: 'store',
      })
      expect(moduleMetadata.get(path.resolve(dynamicForwardPath))?.exports).toEqual({})

      const consumerOutput = transform(
        `
          import count from './reactive-namespace-default-signal'
          import state from './reactive-namespace-default-store'

          export function App() {
            return <div>{count}{state.total}</div>
          }
        `,
        { fineGrainedDom: true, moduleMetadata },
        consumerPath,
      )

      expect(consumerOutput).toMatch(/count\(\)/)
      expect(consumerOutput).toMatch(/state\.total/)
    })

    it('keeps computed identifier runtime creator calls out of default export metadata', () => {
      const directPath = path.join(baseDir, 'runtime-default-direct.ts')
      const literalPath = path.join(baseDir, 'runtime-default-literal.ts')
      const dynamicSignalPath = path.join(baseDir, 'runtime-default-dynamic-signal.ts')
      const dynamicMemoPath = path.join(baseDir, 'runtime-default-dynamic-memo.ts')
      const dynamicStorePath = path.join(baseDir, 'runtime-default-dynamic-store.ts')
      const consumerPath = path.join(baseDir, 'runtime-default-dynamic-consumer.tsx')
      const moduleMetadata = new Map()

      transform(
        `
          import * as runtime from 'fict/advanced'
          export default runtime.createSignal(1)
        `,
        { moduleMetadata },
        directPath,
      )
      transform(
        `
          import * as runtime from 'fict/advanced'
          export default runtime['createMemo'](() => 1)
        `,
        { moduleMetadata },
        literalPath,
      )
      transform(
        `
          import * as runtime from 'fict/advanced'
          const createSignal = 'createEffect'
          export default runtime[createSignal](() => 1)
        `,
        { moduleMetadata },
        dynamicSignalPath,
      )
      transform(
        `
          import * as runtime from 'fict/advanced'
          const createMemo = 'createEffect'
          export default runtime[createMemo](() => 1)
        `,
        { moduleMetadata },
        dynamicMemoPath,
      )
      transform(
        `
          import * as runtime from 'fict/advanced'
          const createStore = 'createEffect'
          export default runtime[createStore](() => 1)
        `,
        { moduleMetadata },
        dynamicStorePath,
      )

      expect(moduleMetadata.get(path.resolve(directPath))?.exports).toEqual({
        default: 'signal',
      })
      expect(moduleMetadata.get(path.resolve(literalPath))?.exports).toEqual({
        default: 'memo',
      })
      expect(moduleMetadata.get(path.resolve(dynamicSignalPath))?.exports).toEqual({})
      expect(moduleMetadata.get(path.resolve(dynamicMemoPath))?.exports).toEqual({})
      expect(moduleMetadata.get(path.resolve(dynamicStorePath))?.exports).toEqual({})

      const consumerOutput = transform(
        `
          import value from './runtime-default-dynamic-signal'

          export function App() {
            return <div>{value}</div>
          }
        `,
        { fineGrainedDom: true, moduleMetadata },
        consumerPath,
      )

      expect(consumerOutput).not.toMatch(/value\(\)/)
    })

    it('publishes direct default namespace hook metadata', () => {
      const sourcePath = path.join(baseDir, 'reactive-namespace-default-hook-source.ts')
      const forwardPath = path.join(baseDir, 'reactive-namespace-default-hook.ts')
      const computedForwardPath = path.join(baseDir, 'reactive-namespace-default-hook-computed.ts')
      const consumerPath = path.join(baseDir, 'reactive-namespace-default-hook-consumer.tsx')
      const hookInfo = { objectProps: { count: 'signal' as const, doubled: 'memo' as const } }
      const moduleMetadata = new Map()
      moduleMetadata.set(path.resolve(sourcePath), {
        version: 1,
        exports: {},
        hooks: {
          useCounter: hookInfo,
        },
      })

      transform(
        `
          import * as hooks from './reactive-namespace-default-hook-source'
          export default hooks.useCounter
        `,
        { moduleMetadata },
        forwardPath,
      )
      transform(
        `
          import * as hooks from './reactive-namespace-default-hook-source'
          export default hooks['useCounter']
        `,
        { moduleMetadata },
        computedForwardPath,
      )

      expect(moduleMetadata.get(path.resolve(forwardPath))?.hooks).toMatchObject({
        default: hookInfo,
      })
      expect(moduleMetadata.get(path.resolve(computedForwardPath))?.hooks).toMatchObject({
        default: hookInfo,
      })

      const consumerOutput = transform(
        `
          import useCounter from './reactive-namespace-default-hook'

          export function App() {
            const state = useCounter()
            return <div>{state.count}{state.doubled}</div>
          }
        `,
        { fineGrainedDom: true, moduleMetadata },
        consumerPath,
      )

      expect(consumerOutput).toMatch(/state\.count\(\)/)
      expect(consumerOutput).toMatch(/state\.doubled\(\)/)
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
        useObject: { objectProps: { count: 'signal', doubled: 'memo', state: 'store' } },
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
        useObject: { objectProps: { count: 'signal', doubled: 'memo', state: 'store' } },
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

    it('publishes and consumes store-valued hook returns', () => {
      const hookPath = path.join(baseDir, 'store-hook-returns.tsx')
      const appPath = path.join(baseDir, 'store-hook-consumer.tsx')
      const localPath = path.join(baseDir, 'store-hook-same-file.tsx')
      const moduleMetadata = new Map()
      const hookSource = `
        import { $memo, $state, $store } from 'fict'

        export function useUser() {
          const user = $store({ name: 'Ada' })
          return user
        }

        export function useObjectUser() {
          const user = $store({ name: 'Ada' })
          return { user }
        }

        export function useArrayUser() {
          const user = $store({ name: 'Ada' })
          return [user]
        }

        export function useMixed() {
          const count = $state(0)
          const user = $store({ name: 'Ada' })
          const doubled = $memo(() => count() * 2)
          return { count, user, doubled }
        }

        export function usePlain() {
          return { user: { name: 'Plain' } }
        }
      `
      const appSource = `
        import { useArrayUser, useMixed, useObjectUser, usePlain, useUser } from './store-hook-returns'

        export function App() {
          const direct = useUser()
          const { user: objectUser } = useObjectUser()
          const [arrayUser] = useArrayUser()
          const { count, user: mixedUser, doubled } = useMixed()
          const plain = usePlain()
          return <div>{direct.name}{objectUser.name}{arrayUser.name}{mixedUser.name}{count}{doubled}{plain.user.name}</div>
        }
      `
      const localSource = `
        import { $store } from 'fict'

        function useUser() {
          const user = $store({ name: 'Ada' })
          return user
        }

        export function App() {
          const direct = useUser()
          return <div>{direct.name}</div>
        }
      `

      transform(hookSource, { moduleMetadata }, hookPath)

      expect(moduleMetadata.get(path.resolve(hookPath))?.hooks).toMatchObject({
        useUser: { directAccessor: 'store' },
        useObjectUser: { objectProps: { user: 'store' } },
        useArrayUser: { arrayProps: { 0: 'store' } },
        useMixed: { objectProps: { count: 'signal', user: 'store', doubled: 'memo' } },
      })
      expect(moduleMetadata.get(path.resolve(hookPath))?.hooks).not.toHaveProperty('usePlain')

      const appOutput = transform(appSource, { fineGrainedDom: true, moduleMetadata }, appPath)

      expect(appOutput).toMatch(/direct\.name/)
      expect(appOutput).toMatch(/objectUser\.name/)
      expect(appOutput).toMatch(/arrayUser\.name/)
      expect(appOutput).toMatch(/mixedUser\.name/)
      expect(appOutput).toMatch(/count\(\)/)
      expect(appOutput).toMatch(/doubled\(\)/)
      expect(appOutput).toMatch(/plain\.user\.name/)
      expect(appOutput).not.toMatch(/(?:direct|objectUser|arrayUser|mixedUser)\.name\(\)/)
      expect(appOutput).not.toMatch(/plain\.user\.name\(\)/)

      const localOutput = transform(localSource, { fineGrainedDom: true }, localPath)

      expect(localOutput).toMatch(/direct\.name/)
      expect(localOutput).not.toMatch(/direct\.name\(\)/)
    })

    it('propagates store hook metadata through namespace wrappers', () => {
      const sourcePath = path.join(baseDir, 'namespace-store-hook-source.tsx')
      const wrapperPath = path.join(baseDir, 'namespace-store-hook-wrapper.ts')
      const appPath = path.join(baseDir, 'namespace-store-hook-consumer.tsx')
      const moduleMetadata = new Map()
      const source = `
        import { $store } from 'fict'

        export function useUser() {
          const user = $store({ name: 'Ada' })
          return user
        }
      `
      const wrapper = `
        import * as hooks from './namespace-store-hook-source'

        export function useWrapped() {
          return hooks.useUser()
        }

        export function useOptionalWrapped() {
          return hooks.useUser?.()
        }

        export function useObjectWrapped() {
          return { user: hooks.useUser() }
        }
      `
      const app = `
        import { useObjectWrapped, useOptionalWrapped, useWrapped } from './namespace-store-hook-wrapper'

        export function App() {
          const direct = useWrapped()
          const optional = useOptionalWrapped()
          const { user } = useObjectWrapped()
          return <div>{direct.name}{optional.name}{user.name}</div>
        }
      `

      transform(source, { moduleMetadata }, sourcePath)
      transform(wrapper, { moduleMetadata }, wrapperPath)

      expect(moduleMetadata.get(path.resolve(wrapperPath))?.hooks).toMatchObject({
        useWrapped: { directAccessor: 'store' },
        useOptionalWrapped: { directAccessor: 'store' },
        useObjectWrapped: { objectProps: { user: 'store' } },
      })

      const output = transform(app, { fineGrainedDom: true, moduleMetadata }, appPath)

      expect(output).toMatch(/direct\.name/)
      expect(output).toMatch(/optional\.name/)
      expect(output).toMatch(/user\.name/)
      expect(output).not.toMatch(/(?:direct|optional|user)\.name\(\)/)
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

    it('does not unwrap namespace members when nested bindings shadow namespace imports', () => {
      const storeSource = `
        import { createSignal } from 'fict/advanced'
        export const count = createSignal(1)
      `
      const moduleMetadata = new Map()
      transform(storeSource, { moduleMetadata }, path.join(baseDir, 'store-ns-shadow.ts'))

      const cases = [
        {
          name: 'arrow param',
          source: `
            export function App() {
              const read = store => store.count
              return read({ count: 1 }) + store.count
            }
          `,
          inner: /\(store => store\.count\)\(\{/,
          forbidden: /store => store\.count\(\)/,
          outer: /store\.count\(\)/,
        },
        {
          name: 'function expression param',
          source: `
            export function App() {
              const read = function (store) {
                return store.count
              }
              return read({ count: 2 }) + store.count
            }
          `,
          inner: /function \(store\) {\s*return store\.count;\s*}/s,
          forbidden: /function \(store\) {\s*return store\.count\(\);/s,
          outer: /store\.count\(\)/,
        },
        {
          name: 'function declaration param',
          source: `
            export function App() {
              function read(store) {
                return store.count
              }
              return read({ count: 3 }) + store.count
            }
          `,
          inner: /function read\(store\) {\s*return store\.count;\s*}/s,
          forbidden: /function read\(store\) {\s*return store\.count\(\);/s,
          outer: /store\.count\(\)/,
        },
        {
          name: 'destructured param',
          source: `
            export function App() {
              const read = ({ store }) => store.count
              return read({ store: { count: 4 } }) + store.count
            }
          `,
          inner: /\(\{\s*store\s*\}\) => store\.count/,
          forbidden: /\(\{\s*store\s*\}\) => store\.count\(\)/,
          outer: /store\.count\(\)/,
        },
        {
          name: 'computed static property',
          source: `
            export function App() {
              const read = store => store["count"]
              return read({ count: 5 }) + store["count"]
            }
          `,
          inner: /store => store\["count"\]/,
          forbidden: /store => store\["count"\]\(\)/,
          outer: /store\["count"\]\(\)/,
        },
        {
          name: 'catch param',
          source: `
            export function App() {
              const read = input => {
                try {
                  throw input
                } catch (store) {
                  return store.count
                }
              }
              return read({ count: 6 }) + store.count
            }
          `,
          inner: /catch \(store\) {\s*return store\.count;\s*}/s,
          forbidden: /catch \(store\) {\s*return store\.count\(\);/s,
          outer: /store\.count\(\)/,
        },
        {
          name: 'block local',
          source: `
            export function App() {
              const read = () => {
                {
                  const store = { count: 7 }
                  return store.count
                }
              }
              return read() + store.count
            }
          `,
          inner: /const store = {\s*count: 7\s*};\s*return store\.count;/s,
          forbidden: /const store = {\s*count: 7\s*};\s*return store\.count\(\);/s,
          outer: /store\.count\(\)/,
        },
      ] as const

      for (const scenario of cases) {
        const output = transform(
          `
            import * as store from './store-ns-shadow'
            ${scenario.source}
          `,
          { moduleMetadata },
          path.join(baseDir, `app-ns-shadow-${scenario.name.replace(/ /g, '-')}.tsx`),
        )

        expect(output, scenario.name).toMatch(scenario.inner)
        expect(output, scenario.name).not.toMatch(scenario.forbidden)
        expect(output, scenario.name).toMatch(scenario.outer)
      }
    })

    it('still unwraps unshadowed namespace members inside nested functions', () => {
      const storeSource = `
        import { createSignal } from 'fict/advanced'
        export const count = createSignal(1)
      `
      const appSource = `
        import * as store from './store-ns-unshadowed-nested'

        export function App() {
          const read = () => store.count
          return read() + store["count"]
        }
      `

      const moduleMetadata = new Map()
      transform(
        storeSource,
        { moduleMetadata },
        path.join(baseDir, 'store-ns-unshadowed-nested.ts'),
      )
      const output = transform(
        appSource,
        { moduleMetadata },
        path.join(baseDir, 'app-ns-unshadowed-nested.tsx'),
      )

      expect(output).toMatch(/return \(\(\) => store\.count\(\)\)\(\) \+ store\["count"\]\(\);/)
    })

    it('preserves delete targets for namespace reactive members', () => {
      const storeSource = `
        import { createMemo, createSignal } from 'fict/advanced'
        export const count = createSignal(1)
        export const total = createMemo(() => count() * 2)
        export const plain = 1
      `
      const appSource = `
        import * as store from './store-ns-delete'

        export function App() {
          const signalRemoved = delete store.count
          const memoRemoved = delete store.total
          const computedRemoved = delete store["count"]
          const plainRemoved = delete store.plain
          return <div>{signalRemoved}{memoRemoved}{computedRemoved}{plainRemoved}{store.count}{store.total}</div>
        }
      `

      const moduleMetadata = new Map()
      transform(storeSource, { moduleMetadata }, path.join(baseDir, 'store-ns-delete.ts'))

      const output = transform(
        appSource,
        { fineGrainedDom: true, moduleMetadata, strictGuarantee: false },
        path.join(baseDir, 'app-ns-delete-false.tsx'),
      )

      expect(output).toContain('delete store.count')
      expect(output).toContain('delete store.total')
      expect(output).toContain('delete store["count"]')
      expect(output).toContain('delete store.plain')
      expect(output).not.toContain('delete store.count()')
      expect(output).not.toContain('delete store.total()')
      expect(output).not.toContain('delete store["count"]()')
      expect(output).toContain('store.count()')
      expect(output).toContain('store.total()')

      expect(() =>
        transform(
          appSource,
          { fineGrainedDom: true, moduleMetadata, strictGuarantee: true },
          path.join(baseDir, 'app-ns-delete-true.tsx'),
        ),
      ).toThrow(/FICT-M/)
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
