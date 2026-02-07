import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { transformSync } from '@babel/core'
import syntaxJsx from '@babel/plugin-syntax-jsx'
import { describe, expect, it } from 'vitest'

import createFictPlugin from '../src'
import { clearModuleMetadata, resolveModuleMetadata, setModuleMetadata } from '../src'

describe('module metadata safety', () => {
  it('does not write metadata sidecar for unknown filename', () => {
    const unknownMetaPath = path.resolve('<unknown>.fict.meta.json')
    if (existsSync(unknownMetaPath)) {
      rmSync(unknownMetaPath, { force: true })
    }

    transformSync('export const value = 1', {
      configFile: false,
      babelrc: false,
      sourceType: 'module',
      parserOpts: {
        sourceType: 'module',
        plugins: ['typescript'],
      },
      plugins: [[createFictPlugin, { emitModuleMetadata: true, dev: false }]],
    })

    expect(existsSync(unknownMetaPath)).toBe(false)
  })

  it('reports codegen diagnostics with the compiler filename', () => {
    const warnings: Array<{ code: string; fileName: string }> = []
    const filename = '/tmp/props-pattern.tsx'
    transformSync(
      `
      function Comp({ list: [first, ...rest] }) {
        return <div>{first}</div>
      }
    `,
      {
        filename,
        configFile: false,
        babelrc: false,
        sourceType: 'module',
        parserOpts: {
          sourceType: 'module',
          plugins: ['typescript', 'jsx'],
        },
        plugins: [
          [syntaxJsx, {}],
          [
            createFictPlugin,
            {
              emitModuleMetadata: false,
              dev: true,
              strictGuarantee: false,
              onWarn: warning => warnings.push(warning),
            },
          ],
        ],
      },
    )

    const warning = warnings.find(item => item.code === 'FICT-P002')
    expect(warning?.fileName).toBe(filename)
  })

  it('skips rewriting unchanged metadata payloads', async () => {
    const baseDir = path.join(process.cwd(), '__fict_metadata_safety__')
    mkdirSync(baseDir, { recursive: true })
    const filePath = path.join(baseDir, 'module.ts')
    const metaPath = `${filePath}.fict.meta.json`
    const source = 'export const value = 1'

    try {
      transformSync(source, {
        filename: filePath,
        configFile: false,
        babelrc: false,
        sourceType: 'module',
        parserOpts: {
          sourceType: 'module',
          plugins: ['typescript'],
        },
        plugins: [[createFictPlugin, { emitModuleMetadata: true, dev: false }]],
      })

      const firstMtime = statSync(metaPath).mtimeMs
      await new Promise(resolve => setTimeout(resolve, 20))

      transformSync(source, {
        filename: filePath,
        configFile: false,
        babelrc: false,
        sourceType: 'module',
        parserOpts: {
          sourceType: 'module',
          plugins: ['typescript'],
        },
        plugins: [[createFictPlugin, { emitModuleMetadata: true, dev: false }]],
      })

      const secondMtime = statSync(metaPath).mtimeMs
      expect(secondMtime).toBe(firstMtime)
    } finally {
      if (existsSync(metaPath)) {
        rmSync(metaPath, { force: true })
      }
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
    }
  })

  it('does not cache external metadata resolver callbacks', () => {
    let resolveCalls = 0
    const pluginOptions = {
      emitModuleMetadata: 'auto' as const,
      dev: false,
      resolveModuleMetadata: (source: string) => {
        if (source === './dep') {
          resolveCalls += 1
          return {
            exports: {
              value: 'signal' as const,
            },
          }
        }
        return undefined
      },
    }

    const source = `
      import { value } from './dep'
      export function useValue() {
        return value
      }
    `

    transformSync(source, {
      filename: '/tmp/consumer.ts',
      configFile: false,
      babelrc: false,
      sourceType: 'module',
      parserOpts: {
        sourceType: 'module',
        plugins: ['typescript'],
      },
      plugins: [[createFictPlugin, pluginOptions]],
    })
    const firstPassCalls = resolveCalls

    transformSync(source, {
      filename: '/tmp/consumer.ts',
      configFile: false,
      babelrc: false,
      sourceType: 'module',
      parserOpts: {
        sourceType: 'module',
        plugins: ['typescript'],
      },
      plugins: [[createFictPlugin, pluginOptions]],
    })

    expect(firstPassCalls).toBeGreaterThan(0)
    expect(resolveCalls).toBeGreaterThan(firstPassCalls)
  })

  it('does not resolve bare package imports from cwd metadata sidecars', () => {
    clearModuleMetadata()
    const bareSource = '__fict_bare_pkg__'
    const fakeResolvedPath = path.resolve(bareSource)
    const fakeMetaPath = `${fakeResolvedPath}.fict.meta.json`

    try {
      writeFileSync(fakeMetaPath, JSON.stringify({ exports: { value: 'signal' } }), 'utf8')

      const resolved = resolveModuleMetadata(bareSource, '/tmp/consumer.ts', {
        emitModuleMetadata: false,
      })

      expect(resolved).toBeUndefined()
    } finally {
      if (existsSync(fakeMetaPath)) {
        rmSync(fakeMetaPath, { force: true })
      }
      clearModuleMetadata()
    }
  })

  it('does not read disk sidecars when moduleMetadata store is explicitly provided', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_metadata_store_only__')
    const importer = path.join(baseDir, 'consumer.ts')
    const depPath = path.join(baseDir, 'dep.ts')
    const depMetaPath = `${depPath}.fict.meta.json`
    mkdirSync(baseDir, { recursive: true })

    try {
      writeFileSync(depMetaPath, JSON.stringify({ exports: { value: 'signal' } }), 'utf8')
      const resolved = resolveModuleMetadata('./dep', importer, {
        emitModuleMetadata: false,
        moduleMetadata: new Map(),
      })
      expect(resolved).toBeUndefined()
    } finally {
      if (existsSync(depMetaPath)) {
        rmSync(depMetaPath, { force: true })
      }
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('invalidates fs probe cache when metadata sidecars are created', () => {
    clearModuleMetadata()
    const baseDir = path.join(process.cwd(), '__fict_metadata_probe_cache__')
    const importer = path.join(baseDir, 'consumer.ts')
    const depPath = path.join(baseDir, 'dep.ts')
    const depMetaPath = `${depPath}.fict.meta.json`
    mkdirSync(baseDir, { recursive: true })

    try {
      const first = resolveModuleMetadata('./dep', importer, {
        emitModuleMetadata: false,
      })
      expect(first).toBeUndefined()

      setModuleMetadata(
        depPath,
        {
          exports: {
            value: 'signal',
          },
        },
        {
          emitModuleMetadata: true,
          dev: false,
        },
      )

      const resolved = resolveModuleMetadata('./dep', importer, {
        emitModuleMetadata: false,
      })

      expect(resolved).toEqual({
        exports: {
          value: 'signal',
        },
      })
    } finally {
      if (existsSync(depMetaPath)) {
        rmSync(depMetaPath, { force: true })
      }
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true })
      }
      clearModuleMetadata()
    }
  })

  it('does not fall back to cwd sidecars for unresolved relative imports', () => {
    clearModuleMetadata()
    const marker = '__fict_relative_probe__'
    const source = `./${marker}`
    const importer = '/tmp/consumer.ts'
    const cwdMetaPath = path.resolve(`${marker}.fict.meta.json`)

    try {
      writeFileSync(cwdMetaPath, JSON.stringify({ exports: { value: 'signal' } }), 'utf8')
      const resolved = resolveModuleMetadata(source, importer, {
        emitModuleMetadata: false,
      })
      expect(resolved).toBeUndefined()
    } finally {
      if (existsSync(cwdMetaPath)) {
        rmSync(cwdMetaPath, { force: true })
      }
      clearModuleMetadata()
    }
  })
})
