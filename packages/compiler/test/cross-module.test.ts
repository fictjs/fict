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
