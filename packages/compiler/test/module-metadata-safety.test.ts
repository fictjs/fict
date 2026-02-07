import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { transformSync } from '@babel/core'
import syntaxJsx from '@babel/plugin-syntax-jsx'
import { describe, expect, it } from 'vitest'

import createFictPlugin from '../src'

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
            { emitModuleMetadata: false, dev: true, onWarn: warning => warnings.push(warning) },
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
})
