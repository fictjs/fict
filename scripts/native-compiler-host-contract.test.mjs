#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  assertHostEnvironmentContract,
  assertHostMetadataContract,
  counterLibrarySource,
  extractHostRecipe,
} from './lib/compiler-host-contract.mjs'

const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const nativePath = path.resolve(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(root, 'target/release/fict_compiler_napi.node'),
)
const previousPath = process.env.FICT_COMPILER_NATIVE_PATH
process.env.FICT_COMPILER_NATIVE_PATH = nativePath
const recipePath = path.join(root, 'packages/compiler', `.native-host-recipe-${process.pid}.mjs`)
await writeFile(
  recipePath,
  extractHostRecipe(await readFile(path.join(root, 'docs/custom-compiler-host.md'), 'utf8')),
)
const recipe = await import(pathToFileURL(recipePath).href)
after(async () => {
  await unlink(recipePath)
  if (previousPath === undefined) delete process.env.FICT_COMPILER_NATIVE_PATH
  else process.env.FICT_COMPILER_NATIVE_PATH = previousPath
})

for (const format of ['esm', 'cjs']) {
  const extension = format === 'esm' ? 'js' : 'cjs'
  const load = name =>
    format === 'esm'
      ? import(
          pathToFileURL(path.join(root, 'packages/compiler/dist', `${name}.${extension}`)).href
        )
      : require(`../packages/compiler/dist/${name}.${extension}`)
  const compiler = await load('index')
  const native = await load('native-loader')
  const graphHost = await load('graph-host')
  test(`custom host process and explicit environment policy (${format})`, async () => {
    const evidence = await assertHostEnvironmentContract(compiler, native, { nativePath })
    assert.equal(evidence.policyChecks, 66)
  })
  test(`custom host recipe follows package metadata changes and fails closed (${format})`, async () => {
    await assertHostMetadataContract(compiler, graphHost, recipe)
  })
}

for (const [index, options] of [
  { optimize: false, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'full' },
].entries()) {
  test(`custom host metadata drives a live hook consumer and disposal (${index})`, async () => {
    const { JSDOM } = require('../packages/runtime/node_modules/jsdom')
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
    const globals = [
      'window',
      'document',
      'Node',
      'Element',
      'HTMLElement',
      'SVGElement',
      'Text',
      'Comment',
      'Document',
      'DocumentFragment',
      'Event',
    ]
    const descriptors = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
    globals.forEach(name =>
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: dom.window[name],
      }),
    )
    const prefix = `.native-custom-host-${process.pid}-${index}`
    const dependencyPath = path.join(root, 'packages/fict', `${prefix}-counter.mjs`)
    const consumerPath = path.join(root, 'packages/fict', `${prefix}-app.mjs`)
    const source = `./${path.basename(dependencyPath)}`
    const environment = { nodeEnv: 'production' }
    const opaqueRuntime = name => ({ status: 'opaque', resolvedId: name, metadata: null })
    let stop
    try {
      const dependency = await recipe.compileModule(
        { code: counterLibrarySource, filename: dependencyPath, options },
        opaqueRuntime,
        environment,
      )
      const consumer = await recipe.compileModule(
        {
          code: `import { render } from 'fict'; import { useCounter } from '${source}';
          function App() { const model = useCounter(); return <button onClick={model.increment}>{model.count}</button> }
          export const mount = container => render(() => <App />, container);`,
          filename: consumerPath,
          language: 'tsx',
          options,
        },
        name =>
          name === source
            ? {
                status: 'resolved',
                resolvedId: dependencyPath,
                metadata: dependency.moduleMetadata,
              }
            : opaqueRuntime(name),
        environment,
      )
      await writeFile(dependencyPath, dependency.code)
      await writeFile(consumerPath, consumer.code)
      const fixture = await import(pathToFileURL(consumerPath).href)
      const container = document.createElement('div')
      document.body.append(container)
      stop = fixture.mount(container)
      const button = container.querySelector('button')
      assert.equal(button.textContent, '0')
      button.click()
      for (let turn = 0; turn < 6; turn++) await Promise.resolve()
      assert.equal(button.textContent, '1')
      stop()
      stop = undefined
      assert.equal(container.childNodes.length, 0)
      const disposedText = button.textContent
      button.click()
      for (let turn = 0; turn < 6; turn++) await Promise.resolve()
      assert.equal(button.textContent, disposedText)
    } finally {
      stop?.()
      await Promise.all(
        [dependencyPath, consumerPath].map(file =>
          unlink(file).catch(error => {
            if (error.code !== 'ENOENT') throw error
          }),
        ),
      )
      globals.forEach((name, i) => {
        if (descriptors[i]) Object.defineProperty(globalThis, name, descriptors[i])
        else delete globalThis[name]
      })
      dom.window.close()
    }
  })
}
