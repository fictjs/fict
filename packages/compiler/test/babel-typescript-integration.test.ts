import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { transformSync, types as t, type PluginObj } from '@babel/core'
import * as runtimeAdvanced from '@fictjs/runtime/advanced'
import { describe, expect, it } from 'vitest'

import fictPreset from '../../babel-preset/src'

function compilePresetModule(source: string, filename: string): string {
  const result = transformSync(source, {
    filename,
    configFile: false,
    babelrc: false,
    plugins: ['@babel/plugin-transform-modules-commonjs'],
    presets: [
      [
        fictPreset,
        {
          dev: false,
          strictGuarantee: true,
          emitModuleMetadata: false,
        },
      ],
    ],
  })
  return result?.code ?? ''
}

function evaluateCommonJs(
  code: string,
  resolve: (source: string) => Record<string, unknown>,
): Record<string, unknown> {
  const module = { exports: {} as Record<string, unknown> }
  const run = new Function('require', 'module', 'exports', code)
  run(resolve, module, module.exports)
  return module.exports
}

describe('@fictjs/babel-preset TypeScript integration', () => {
  const reactiveComponent = `
    import { $state } from 'fict'
    export function App() {
      const value = $state(1)
      return <div>{value}</div>
    }
  `

  it('prepares local hook metadata before a clean importer-first runtime build', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-clean-'))
    const hookPath = path.join(baseDir, 'use-count.cts')
    const appPath = path.join(baseDir, 'app.ts')
    const hookSource = `
      import { createSignal } from '@fictjs/runtime/advanced'

      enum Seed { Count = 2 }
      namespace Defaults { export const count = Seed.Count }
      class Model {
        declare count: number
        current = Defaults.count
      }

      export function useCount() {
        const count = createSignal(new Model().current)
        return count
      }
    `
    const appSource = `
      import { useCount } from './use-count.cts'
      export function App() {
        const count = useCount()
        return count * 2
      }
    `

    try {
      writeFileSync(hookPath, hookSource)
      writeFileSync(appPath, appSource)

      const appOutput = compilePresetModule(appSource, appPath)
      expect(appOutput).toMatch(/count\(\)\s*\*\s*2/)

      const hookModule = evaluateCommonJs(compilePresetModule(hookSource, hookPath), source => {
        if (source === '@fictjs/runtime/advanced') return runtimeAdvanced
        throw new Error(`Unexpected hook dependency: ${source}`)
      })
      const appModule = evaluateCommonJs(appOutput, source => {
        if (source === './use-count.cts') return hookModule
        throw new Error(`Unexpected app dependency: ${source}`)
      })

      expect((appModule.App as () => number)()).toBe(4)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it.each([
    ['use-count#physical.ts', './use-count#physical.ts'],
    ['use-count?physical.ts', './use-count?physical.ts'],
    ['use-count#extensionless.ts', './use-count#extensionless'],
    ['use-count?extensionless.ts', './use-count?extensionless'],
  ])('prepares hook metadata from the physical module %s via %s', (hookName, specifier) => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-url-name-'))
    const hookPath = path.join(baseDir, hookName)
    const appPath = path.join(baseDir, 'app.ts')
    const hookSource = `
        import { createSignal } from '@fictjs/runtime/advanced'
        export function useCount() {
          const count = createSignal(2)
          return count
        }
      `
    const appSource = `
        import { useCount } from ${JSON.stringify(specifier)}
        export function App() {
          const count = useCount()
          return count * 2
        }
      `

    try {
      writeFileSync(hookPath, hookSource)
      writeFileSync(appPath, appSource)

      const appOutput = compilePresetModule(appSource, appPath)
      expect(appOutput).toMatch(/count\(\)\s*\*\s*2/)

      const hookModule = evaluateCommonJs(compilePresetModule(hookSource, hookPath), source => {
        if (source === '@fictjs/runtime/advanced') return runtimeAdvanced
        throw new Error(`Unexpected hook dependency: ${source}`)
      })
      const appModule = evaluateCommonJs(appOutput, source => {
        if (source === specifier) return hookModule
        throw new Error(`Unexpected app dependency: ${source}`)
      })

      expect((appModule.App as () => number)()).toBe(4)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it.each([
    ['use-count#physical.ts', '%23physical.ts'],
    ['use-count?physical.ts', '%3Fphysical.ts'],
  ])('keeps file URL suffixes distinct from the encoded filename %s', (hookName, encodedName) => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-file-url-'))
    const hookPath = path.join(baseDir, hookName)
    const appPath = path.join(baseDir, 'app.ts')
    const hookUrl = pathToFileURL(hookPath).href
    const hookSource = `
      import { createSignal } from '@fictjs/runtime/advanced'
      export function useCount() {
        const count = createSignal(2)
        return count
      }
    `
    const appSource = (source: string) => `
      import { useCount } from ${JSON.stringify(source)}
      export function App() {
        const count = useCount()
        return count * 2
      }
    `

    try {
      writeFileSync(hookPath, hookSource)
      writeFileSync(appPath, appSource(hookUrl))

      const moduleOutput = compilePresetModule(appSource(hookUrl), appPath)
      const resourceOutput = compilePresetModule(appSource(`${hookUrl}?raw`), appPath)

      expect(hookUrl).toContain(encodedName)
      expect(moduleOutput).toMatch(/count\(\)\s*\*\s*2/)
      expect(resourceOutput).toMatch(/count\s*\*\s*2/)
      expect(resourceOutput).not.toMatch(/count\(\)\s*\*\s*2/)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('prepares CTS export-assignment metadata before an import-equals importer', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-cts-assignment-'))
    const hookPath = path.join(baseDir, 'use-count.cts')
    const appPath = path.join(baseDir, 'app.cts')
    const hookSource = `
      import { createSignal } from '@fictjs/runtime/advanced'
      function useCount() {
        const count = createSignal(2)
        return count
      }
      export = useCount
    `
    const appSource = `
      import useCount = require('./use-count.cts')
      export function App() {
        const count = useCount()
        return count * 2
      }
    `

    try {
      writeFileSync(hookPath, hookSource)
      writeFileSync(appPath, appSource)

      transformSync(hookSource, {
        filename: hookPath,
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: true, emitModuleMetadata: true }]],
      })
      const emittedMetadata = JSON.parse(readFileSync(`${hookPath}.fict.meta.json`, 'utf8')) as {
        hooks?: Record<string, { directAccessor?: string }>
      }
      expect(emittedMetadata.hooks?.default?.directAccessor).toBe('signal')

      const appOutput = compilePresetModule(appSource, appPath)
      expect(appOutput).toMatch(/count\(\)\s*\*\s*2/)

      const hookOutput = compilePresetModule(hookSource, hookPath)
      expect(hookOutput).toContain('module.exports =')
      const hookModule = evaluateCommonJs(hookOutput, source => {
        if (source === '@fictjs/runtime/advanced') return runtimeAdvanced
        throw new Error(`Unexpected hook dependency: ${source}`)
      })
      const appModule = evaluateCommonJs(appOutput, source => {
        if (source === './use-count.cts') return hookModule
        throw new Error(`Unexpected app dependency: ${source}`)
      })

      expect((appModule.App as () => number)()).toBe(4)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('invalidates transitive hook metadata when an unchanged barrel points at changed source', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-stale-'))
    const hookPath = path.join(baseDir, 'use-count.ts')
    const barrelPath = path.join(baseDir, 'barrel.ts')
    const appPath = path.join(baseDir, 'app.ts')
    const signalHookSource = `
      import { createSignal } from '@fictjs/runtime/advanced'
      export function useCount() {
        const count = createSignal(2)
        return count
      }
    `
    const plainHookSource = `
      export function useCount() {
        return 3
      }
    `
    const barrelSource = `export { useCount } from './use-count'`
    const appSource = `
      import { useCount } from './barrel'
      export function App() {
        const count = useCount()
        return count * 2
      }
    `
    const loadRuntime = (appOutput: string, hookSource: string): (() => number) => {
      const hookModule = evaluateCommonJs(compilePresetModule(hookSource, hookPath), source => {
        if (source === '@fictjs/runtime/advanced') return runtimeAdvanced
        throw new Error(`Unexpected hook dependency: ${source}`)
      })
      const barrelModule = evaluateCommonJs(
        compilePresetModule(barrelSource, barrelPath),
        source => {
          if (source === './use-count') return hookModule
          throw new Error(`Unexpected barrel dependency: ${source}`)
        },
      )
      const appModule = evaluateCommonJs(appOutput, source => {
        if (source === './barrel') return barrelModule
        throw new Error(`Unexpected app dependency: ${source}`)
      })
      return appModule.App as () => number
    }

    try {
      writeFileSync(hookPath, signalHookSource)
      writeFileSync(barrelPath, barrelSource)
      writeFileSync(appPath, appSource)

      const signalOutput = compilePresetModule(appSource, appPath)
      expect(signalOutput).toMatch(/count\(\)\s*\*\s*2/)
      expect(loadRuntime(signalOutput, signalHookSource)()).toBe(4)

      writeFileSync(hookPath, plainHookSource)
      const plainOutput = compilePresetModule(appSource, appPath)
      expect(plainOutput).toMatch(/count\s*\*\s*2/)
      expect(plainOutput).not.toMatch(/count\(\)\s*\*\s*2/)
      expect(loadRuntime(plainOutput, plainHookSource)()).toBe(6)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('keeps a freshly analyzed ordinary imported use function plain', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-plain-'))
    const hookPath = path.join(baseDir, 'use-value.ts')
    const appPath = path.join(baseDir, 'app.ts')
    const hookSource = `export function useValue() { return 5 }`
    const appSource = `
      import { useValue } from './use-value'
      export function App() {
        const value = useValue()
        return value * 2
      }
    `

    try {
      writeFileSync(hookPath, hookSource)
      writeFileSync(appPath, appSource)
      const appOutput = compilePresetModule(appSource, appPath)
      expect(appOutput).toMatch(/value\s*\*\s*2/)
      expect(appOutput).not.toMatch(/value\(\)\s*\*\s*2/)

      const hookModule = evaluateCommonJs(compilePresetModule(hookSource, hookPath), source => {
        throw new Error(`Unexpected hook dependency: ${source}`)
      })
      const appModule = evaluateCommonJs(appOutput, source => {
        if (source === './use-value') return hookModule
        throw new Error(`Unexpected app dependency: ${source}`)
      })
      expect((appModule.App as () => number)()).toBe(10)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('keeps resource-query hook imports opaque instead of reading the source module', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-resource-'))
    const hookPath = path.join(baseDir, 'use-count.ts')
    const appPath = path.join(baseDir, 'app.ts')
    const hookSource = `
      import { createSignal } from '@fictjs/runtime/advanced'
      export function useCount() {
        const count = createSignal(2)
        return count
      }
    `
    const appSource = `
      import { useCount } from './use-count.ts?raw'
      export function App() {
        const value = useCount()
        return value * 2
      }
    `

    try {
      writeFileSync(hookPath, hookSource)
      writeFileSync(appPath, appSource)
      const output = compilePresetModule(appSource, appPath)

      expect(output).toMatch(/value\s*\*\s*2/)
      expect(output).not.toMatch(/value\(\)\s*\*\s*2/)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it.each(['use-count#physical.ts', 'use-count?physical.ts'])(
    'keeps a resource suffix opaque after the physical module %s',
    hookName => {
      const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-url-resource-'))
      const hookPath = path.join(baseDir, hookName)
      const appPath = path.join(baseDir, 'app.ts')
      const hookSource = `
        import { createSignal } from '@fictjs/runtime/advanced'
        export function useCount() {
          const count = createSignal(2)
          return count
        }
      `
      const appSource = `
        import { useCount } from ${JSON.stringify(`./${hookName}?raw`)}
        export function App() {
          const value = useCount()
          return value * 2
        }
      `

      try {
        writeFileSync(hookPath, hookSource)
        writeFileSync(appPath, appSource)
        const output = compilePresetModule(appSource, appPath)

        expect(output).toMatch(/value\s*\*\s*2/)
        expect(output).not.toMatch(/value\(\)\s*\*\s*2/)
      } finally {
        rmSync(baseDir, { recursive: true, force: true })
      }
    },
  )

  it('keeps bare resource-query imports opaque even when package metadata exists', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-package-resource-'))
    const packageDir = path.join(baseDir, 'node_modules', 'fict-hook-lib')
    const metadataPath = path.join(packageDir, 'dist', 'index.fict.meta.json')
    const appPath = path.join(baseDir, 'app.ts')
    const appSource = `
      import { useCount } from 'fict-hook-lib?raw'
      export function App() {
        const value = useCount()
        return value * 2
      }
    `

    try {
      mkdirSync(path.dirname(metadataPath), { recursive: true })
      writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'fict-hook-lib',
          fict: { metadata: './dist/index.fict.meta.json' },
        }),
      )
      writeFileSync(
        metadataPath,
        JSON.stringify({ exports: {}, hooks: { useCount: { directAccessor: 'signal' } } }),
      )
      writeFileSync(appPath, appSource)

      const output = compilePresetModule(appSource, appPath)
      expect(output).toMatch(/value\s*\*\s*2/)
      expect(output).not.toMatch(/value\(\)\s*\*\s*2/)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('leaves explicit non-code local imports for the bundler instead of parsing their files', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-assets-'))
    const stylePath = path.join(baseDir, 'styles.css')
    const dataPath = path.join(baseDir, 'data.json')
    const appPath = path.join(baseDir, 'app.ts')
    const appSource = `
      import './styles.css'
      import data from './data.json'
      export const answer = data.answer
    `

    try {
      writeFileSync(stylePath, `.root { color: red; }`)
      writeFileSync(dataPath, JSON.stringify({ answer: 42 }))
      writeFileSync(appPath, appSource)

      const output = compilePresetModule(appSource, appPath)
      expect(output).toContain('require("./styles.css")')
      expect(output).toContain('require("./data.json")')
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('fails closed for a hook-like import from an unsupported local file type', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-unsupported-'))
    const hookPath = path.join(baseDir, 'use-count.vue')
    const appPath = path.join(baseDir, 'app.ts')
    const appSource = `
      import { useCount } from './use-count.vue'
      export function App() { return useCount() * 2 }
    `

    try {
      writeFileSync(hookPath, `<script setup lang="ts">const count = 1</script>`)
      writeFileSync(appPath, appSource)

      expect(() => compilePresetModule(appSource, appPath)).toThrow(/FICT-H003/)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('uses authoritative sidecar metadata for an unsupported local file type', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-unsupported-sidecar-'))
    const hookPath = path.join(baseDir, 'use-count.vue')
    const metadataPath = `${hookPath}.fict.meta.json`
    const appPath = path.join(baseDir, 'app.ts')
    const appSource = `
      import { useCount } from './use-count.vue'
      export function App() {
        const value = useCount()
        return value * 2
      }
    `

    try {
      writeFileSync(hookPath, `<script setup lang="ts">const count = 1</script>`)
      writeFileSync(
        metadataPath,
        JSON.stringify({ exports: {}, hooks: { useCount: { directAccessor: 'signal' } } }),
      )
      writeFileSync(appPath, appSource)

      const output = compilePresetModule(appSource, appPath)
      expect(output).toMatch(/value\(\)\s*\*\s*2/)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('resolves local hash-suffixed hook imports through the current source graph', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-fragment-'))
    const hookPath = path.join(baseDir, 'use-count.ts')
    const appPath = path.join(baseDir, 'app.ts')
    const hookSource = `
      import { createSignal } from '@fictjs/runtime/advanced'
      export function useCount() {
        const count = createSignal(2)
        return count
      }
    `
    const appSource = `
      import { useCount } from './use-count#fragment'
      export function App() {
        const value = useCount()
        return value * 2
      }
    `

    try {
      writeFileSync(hookPath, hookSource)
      writeFileSync(appPath, appSource)
      const output = compilePresetModule(appSource, appPath)

      expect(output).toMatch(/value\(\)\s*\*\s*2/)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('fails closed when a local hook metadata cycle cannot converge', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-cycle-'))
    const firstPath = path.join(baseDir, 'use-first.ts')
    const secondPath = path.join(baseDir, 'use-second.ts')
    const appPath = path.join(baseDir, 'app.ts')
    const firstSource = `
      import { useSecond } from './use-second'
      export function useFirst() { return useSecond() }
    `
    const secondSource = `
      import { useFirst } from './use-first'
      export function useSecond() { return useFirst() }
    `
    const appSource = `
      import { useFirst } from './use-first'
      export function App() { return useFirst() }
    `

    try {
      writeFileSync(firstPath, firstSource)
      writeFileSync(secondPath, secondSource)
      writeFileSync(appPath, appSource)

      expect(() => compilePresetModule(appSource, appPath)).toThrow(/FICT-H003/)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('canonicalizes symlinked graph identities before detecting a local hook cycle', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-symlink-cycle-'))
    const modulePath = path.join(baseDir, 'module.ts')
    const loopPath = path.join(baseDir, 'loop')
    const source = `
      import { useCount as useLoopCount } from './loop/module'
      export function useCount() { return useLoopCount() }
    `

    try {
      writeFileSync(modulePath, source)
      symlinkSync('.', loopPath, 'dir')

      expect(() => compilePresetModule(source, modulePath)).toThrow(/FICT-H003/)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('preserves callable-object CTS import-equals while analyzing named hook members', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-cts-callable-object-'))
    const packageDir = path.join(baseDir, 'node_modules', 'callable-hook')
    const appPath = path.join(baseDir, 'app.cts')
    const appSource = `
      import hook = require('callable-hook')

      export function App() {
        const direct = hook()
        const member = hook.useCounter()
        return direct * 10 + member
      }
    `

    try {
      mkdirSync(packageDir, { recursive: true })
      writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'callable-hook',
          version: '1.0.0',
          exports: { '.': './index.cjs' },
          fict: { metadata: './index.fict.meta.json' },
        }),
      )
      writeFileSync(path.join(packageDir, 'index.cjs'), 'module.exports = function hook() {}')
      writeFileSync(
        path.join(packageDir, 'index.fict.meta.json'),
        JSON.stringify({
          version: 1,
          exports: {},
          hooks: {
            default: { directAccessor: 'signal' },
            useCounter: { directAccessor: 'signal' },
          },
        }),
      )
      writeFileSync(appPath, appSource)

      const output = compilePresetModule(appSource, appPath)
      expect(output).toMatch(/direct\(\)\s*\*\s*10/)
      expect(output).toMatch(/\+\s*member\(\)/)
      expect(output.match(/require\(["']callable-hook["']\)/g)).toHaveLength(1)

      let requireCalls = 0
      const callableHook = Object.assign(() => () => 2, { useCounter: () => () => 3 })
      const appModule = evaluateCommonJs(output, source => {
        if (source !== 'callable-hook') throw new Error(`Unexpected dependency: ${source}`)
        requireCalls++
        return callableHook as unknown as Record<string, unknown>
      })

      expect((appModule.App as () => number)()).toBe(23)
      expect(requireCalls).toBe(1)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('does not apply the CommonJS import-equals bridge to MTS modules', () => {
    expect(() =>
      transformSync(`import hook = require('callable-hook'); export default hook`, {
        filename: 'entry.mts',
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
      }),
    ).toThrow(/import .*require|import equals|not supported/i)
  })

  it.each([
    `export { useCount } from '@/hook'`,
    `export * from '@/hook'`,
    `import { useCount } from '@/hook'; export { useCount }`,
  ])('fails closed when an unresolved re-export would publish empty metadata', barrelSource => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-reexport-'))
    const barrelPath = path.join(baseDir, 'barrel.ts')
    const appPath = path.join(baseDir, 'app.ts')
    const appSource = `
      import { useCount } from './barrel'
      export function App() {
        const count = useCount()
        return count * 2
      }
    `

    try {
      writeFileSync(barrelPath, barrelSource)
      writeFileSync(appPath, appSource)
      expect(() => compilePresetModule(appSource, appPath)).toThrow(/FICT-H003/)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it.each([
    `export { foo as default } from '@/hook'`,
    `import { foo } from '@/hook'; export { foo as default }`,
    `import { foo } from '@/hook'; const value = foo; export { value as default }`,
  ])(
    'keeps an ordinary unresolved default re-export incomplete for hook-named consumers',
    barrelSource => {
      const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-default-reexport-'))
      const barrelPath = path.join(baseDir, 'barrel.ts')
      const appPath = path.join(baseDir, 'app.ts')
      const appSource = `
      import useCount from './barrel'
      export function App() {
        const value = useCount()
        return value * 2
      }
    `

      try {
        writeFileSync(barrelPath, barrelSource)
        writeFileSync(appPath, appSource)
        expect(() => compilePresetModule(appSource, appPath)).toThrow(/FICT-H003/)
      } finally {
        rmSync(baseDir, { recursive: true, force: true })
      }
    },
  )

  it.each([
    `const useCount = foo; export function App() { return useCount() * 2 }`,
    `const hooks = { useCount: foo }; export function App() { return hooks.useCount() * 2 }`,
  ])('tracks an ordinary unresolved import into a hook-like static alias', usage => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-graph-static-alias-'))
    const barrelPath = path.join(baseDir, 'barrel.ts')
    const appPath = path.join(baseDir, 'app.ts')
    const barrelSource = `export { foo } from '@/hook'`
    const appSource = `import { foo } from './barrel'; ${usage}`

    try {
      writeFileSync(barrelPath, barrelSource)
      writeFileSync(appPath, appSource)
      expect(() => compilePresetModule(appSource, appPath)).toThrow(/FICT-H003/)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('tracks an unresolved namespace member into a hook-like static alias', () => {
    expect(() =>
      transformSync(
        `
          import * as api from '@/hook'
          const useCount = api.foo
          export function App() { return useCount() * 2 }
        `,
        {
          filename: path.resolve('namespace-member-hook-alias.ts'),
          configFile: false,
          babelrc: false,
          presets: [[fictPreset, { dev: false, strictGuarantee: true, emitModuleMetadata: false }]],
        },
      ),
    ).toThrow(/FICT-H003/)
  })

  it('fails closed when an unresolved imported hook escapes through an object alias', () => {
    expect(() =>
      transformSync(
        `
          import { useCount } from '@/hook'
          const hooks = { useCount }
          export function App() { return hooks.useCount() * 2 }
        `,
        {
          filename: path.resolve('escaped-hook-alias.ts'),
          configFile: false,
          babelrc: false,
          presets: [
            [
              fictPreset,
              {
                dev: false,
                strictGuarantee: true,
                emitModuleMetadata: false,
              },
            ],
          ],
        },
      ),
    ).toThrow(/FICT-H003/)
  })

  it('keeps authoritative builtins and ordinary unresolved re-exports compatible', () => {
    const named = transformSync(`export { join } from 'node:path'`, {
      filename: path.resolve('ordinary-named-reexport.ts'),
      configFile: false,
      babelrc: false,
      presets: [[fictPreset, { dev: false, strictGuarantee: true, emitModuleMetadata: false }]],
    })
    const star = transformSync(`export * from 'ordinary-utility-package'`, {
      filename: path.resolve('ordinary-star-reexport.ts'),
      configFile: false,
      babelrc: false,
      presets: [[fictPreset, { dev: false, strictGuarantee: true, emitModuleMetadata: false }]],
    })
    const prefixedOnlyBuiltin = transformSync(
      `import { test as useTest } from 'node:test'; export function App() { return useTest('case', () => {}) }`,
      {
        filename: path.resolve('prefixed-only-node-builtin.ts'),
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: true, emitModuleMetadata: false }]],
      },
    )

    expect(named?.code).toContain(`export { join } from 'node:path'`)
    expect(star?.code).toContain(`export * from 'ordinary-utility-package'`)
    expect(prefixedOnlyBuiltin?.code).toMatch(/useTest\(["']case["']/)
  })

  it('preserves local hook metadata beside an ordinary unresolved named re-export', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-named-reexport-hook-'))
    const barrelPath = path.join(baseDir, 'barrel.ts')
    const appPath = path.join(baseDir, 'app.ts')
    const barrelSource = `
      import { createSignal } from '@fictjs/runtime/advanced'
      export { join } from 'node:path'
      export function useCount() {
        const count = createSignal(2)
        return count
      }
    `
    const appSource = `
      import { useCount } from './barrel'
      export function App() {
        const count = useCount()
        return count * 2
      }
    `

    try {
      writeFileSync(barrelPath, barrelSource)
      writeFileSync(appPath, appSource)
      const output = compilePresetModule(appSource, appPath)
      expect(output).toMatch(/count\(\)\s*\*\s*2/)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('preserves known hook metadata from an otherwise incomplete star barrel', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-partial-star-hook-'))
    const hookPath = path.join(baseDir, 'hook.ts')
    const barrelPath = path.join(baseDir, 'barrel.ts')
    const appPath = path.join(baseDir, 'app.ts')
    const hookSource = `
      import { createSignal } from '@fictjs/runtime/advanced'
      export function useCount() {
        const count = createSignal(2)
        return count
      }
    `
    const barrelSource = `
      export { useCount as counter } from './hook'
      export * from 'ordinary-utility-package'
    `
    const appSource = `
      import { counter } from './barrel'
      export function App() {
        const n = counter()
        return n * 2
      }
    `

    try {
      writeFileSync(hookPath, hookSource)
      writeFileSync(barrelPath, barrelSource)
      writeFileSync(appPath, appSource)

      const appOutput = compilePresetModule(appSource, appPath)
      expect(appOutput).toMatch(/n\(\)\s*\*\s*2/)

      const hookModule = evaluateCommonJs(compilePresetModule(hookSource, hookPath), source => {
        if (source === '@fictjs/runtime/advanced') return runtimeAdvanced
        throw new Error(`Unexpected hook dependency: ${source}`)
      })
      const barrelModule = evaluateCommonJs(
        compilePresetModule(barrelSource, barrelPath),
        source => {
          if (source === './hook') return hookModule
          if (source === 'ordinary-utility-package') return {}
          throw new Error(`Unexpected barrel dependency: ${source}`)
        },
      )
      const appModule = evaluateCommonJs(appOutput, source => {
        if (source === './barrel') return barrelModule
        throw new Error(`Unexpected app dependency: ${source}`)
      })

      expect((appModule.App as () => number)()).toBe(4)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('lets a consumer use ordinary names from an incomplete star barrel', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-ordinary-star-'))
    const barrelPath = path.join(baseDir, 'barrel.ts')
    const appPath = path.join(baseDir, 'app.ts')
    const barrelSource = `export * from 'ordinary-utility-package'`
    const appSource = `
      import { map } from './barrel'
      export const value = map([1], item => item + 1)
    `

    try {
      writeFileSync(barrelPath, barrelSource)
      writeFileSync(appPath, appSource)
      const output = compilePresetModule(appSource, appPath)
      expect(output).toContain('(0, _barrel.map)([1]')
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('keeps ordinary unresolved namespace members compatible', () => {
    const result = transformSync(
      `
        import * as pathApi from 'node:path'
        export const value = pathApi.join('a', 'b')
      `,
      {
        filename: path.resolve('ordinary-namespace-import.ts'),
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: true, emitModuleMetadata: false }]],
      },
    )

    expect(result?.code).toMatch(/pathApi\.join\(["']a["'], ["']b["']\)/)
  })

  it('fails closed when an unresolved namespace escapes before a hook member call', () => {
    expect(() =>
      transformSync(
        `
          import * as hooks from '@/hook'
          const alias = hooks
          export function App() { return alias.useCount() * 2 }
        `,
        {
          filename: path.resolve('escaped-hook-namespace.ts'),
          configFile: false,
          babelrc: false,
          presets: [
            [
              fictPreset,
              {
                dev: false,
                strictGuarantee: true,
                emitModuleMetadata: false,
              },
            ],
          ],
        },
      ),
    ).toThrow(/FICT-H003/)
  })

  it('does not publish incomplete star re-export metadata', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-babel-incomplete-metadata-'))
    const barrelPath = path.join(baseDir, 'barrel.ts')
    const metadataPath = `${barrelPath}.fict.meta.json`
    const source = `export * from 'ordinary-utility-package'`

    try {
      writeFileSync(barrelPath, source)
      writeFileSync(metadataPath, JSON.stringify({ exports: { stale: 'signal' } }))
      transformSync(source, {
        filename: barrelPath,
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: true, emitModuleMetadata: true }]],
      })

      expect(existsSync(metadataPath)).toBe(false)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it.each(['@/use-count', '#hooks', 'unpublished-hook-package'])(
    'fails closed for an unresolved hook-like import from %s',
    source => {
      const filename = path.resolve('unresolved-hook-import.ts')
      expect(() =>
        transformSync(
          `
            import { useCount } from '${source}'
            export function App() { return useCount() * 2 }
          `,
          {
            filename,
            configFile: false,
            babelrc: false,
            presets: [
              [
                fictPreset,
                {
                  dev: false,
                  strictGuarantee: true,
                  emitModuleMetadata: false,
                },
              ],
            ],
          },
        ),
      ).toThrow(/FICT-H003/)
    },
  )

  it('reports unresolved hook metadata as a warning in non-strict builds', () => {
    const warnings: string[] = []
    const result = transformSync(
      `
        import { useCount } from '@/use-count'
        export function App() { return useCount() * 2 }
      `,
      {
        filename: path.resolve('unresolved-hook-warning.ts'),
        configFile: false,
        babelrc: false,
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: false,
              emitModuleMetadata: false,
              onWarn: (warning: { code: string }) => warnings.push(warning.code),
            },
          ],
        ],
      },
    )

    expect(warnings).toContain('FICT-H003')
    expect(result?.code).toMatch(/useCount\(\)\s*\*\s*2/)
  })

  it('leaves hook metadata policy to an explicitly supplied integration store', () => {
    const filename = path.resolve('explicit-hook-metadata-store.ts')
    const output = transformSync(
      `
        import { useCount } from '@/use-count'
        export function App() { return useCount() * 2 }
      `,
      {
        filename,
        configFile: false,
        babelrc: false,
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: true,
              emitModuleMetadata: false,
              moduleMetadata: new Map(),
            },
          ],
        ],
      },
    )?.code

    expect(output).toMatch(/useCount\(\)\s*\*\s*2/)
  })

  it('treats an integration resolver as authoritative over a matching local file', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'fict-integration-resolver-'))
    const filename = path.join(baseDir, 'app.ts')
    try {
      writeFileSync(path.join(baseDir, 'use-count.ts'), 'export const useCount = () => 1')
      expect(() =>
        transformSync(
          `
            import { useCount } from './use-count'
            export function App() { return useCount() * 2 }
          `,
          {
            filename,
            configFile: false,
            babelrc: false,
            presets: [
              [
                fictPreset,
                {
                  dev: false,
                  strictGuarantee: true,
                  emitModuleMetadata: false,
                  integrationDiagnostics: [],
                  resolveModuleMetadata: () => null,
                  validateIntegrationMetadata: true,
                },
              ],
            ],
          },
        ),
      ).toThrow(/FICT-H003/)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('marks integration output incomplete when compiler emission republishes metadata', () => {
    const filename = path.resolve('integration-incomplete-output.ts')
    const moduleMetadata = new Map()
    const result = transformSync(
      `
        import { useCount } from './use-count'
        export function useWrappedCount() { return useCount() }
      `,
      {
        filename,
        configFile: false,
        babelrc: false,
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: false,
              emitModuleMetadata: false,
              integrationDiagnostics: [],
              moduleMetadata,
              resolveModuleMetadata: () => null,
              validateIntegrationMetadata: true,
            },
          ],
        ],
      },
    )

    expect(
      (result?.metadata as Record<string, unknown> | undefined)?.fictModuleMetadataIncomplete,
    ).toBe(true)
    expect(moduleMetadata.has(filename)).toBe(true)
  })

  it('resolves syntax plugins from the preset in an isolated consumer cwd', () => {
    const consumerCwd = mkdtempSync(path.join(tmpdir(), 'fict-babel-preset-consumer-'))
    try {
      const result = transformSync(reactiveComponent, {
        cwd: consumerCwd,
        filename: path.join(consumerCwd, 'App.tsx'),
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
      })

      expect(result?.code).toContain('__fictUseSignal')
      expect(result?.code).not.toContain('$state')
    } finally {
      rmSync(consumerCwd, { recursive: true, force: true })
    }
  })

  it.each([
    {
      label: 'CommonJS',
      plugins: ['@babel/plugin-transform-modules-commonjs'],
    },
    {
      label: 'React JSX',
      plugins: [['@babel/plugin-transform-react-jsx', { runtime: 'classic' }]],
    },
    {
      label: 'CommonJS and React JSX',
      plugins: [
        '@babel/plugin-transform-modules-commonjs',
        ['@babel/plugin-transform-react-jsx', { runtime: 'classic' }],
      ],
    },
  ])('runs Fict before sibling $label transforms', ({ plugins }) => {
    const result = transformSync(reactiveComponent, {
      filename: 'App.tsx',
      configFile: false,
      babelrc: false,
      plugins,
      presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
    })

    expect(result?.code).toContain('<!--fict:slot:start-->')
    expect(result?.code).toContain('__fictUseSignal')
    expect(result?.code).not.toContain('$state')
    expect(result?.code).not.toContain('React.createElement')
  })

  it('runs Fict before sibling Program.enter JSX traversal', () => {
    const eagerJsxPlugin: PluginObj = {
      name: 'eager-jsx-consumer',
      visitor: {
        Program: {
          enter(path) {
            path.traverse({
              JSXElement(jsxPath) {
                jsxPath.replaceWith(t.stringLiteral('consumed-before-fict'))
              },
            })
          },
        },
      },
    }
    const result = transformSync(reactiveComponent, {
      filename: 'App.tsx',
      configFile: false,
      babelrc: false,
      plugins: [eagerJsxPlugin],
      presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
    })

    expect(result?.code).toContain('<!--fict:slot:start-->')
    expect(result?.code).not.toContain('consumed-before-fict')
  })

  it('preserves decorated TypeScript classes for a sibling decorator transform', () => {
    const legacyDecoratorTransform: PluginObj = {
      name: 'legacy-decorator-transform-probe',
      manipulateOptions(_options, parserOptions) {
        parserOptions.plugins.push('decorators-legacy')
      },
      visitor: {
        ClassDeclaration(classPath) {
          const decorators = classPath.node.decorators ?? []
          if (decorators.length === 0 || !classPath.node.id) return
          classPath.node.decorators = null
          classPath.insertAfter(
            t.expressionStatement(
              t.assignmentExpression(
                '=',
                t.memberExpression(t.identifier(classPath.node.id.name), t.identifier('marked')),
                t.booleanLiteral(true),
              ),
            ),
          )
        },
      },
    }
    const result = transformSync(
      `
        const mark = value => value
        @mark
        export class Model {
          declare count: number
        }
      `,
      {
        filename: 'decorated-model.ts',
        configFile: false,
        babelrc: false,
        plugins: [legacyDecoratorTransform],
        presets: [[fictPreset, { dev: false, strictGuarantee: true }]],
      },
    )

    expect(result?.code).toContain('class Model')
    expect(result?.code).toContain('Model.marked = true')
    expect(result?.code).not.toContain('declare count')
    expect(result?.code).not.toContain('@mark')
  })

  it('inherits a sibling CommonJS marker while lowering TypeScript import-equals', () => {
    const result = transformSync(
      `
        import fs = require('node:fs')
        import { $state } from 'fict'

        export function App() {
          const value = $state(fs.constants.F_OK)
          return <div>{value}</div>
        }
      `,
      {
        filename: 'App.tsx',
        configFile: false,
        babelrc: false,
        plugins: ['@babel/plugin-transform-modules-commonjs'],
        presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
      },
    )

    expect(result?.code).toContain('require("node:fs")')
    expect(result?.code).toContain('require("fict/internal")')
    expect(result?.code).not.toContain('$state')
    expect(result?.code).not.toContain('import fs =')
  })

  it('runs sibling lifecycle hooks once and preserves outer source maps', () => {
    const lifecycle = { pre: 0, post: 0 }
    const siblingPlugin: PluginObj = {
      name: 'sibling-lifecycle-probe',
      visitor: {},
      pre() {
        lifecycle.pre++
      },
      post() {
        lifecycle.post++
      },
    }
    const result = transformSync(reactiveComponent, {
      filename: 'App.tsx',
      sourceFileName: 'App.tsx',
      sourceMaps: true,
      configFile: false,
      babelrc: false,
      plugins: [siblingPlugin],
      presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
    })

    expect(lifecycle).toEqual({ pre: 1, post: 1 })
    expect(result?.map?.sources).toContain('App.tsx')
    expect(result?.map?.mappings).not.toBe('')
  })

  it('reports isolated compiler errors with one filename prefix', () => {
    let thrown: unknown
    try {
      transformSync(
        `
          export function App() {
            const value = $state(1)
            return <div>{value}</div>
          }
        `,
        {
          filename: 'broken.tsx',
          configFile: false,
          babelrc: false,
          presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
        },
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message.match(/broken\.tsx:/g)).toHaveLength(1)
    expect(message).toContain('$state() must be imported from "fict"')
  })

  it('compiles CTS import-equals, export assignment, and Fict macros to CommonJS', () => {
    const result = transformSync(
      `
        import path = require('node:path')
        import { $state } from 'fict'

        function useValue() {
          const value = $state(path.sep.length)
          return value
        }

        export = { useValue }
      `,
      {
        filename: 'module.cts',
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
      },
    )

    expect(result?.code).toMatch(/require\(["']node:path["']\)/)
    expect(result?.code).toContain('require("fict/internal")')
    expect(result?.code).toContain('module.exports =')
    expect(result?.code).toContain('__fictUseSignal')
    expect(result?.code).not.toContain('$state')
    expect(result?.code).not.toMatch(/\b(?:import|export)\s/)
  })

  it('compiles ESM-style exports in CTS files to CommonJS', () => {
    const result = transformSync(`export const answer: number = 42`, {
      filename: 'module.cts',
      configFile: false,
      babelrc: false,
      presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
    })

    expect(result?.code).toContain('exports.answer =')
    expect(result?.code).not.toContain('export const')
  })

  it('honors onlyRemoveTypeImports and optimizeConstEnums', () => {
    const result = transformSync(
      `
        import { Shape } from './dep'
        const enum Status { Ready = 2 }
        export const value: Shape = { status: Status.Ready } as Shape
      `,
      {
        filename: 'options.ts',
        configFile: false,
        babelrc: false,
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: false,
              typescriptOptions: {
                onlyRemoveTypeImports: true,
                optimizeConstEnums: true,
              },
            },
          ],
        ],
      },
    )

    expect(result?.code).toContain(`import { Shape } from './dep'`)
    expect(result?.code).not.toContain('function (Status)')
    expect(result?.code).not.toContain('Status.Ready')
    expect(result?.code).toContain('status: 2')
  })

  it('honors explicit JSX pragma imports before a sibling JSX transform', () => {
    const result = transformSync(
      `
        "use fict-compiler-disable"
        import { h, Fragment } from './factory'
        export const view = <><div /></>
      `,
      {
        filename: 'pragma.tsx',
        configFile: false,
        babelrc: false,
        plugins: [['@babel/plugin-transform-react-jsx', { pragma: 'h', pragmaFrag: 'Fragment' }]],
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: false,
              typescriptOptions: { jsxPragma: 'h', jsxPragmaFrag: 'Fragment' },
            },
          ],
        ],
      },
    )

    expect(result?.code).toContain(`import { h, Fragment } from './factory'`)
    expect(result?.code).toContain('h(Fragment')
  })

  it('rewrites TypeScript extensions after resolving hook metadata', () => {
    const filename = path.resolve('rewrite-importer.tsx')
    const hookFilename = path.resolve('use-count.ts')
    const moduleMetadata = new Map([
      [
        hookFilename,
        {
          version: 1 as const,
          exports: {},
          hooks: { useCount: { directAccessor: 'signal' as const } },
        },
      ],
    ])
    const result = transformSync(
      `
        import { useCount } from './use-count.ts'
        export const load = () => import('./lazy.mts')
        export function App() {
          const count = useCount()
          return <div>{count * 2}</div>
        }
      `,
      {
        filename,
        configFile: false,
        babelrc: false,
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: false,
              moduleMetadata,
              typescriptOptions: { rewriteImportExtensions: true },
            },
          ],
        ],
      },
    )

    expect(result?.code).toMatch(/from ["']\.\/use-count\.js["']/)
    expect(result?.code).toMatch(/import\(["']\.\/lazy\.mjs["']\)/)
    expect(result?.code).toMatch(/count\(\)\s*\*\s*2/)
    expect(result?.metadata.fictModuleRequestMappings).toEqual([
      ['./use-count.ts', './use-count.js'],
    ])
  })

  it('rewrites relative CTS import-equals dependencies to CommonJS extensions', () => {
    const result = transformSync(
      `
        import dependency = require('./dependency.cts')
        export = dependency
      `,
      {
        filename: 'entry.cts',
        configFile: false,
        babelrc: false,
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: false,
              typescriptOptions: { rewriteImportExtensions: true },
            },
          ],
        ],
      },
    )

    expect(result?.code).toMatch(/require\(["']\.\/dependency\.cjs["']\)/)
    expect(result?.code).not.toContain('./dependency.cts')
    expect(result?.metadata.fictModuleRequestMappings).toEqual([
      ['./dependency.cts', './dependency.cjs'],
    ])
  })

  it('rewrites only relative TypeScript import-equals requires', () => {
    const source = `
      import jsDependency = require('./dependency.ts')
      import mjsDependency = require('../dependency.mts')
      import cjsDependency = require('./dependency.cts')
      import bareDependency = require('package/subpath.cts')
      import absoluteDependency = require('/absolute/path.cts')
      const manualRequire = require('./dependency.cts')
      export = {
        jsDependency,
        mjsDependency,
        cjsDependency,
        bareDependency,
        absoluteDependency,
        manualRequire,
      }
    `
    const compile = (rewriteImportExtensions: boolean) =>
      transformSync(source, {
        filename: 'entry.ts',
        configFile: false,
        babelrc: false,
        plugins: ['@babel/plugin-transform-modules-commonjs'],
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: false,
              typescriptOptions: { rewriteImportExtensions },
            },
          ],
        ],
      })?.code ?? ''

    const enabled = compile(true)
    expect(enabled).toMatch(/require\(["']\.\/dependency\.js["']\)/)
    expect(enabled).toMatch(/require\(["']\.\.\/dependency\.mjs["']\)/)
    expect(enabled).toMatch(/require\(["']\.\/dependency\.cjs["']\)/)
    expect(enabled).toMatch(/require\(["']package\/subpath\.cts["']\)/)
    expect(enabled).toMatch(/require\(["']\/absolute\/path\.cts["']\)/)
    expect(enabled).toMatch(/require\(["']\.\/dependency\.cts["']\)/)

    const disabled = compile(false)
    expect(disabled).toMatch(/require\(["']\.\/dependency\.ts["']\)/)
    expect(disabled).toMatch(/require\(["']\.\.\/dependency\.mts["']\)/)
    expect(disabled).toMatch(/require\(["']\.\/dependency\.cts["']\)/)
    expect(disabled).not.toContain('./dependency.js')
    expect(disabled).not.toContain('../dependency.mjs')
    expect(disabled).not.toContain('./dependency.cjs')
  })

  it('rewrites only relative dynamic import expressions', () => {
    const unwrapDynamicImports: PluginObj = {
      name: 'unwrap-dynamic-imports-for-extension-test',
      visitor: {
        CallExpression(callPath) {
          if (!t.isImport(callPath.node.callee)) return
          const source = callPath.node.arguments[0]
          if (source && t.isExpression(source)) callPath.replaceWith(source)
        },
        ImportExpression(importPath) {
          importPath.replaceWith(importPath.node.source)
        },
      },
    }
    const result = transformSync(
      `
        globalThis.rewrittenSpecifiers = [
          './relative.ts',
          '../relative.mts',
          'https://cdn.example/remote.ts',
          'package/subpath.ts',
          '@scope/package/subpath.cts',
          '/absolute/path.ts',
          'C:/absolute/path.ts',
          'C:\\\\absolute\\\\path.ts',
        ].map(specifier => import(specifier))
      `,
      {
        filename: 'dynamic-imports.ts',
        configFile: false,
        babelrc: false,
        plugins: [unwrapDynamicImports],
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: false,
              typescriptOptions: { rewriteImportExtensions: true },
            },
          ],
        ],
      },
    )
    const sandbox: { rewrittenSpecifiers?: string[] } = {}
    new Function('globalThis', result?.code ?? '')(sandbox)

    expect(sandbox.rewrittenSpecifiers).toEqual([
      './relative.js',
      '../relative.mjs',
      'https://cdn.example/remote.ts',
      'package/subpath.ts',
      '@scope/package/subpath.cts',
      '/absolute/path.ts',
      'C:/absolute/path.ts',
      'C:\\absolute\\path.ts',
    ])
  })

  it('honors disallowAmbiguousJSXLike in all-extensions mode', () => {
    expect(() =>
      transformSync(`export const value = <number>input`, {
        filename: 'ambiguous.ts',
        configFile: false,
        babelrc: false,
        presets: [
          [
            fictPreset,
            {
              typescriptOptions: {
                allExtensions: true,
                isTSX: false,
                disallowAmbiguousJSXLike: true,
              },
            },
          ],
        ],
      }),
    ).toThrow(/syntax is reserved|disallowAmbiguousJSLike|angle-bracket/i)
  })

  it('removes an obsolete JSX pragma binding without dropping module evaluation', () => {
    const result = transformSync(
      `
        import React from 'react'
        export function App() {
          return <div />
        }
      `,
      {
        filename: 'react-import.tsx',
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
      },
    )

    expect(result?.code).toContain('template("<div></div>")')
    expect(result?.code).toMatch(/import ["']react["']/)
    expect(result?.code).not.toContain("from 'react'")
    expect(result?.code).not.toContain('from "react"')
  })

  it('preserves JSX pragma imports with runtime uses or explicit import preservation', () => {
    const runtimeUse = transformSync(
      `
        import React from 'react'
        export const version = React.version
        export function App() {
          return <div />
        }
      `,
      {
        filename: 'react-runtime.tsx',
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
      },
    )
    const preserveImports = transformSync(
      `
        import React from 'react'
        export function App() {
          return <div />
        }
      `,
      {
        filename: 'react-preserved.tsx',
        configFile: false,
        babelrc: false,
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: false,
              typescriptOptions: { onlyRemoveTypeImports: true },
            },
          ],
        ],
      },
    )

    expect(runtimeUse?.code).toMatch(/import React from ["']react["']/)
    expect(preserveImports?.code).toMatch(/import React from ["']react["']/)
  })

  it('maps the compiler sourcemap option to Babel sourceMaps', () => {
    const enabled = transformSync(reactiveComponent, {
      filename: 'preset-sourcemap.tsx',
      configFile: false,
      babelrc: false,
      presets: [[fictPreset, { dev: false, strictGuarantee: false, sourcemap: true }]],
    })
    const callerDisabled = transformSync(reactiveComponent, {
      filename: 'caller-sourcemap.tsx',
      sourceMaps: false,
      configFile: false,
      babelrc: false,
      presets: [[fictPreset, { dev: false, strictGuarantee: false, sourcemap: true }]],
    })

    expect(enabled?.map?.sources).toContain('preset-sourcemap.tsx')
    expect(enabled?.map?.mappings).not.toBe('')
    expect(callerDisabled?.map).toBeNull()
  })

  it.each([
    { filename: 'virtual.ts?query', source: `export const value: number = 1`, commonjs: false },
    {
      filename: 'virtual.tsx#fragment',
      source: `export const view: JSX.Element = <div />`,
      commonjs: false,
    },
    { filename: 'virtual.mts?query', source: `export const value: number = 1`, commonjs: false },
    { filename: 'virtual.cts#fragment', source: `export const value: number = 1`, commonjs: true },
  ])(
    'detects TypeScript through a URL-suffixed filename $filename',
    ({ filename, source, commonjs }) => {
      const result = transformSync(source, {
        filename,
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
      })

      expect(result?.code).not.toContain(': number')
      expect(result?.code).not.toContain('JSX.Element')
      if (commonjs) expect(result?.code).toContain('exports.value =')
    },
  )

  it('detects TypeScript and TSX syntax from the file extension', () => {
    const typed = transformSync(
      `
        import { $state } from 'fict'
        export function useValue(input: unknown) {
          const asserted = <number>input
          const value = $state(asserted)
          return value
        }
      `,
      {
        filename: 'use-value.ts',
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
      },
    )
    const tsx = transformSync(
      `
        import { $state } from 'fict'
        export function App() {
          const value = $state(1)
          return <div>{value}</div>
        }
      `,
      {
        filename: 'App.tsx',
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
      },
    )

    expect(typed?.code).toContain('__fictUseSignal')
    expect(typed?.code).not.toContain('<number>')
    expect(tsx?.code).toContain('__fictUseSignal')
    expect(tsx?.code).toContain('template("<div>')
  })

  it('composes with Babel plugins explicitly configured by the user', () => {
    const configuredPlugin: PluginObj = {
      name: 'configured-marker-plugin',
      visitor: {
        StringLiteral(path) {
          if (path.node.value === 'original-marker') {
            path.node.value = 'configured-marker'
          }
        },
      },
    }
    const result = transformSync(
      `
        import { $state } from 'fict'
        export function useMarker() {
          const marker = $state('original-marker')
          return marker
        }
      `,
      {
        filename: 'configured-preset.ts',
        configFile: false,
        babelrc: false,
        plugins: [configuredPlugin],
        presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
      },
    )

    expect(result?.code).toContain('configured-marker')
    expect(result?.code).not.toContain('original-marker')
    expect(result?.code).toContain('__fictUseSignal')
  })

  it('lowers runtime TypeScript before Fict and preserves hook metadata', () => {
    const filename = path.resolve('babel-typescript-integration.ts')
    const moduleMetadata = new Map()
    const result = transformSync(
      `
        import { $state } from 'fict'

        enum Status {
          Idle,
          Ready,
        }

        namespace Defaults {
          export const status = Status.Ready
        }

        class Model {
          declare status: Status
          current = Defaults.status
        }

        export function useStatus() {
          const status = $state(new Model().current)
          return status
        }
      `,
      {
        filename,
        configFile: false,
        babelrc: false,
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: false,
              emitModuleMetadata: true,
              moduleMetadata,
            },
          ],
        ],
      },
    )

    expect(result?.code).toContain('__fictUseSignal')
    expect(result?.code).not.toContain('$state')
    expect(result?.code).not.toMatch(/\benum\s+Status\b/)
    expect(result?.code).not.toMatch(/\bnamespace\s+Defaults\b/)
    expect(result?.code).not.toContain('declare status')
    expect(moduleMetadata.get(filename)?.hooks?.useStatus).toEqual({
      directAccessor: 'signal',
    })
  })

  it('preserves reactive values declared by TypeScript namespaces', () => {
    const filename = path.resolve('typescript-namespace-signal.tsx')
    const moduleMetadata = new Map()
    const result = transformSync(
      `
        import { createMemo, createSignal } from 'fict/advanced'

        export namespace State {
          export const count = createSignal(1)
        }

        export namespace State {
          export const doubled = createMemo(() => 2)
        }

        export function App() {
          return <div>{State.count * 2}{State.doubled}</div>
        }
      `,
      {
        filename,
        configFile: false,
        babelrc: false,
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: true,
              emitModuleMetadata: true,
              moduleMetadata,
            },
          ],
        ],
      },
    )

    expect(result?.code).toMatch(/State\.count\(\)\s*\*\s*2/)
    expect(result?.code).toMatch(/State\.doubled\(\)/)
    expect(moduleMetadata.get(filename)?.namespaces?.State?.exports).toEqual({
      count: 'signal',
      doubled: 'memo',
    })
  })

  it('compiles reactive hooks declared by TypeScript namespaces', () => {
    const filename = path.resolve('typescript-namespace-hook.tsx')
    const moduleMetadata = new Map()
    const result = transformSync(
      `
        import { $state } from 'fict'

        export namespace Hooks {
          export function useCount() {
            const count = $state(1)
            return count
          }
        }

        export function App() {
          const count = Hooks.useCount()
          return <div>{count * 2}</div>
        }
      `,
      {
        filename,
        configFile: false,
        babelrc: false,
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: true,
              emitModuleMetadata: true,
              moduleMetadata,
            },
          ],
        ],
      },
    )

    expect(result?.code).toContain('__fictUseSignal')
    expect(result?.code).toMatch(/count\(\)\s*\*\s*2/)
    expect(moduleMetadata.get(filename)?.namespaces?.Hooks?.hooks?.useCount).toEqual({
      directAccessor: 'signal',
    })
  })

  it('compiles reactive components declared by TypeScript namespaces', () => {
    const result = transformSync(
      `
        import { $state } from 'fict'

        export namespace UI {
          export function Counter() {
            const count = $state(1)
            return <button>{count}</button>
          }
        }

        export function App() {
          return <UI.Counter />
        }
      `,
      {
        filename: 'typescript-namespace-component.tsx',
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: true }]],
      },
    )

    expect(result?.code).toContain('__fictUseSignal')
    expect(result?.code).not.toContain('$state')
    expect(result?.code).toContain('UI.Counter = Counter')
  })

  it('compiles reactive components in nested and merged TypeScript namespaces', () => {
    const result = transformSync(
      `
        import { $state } from 'fict'

        export namespace UI {
          export namespace Controls {
            export function Counter() {
              const count = $state(1)
              return <button>{count}</button>
            }
          }
        }

        export namespace UI {
          export const version = 1
        }

        export function App() {
          return <UI.Controls.Counter />
        }
      `,
      {
        filename: 'typescript-nested-namespace-component.tsx',
        configFile: false,
        babelrc: false,
        sourceMaps: true,
        presets: [[fictPreset, { dev: false, strictGuarantee: true }]],
      },
    )

    expect(result?.code).toContain('__fictUseSignal')
    expect(result?.code).not.toContain('$state')
    expect(result?.map).not.toBeNull()
  })

  it.each([
    [
      'an arbitrary initializer',
      `(function (anything) {
        const count = $state(1)
        return <button>{count}</button>
      })(N || fallback)`,
    ],
    [
      'a source-level namespace initializer mimic',
      `(function (anything) {
        const count = $state(1)
        return <button>{count}</button>
      })(N || (N = {}))`,
    ],
    [
      'an async function',
      `(async function (anything) {
        await Promise.resolve()
        const count = $state(1)
        return <button>{count}</button>
      })(N || (N = {}))`,
    ],
    [
      'a named function',
      `(function named(anything) {
        const count = $state(1)
        return <button>{count}</button>
      })(N || (N = {}))`,
    ],
    [
      'a generator function',
      `(function* (anything) {
        const count = $state(1)
        yield <button>{count}</button>
      })(N || (N = {}))`,
    ],
    [
      'extra call arguments',
      `(function (anything) {
        const count = $state(1)
        return <button>{count}</button>
      })(N || (N = {}), fallback)`,
    ],
  ])('does not treat a user IIFE with %s as a TypeScript namespace wrapper', (_label, iife) => {
    expect(() =>
      transformSync(
        `
          import { $state } from 'fict'

          namespace N {
            export const value = 1
          }
          const fallback = {}

          export function App() {
            return ${iife}
          }
        `,
        {
          filename: 'typescript-namespace-user-iife.tsx',
          configFile: false,
          babelrc: false,
          presets: [[fictPreset, { dev: false, strictGuarantee: true }]],
        },
      ),
    ).toThrow(/top level|nested function/)
  })

  it('preserves top-level hook aliases exported through TypeScript namespaces', () => {
    const filename = path.resolve('typescript-namespace-hook-alias.tsx')
    const moduleMetadata = new Map()
    const result = transformSync(
      `
        import { $state } from 'fict'

        export function useRootCount() {
          const count = $state(1)
          return count
        }

        export namespace Hooks {
          export const useCount = useRootCount
        }

        export function App() {
          const count = Hooks.useCount()
          return <div>{count * 2}</div>
        }
      `,
      {
        filename,
        configFile: false,
        babelrc: false,
        presets: [
          [
            fictPreset,
            {
              dev: false,
              strictGuarantee: true,
              emitModuleMetadata: true,
              moduleMetadata,
            },
          ],
        ],
      },
    )

    expect(result?.code).toMatch(/count\(\)\s*\*\s*2/)
    expect(moduleMetadata.get(filename)?.namespaces?.Hooks?.hooks?.useCount).toEqual({
      directAccessor: 'signal',
    })
  })

  it('fails closed for unsafe reactive TypeScript namespace members', () => {
    expect(() =>
      transformSync(
        `
          import { $state } from 'fict'
          import { createSignal } from 'fict/advanced'

          const rootCount = createSignal(1)

          export namespace State {
            export const count = rootCount
          }

          export namespace Hooks {
            export const useCount = () => {
              const count = $state(1)
              return count
            }
          }
        `,
        {
          filename: 'unsafe-typescript-namespace.tsx',
          configFile: false,
          babelrc: false,
          presets: [[fictPreset, { dev: false, strictGuarantee: true }]],
        },
      ),
    ).toThrow(/namespace member "count" cannot alias an accessor/)

    expect(() =>
      transformSync(
        `
          import { $state } from 'fict'

          export namespace Hooks {
            export const useCount = () => {
              const count = $state(1)
              return count
            }
          }
        `,
        {
          filename: 'unsafe-typescript-namespace-hook.tsx',
          configFile: false,
          babelrc: false,
          presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
        },
      ),
    ).toThrow(/namespace hook "useCount" must use an exported function declaration/)

    expect(() =>
      transformSync(
        `
          import { $state } from 'fict'

          export namespace UI {
            export const Counter = () => {
              const count = $state(1)
              return <button>{count}</button>
            }
          }
        `,
        {
          filename: 'unsafe-typescript-namespace-component.tsx',
          configFile: false,
          babelrc: false,
          presets: [[fictPreset, { dev: false, strictGuarantee: false }]],
        },
      ),
    ).toThrow(/namespace component "Counter" must use an exported function declaration/)
  })

  it('does not apply TypeScript namespace metadata to shadowing locals', () => {
    const result = transformSync(
      `
        import { createSignal } from 'fict/advanced'

        namespace State {
          export const count = createSignal(1)
        }
        export { State }

        function read(State: { count: number }) {
          return State.count
        }

        export function App() {
          return State.count + read({ count: 2 })
        }
      `,
      {
        filename: 'typescript-namespace-shadow.tsx',
        configFile: false,
        babelrc: false,
        presets: [[fictPreset, { dev: false, strictGuarantee: true }]],
      },
    )

    expect(result?.code).toMatch(/function read\(State\) \{\s*return State\.count;/s)
    expect(result?.code).toMatch(/return State\.count\(\) \+ read/)
    expect(result?.code).not.toMatch(/function read\(State\) \{\s*return State\.count\(\)/s)
  })
})
