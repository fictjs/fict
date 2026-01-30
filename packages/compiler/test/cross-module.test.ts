import { existsSync, mkdirSync, rmSync } from 'node:fs'
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
  })
})
