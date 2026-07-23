#!/usr/bin/env node

import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { chromium } from '@playwright/test'

import fict from '../packages/vite-plugin/dist/index.js'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const requireFromVitePlugin = createRequire(
  path.join(repositoryRoot, 'packages', 'vite-plugin', 'package.json'),
)
const { createServer } = await import(pathToFileURL(requireFromVitePlugin.resolve('vite')).href)
const nativeCompilerPath = path.resolve(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(repositoryRoot, 'target', 'release', 'fict_compiler_napi.node'),
)
const fictEntry = path.join(repositoryRoot, 'packages', 'fict', 'dist', 'index.js')
const fictInternalEntry = path.join(repositoryRoot, 'packages', 'fict', 'dist', 'internal.js')
const runtimeEntry = path.join(repositoryRoot, 'packages', 'runtime', 'dist', 'index.js')
const runtimeAdvancedEntry = path.join(repositoryRoot, 'packages', 'runtime', 'dist', 'advanced.js')
const runtimeInternalEntry = path.join(repositoryRoot, 'packages', 'runtime', 'dist', 'internal.js')

await Promise.all([
  access(nativeCompilerPath),
  access(fictEntry),
  access(fictInternalEntry),
  access(runtimeEntry),
  access(runtimeAdvancedEntry),
  access(runtimeInternalEntry),
])

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function withTimeout(promise, description, timeoutMs = 15_000) {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error(`Timed out waiting for ${description}.`)),
    timeoutMs,
  )
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      }),
    ),
  ]).finally(() => clearTimeout(timeout))
}

function mainSource(revision) {
  return `
    import { render } from 'fict'
    import { useLabel } from './use-label'
    import { PreviewProbe } from './preview'

    const revision = ${JSON.stringify(revision)}

    function App() {
      const api = useLabel()
      return (
        <main>
          <p id="revision">{revision}</p>
          <p id="hook-value">{api.label}</p>
          <PreviewProbe />
        </main>
      )
    }

    document.documentElement.dataset.fictRevision = revision
    const root = document.querySelector('#app')
    if (!root) throw new Error('Missing #app mount point')
    render(() => <App />, root)
  `
}

function reactiveHookSource(value) {
  return `
    import { $state } from 'fict'
    export function useLabel() {
      const label = $state(${JSON.stringify(value)})
      return { label }
    }
  `
}

function plainHookSource(value) {
  return `
    export function useLabel() {
      return { label: ${JSON.stringify(value)} }
    }
  `
}

function previewSource(generation, handlerMarker) {
  return `
    import { $state } from 'fict'

    export function PreviewProbe() {
      let count = $state(0)
      const generation = ${JSON.stringify(generation)}
      return (
        <button
          id="preview-handler"
          data-generation={generation}
          onClick$={() => {
            ;(globalThis as any).__fictPreviewHandler = ${JSON.stringify(handlerMarker)}
            count++
          }}
        >
          {generation}:{count}
        </button>
      )
    }
  `
}

function handlerSpecifiers(code) {
  const matches = []
  for (const match of code.matchAll(
    /["']([^"']*(?:virtual:fict-handler:|fict-handler-dev:)[^"']+)["']/g,
  )) {
    if (!matches.includes(match[1])) matches.push(match[1])
  }
  return matches
}

function handlerUrl(specifier) {
  if (specifier.startsWith('/')) return specifier
  if (specifier.startsWith('\0')) return `/@id/__x00__${specifier.slice(1)}`
  return `/@id/${specifier}`
}

const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'fict-native-vite-hmr-'))
const sourceRoot = path.join(fixtureRoot, 'src')
const mainPath = path.join(sourceRoot, 'main.tsx')
const hookPath = path.join(sourceRoot, 'use-label.ts')
const previewPath = path.join(sourceRoot, 'preview.tsx')
let delayRequest = null
let server
let browser

const delayPlugin = {
  name: 'fict-native-hmr-delay',
  enforce: 'pre',
  async transform(_code, id) {
    const request = delayRequest
    if (!request || !id.includes('/src/preview.tsx') || !id.includes('stale-request')) {
      return null
    }
    request.started.resolve()
    await request.release.promise
    return null
  },
}

try {
  await mkdir(sourceRoot, { recursive: true })
  await Promise.all([
    writeFile(
      path.join(fixtureRoot, 'package.json'),
      JSON.stringify({
        name: 'fict-native-vite-hmr-e2e',
        version: '1.0.0',
        private: true,
        type: 'module',
      }),
    ),
    writeFile(
      path.join(fixtureRoot, 'index.html'),
      `<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>Fict native HMR E2E</title></head>
          <body>
            <div id="app"></div>
            <script>
              const key = 'fict-native-hmr-loads'
              sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) || 0) + 1))
            </script>
            <script type="module" src="/src/main.tsx"></script>
          </body>
        </html>`,
    ),
    writeFile(mainPath, mainSource('main-one')),
    writeFile(hookPath, reactiveHookSource('hook-one')),
    writeFile(previewPath, previewSource('preview-one', 'handler-one')),
  ])

  server = await createServer({
    root: fixtureRoot,
    appType: 'spa',
    clearScreen: false,
    logLevel: 'silent',
    plugins: [
      delayPlugin,
      fict({
        nativeCompilerPath,
        cache: false,
        functionSplitting: false,
        resumable: true,
        autoExtractHandlers: false,
        useTypeScriptProject: false,
        publicIdentityNamespace: 'fict-native-vite-hmr-e2e@1',
      }),
    ],
    resolve: {
      alias: [
        { find: /^@fictjs\/runtime\/internal$/, replacement: runtimeInternalEntry },
        { find: /^@fictjs\/runtime\/advanced$/, replacement: runtimeAdvancedEntry },
        { find: /^@fictjs\/runtime$/, replacement: runtimeEntry },
        { find: /^fict\/internal$/, replacement: fictInternalEntry },
        { find: /^fict$/, replacement: fictEntry },
      ],
    },
    optimizeDeps: {
      exclude: ['fict', 'fict/internal', '@fictjs/runtime', '@fictjs/runtime/internal'],
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      fs: { allow: [fixtureRoot, repositoryRoot] },
    },
  })
  await server.listen()
  const address = server.httpServer?.address()
  assert.ok(address && typeof address !== 'string', 'Vite did not expose a TCP address')
  const baseUrl = `http://127.0.0.1:${address.port}`

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const unexpectedConsoleErrors = []
  const expectedConsoleErrors = []
  const unexpectedPageErrors = []
  const expectedPageErrors = []
  const failedResponses = []
  let expectedFailurePhase = false

  page.on('console', message => {
    if (message.type() !== 'error') return
    ;(expectedFailurePhase ? expectedConsoleErrors : unexpectedConsoleErrors).push(message.text())
  })
  page.on('pageerror', error => {
    ;(expectedFailurePhase ? expectedPageErrors : unexpectedPageErrors).push(error.message)
  })
  page.on('response', response => {
    if (response.status() < 400) return
    const failure = { status: response.status(), url: response.url() }
    failedResponses.push(failure)
    void response
      .text()
      .then(body => {
        failure.body = body
      })
      .catch(error => {
        failure.body = `<unavailable: ${error instanceof Error ? error.message : String(error)}>`
      })
  })

  const loadCount = () =>
    page.evaluate(() => Number(sessionStorage.getItem('fict-native-hmr-loads') ?? 0))
  const waitForState = async ({ selector, text, afterLoads }) => {
    await page.waitForFunction(
      ({ selector: target, text: expected, afterLoads: previous }) => {
        const element = document.querySelector(target)
        const loads = Number(sessionStorage.getItem('fict-native-hmr-loads') ?? 0)
        return element?.textContent?.trim() === expected && loads > previous
      },
      { afterLoads, selector, text },
      { timeout: 15_000 },
    )
    return loadCount()
  }
  const writeAndWait = async (filename, source, selector, text) => {
    const before = await loadCount()
    await writeFile(filename, source)
    return waitForState({ afterLoads: before, selector, text })
  }
  const waitForOverlay = () =>
    page.locator('vite-error-overlay').waitFor({ state: 'attached', timeout: 15_000 })
  const waitForOverlayGone = () =>
    page.locator('vite-error-overlay').waitFor({ state: 'detached', timeout: 15_000 })
  const transformPreviewArtifact = async requestPath => {
    const transformed = await server.transformRequest(requestPath)
    assert.ok(transformed, `Vite returned no transform for ${requestPath}`)
    const [specifier] = handlerSpecifiers(transformed.code)
    assert.ok(
      specifier,
      `Preview transform did not reference a handler module:\n${transformed.code}`,
    )
    const url = handlerUrl(specifier)
    const response = await fetch(new URL(url, baseUrl), { cache: 'no-store' })
    const code = await response.text()
    assert.equal(response.status, 200, code)
    return { code, specifier, transformed, url }
  }

  const navigationResponse = await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' })
  assert.equal(navigationResponse?.status(), 200)
  try {
    await page.waitForFunction(
      () => document.querySelector('#revision')?.textContent === 'main-one',
      undefined,
      { timeout: 15_000 },
    )
  } catch (error) {
    await new Promise(resolve => setTimeout(resolve, 100))
    const mainResponse = await fetch(new URL('/src/main.tsx', baseUrl), { cache: 'no-store' })
    const mainBody = await mainResponse.text()
    const pageBody = await page
      .locator('body')
      .innerText()
      .catch(() => '<unavailable>')
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        `browser URL: ${page.url()}`,
        `browser body: ${pageBody}`,
        `console errors: ${JSON.stringify(unexpectedConsoleErrors)}`,
        `page errors: ${JSON.stringify(unexpectedPageErrors)}`,
        `failed responses: ${JSON.stringify(failedResponses)}`,
        `Vite root: ${server.config.root}`,
        `Vite fs allow: ${JSON.stringify(server.config.server.fs.allow)}`,
        `Preview paths: ${previewPath} -> ${await realpath(previewPath)}`,
        `main response (${mainResponse.status}): ${mainBody}`,
      ].join('\n'),
      { cause: error },
    )
  }
  assert.equal(await page.locator('#hook-value').textContent(), 'hook-one')
  assert.equal(
    await page.locator('#preview-handler').getAttribute('data-generation'),
    'preview-one',
  )
  let loads = await loadCount()
  assert.equal(loads, 1)

  const initialMain = await server.transformRequest('/src/main.tsx')
  assert.ok(initialMain && initialMain.map && typeof initialMain.map !== 'string')
  assert.ok(initialMain.map.mappings.length > 0, 'Vite main transform returned an empty source map')
  assert.ok(
    initialMain.map.sources.some(source => source.endsWith('main.tsx')),
    JSON.stringify(initialMain.map.sources),
  )
  const servedMain = await fetch(new URL('/src/main.tsx', baseUrl))
  assert.equal(servedMain.status, 200)
  assert.match(servedMain.headers.get('content-type') ?? '', /javascript/)

  loads = await writeAndWait(mainPath, mainSource('main-two'), '#revision', 'main-two')

  loads = await writeAndWait(hookPath, plainHookSource('hook-two'), '#hook-value', 'hook-two')
  const plainImporter = await server.transformRequest('/src/main.tsx')
  assert.ok(plainImporter)
  assert.doesNotMatch(plainImporter.code, /api\.label\(\)/)

  loads = await writeAndWait(
    hookPath,
    reactiveHookSource('hook-three'),
    '#hook-value',
    'hook-three',
  )
  const reactiveImporter = await server.transformRequest('/src/main.tsx')
  assert.ok(reactiveImporter)
  assert.match(reactiveImporter.code, /api\.label\(\)/)

  const initialArtifact = await transformPreviewArtifact('/src/preview.tsx')
  assert.match(initialArtifact.code, /handler-one/)
  loads = await writeAndWait(
    previewPath,
    previewSource('preview-two', 'handler-two'),
    '#preview-handler',
    'preview-two:0',
  )
  const nextArtifact = await transformPreviewArtifact('/src/preview.tsx')
  assert.match(nextArtifact.code, /handler-two/)
  assert.doesNotMatch(nextArtifact.code, /handler-one/)
  assert.notEqual(nextArtifact.specifier, initialArtifact.specifier)

  delayRequest = { release: deferred(), started: deferred() }
  const staleTransform = server
    .transformRequest(`/src/preview.tsx?stale-request=${Date.now()}`)
    .then(value => ({ status: 'fulfilled', value }))
    .catch(error => ({ error, status: 'rejected' }))
  await withTimeout(delayRequest.started.promise, 'the deliberately delayed pre-HMR transform')
  loads = await writeAndWait(
    previewPath,
    previewSource('preview-three', 'handler-three'),
    '#preview-handler',
    'preview-three:0',
  )
  delayRequest.release.resolve()
  const staleOutcome = await withTimeout(staleTransform, 'the retired pre-HMR transform')
  delayRequest = null
  if (staleOutcome.status === 'fulfilled' && staleOutcome.value) {
    const staleSpecifiers = handlerSpecifiers(staleOutcome.value.code)
    assert.ok(
      staleSpecifiers.every(specifier => specifier !== initialArtifact.specifier),
      'A retired transform reused the initial handler generation.',
    )
  }
  const currentArtifact = await transformPreviewArtifact('/src/preview.tsx')
  assert.match(currentArtifact.code, /handler-three/)
  assert.doesNotMatch(currentArtifact.code, /handler-one|handler-two/)
  const retiredResponse = await fetch(new URL(initialArtifact.url, baseUrl), { cache: 'no-store' })
  const retiredCode = await retiredResponse.text()
  assert.ok(
    !retiredResponse.ok || !retiredCode.includes('handler-one'),
    'An expired Preview handler generation remained loadable after HMR.',
  )

  const rapidBefore = loads
  await writeFile(mainPath, mainSource('rapid-intermediate'))
  await writeFile(mainPath, mainSource('rapid-final'))
  loads = await waitForState({
    afterLoads: rapidBefore,
    selector: '#revision',
    text: 'rapid-final',
  })
  assert.notEqual(await page.locator('#revision').textContent(), 'rapid-intermediate')

  expectedFailurePhase = true
  await writeFile(mainPath, 'export const broken = ;')
  await waitForOverlay()
  const brokenLoads = await loadCount()
  await writeFile(mainPath, mainSource('recovered-main'))
  loads = await waitForState({
    afterLoads: brokenLoads,
    selector: '#revision',
    text: 'recovered-main',
  })
  await waitForOverlayGone()
  await new Promise(resolve => setTimeout(resolve, 100))
  expectedFailurePhase = false

  expectedFailurePhase = true
  await unlink(hookPath)
  await waitForOverlay()
  const deletedLoads = await loadCount()
  await writeFile(hookPath, reactiveHookSource('hook-recreated'))
  loads = await waitForState({
    afterLoads: deletedLoads,
    selector: '#hook-value',
    text: 'hook-recreated',
  })
  await waitForOverlayGone()
  await new Promise(resolve => setTimeout(resolve, 100))
  expectedFailurePhase = false

  const finalArtifact = await transformPreviewArtifact('/src/preview.tsx')
  assert.match(finalArtifact.code, /handler-three/)
  assert.equal(await page.locator('#revision').textContent(), 'recovered-main')
  assert.equal(await page.locator('#hook-value').textContent(), 'hook-recreated')
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.deepEqual(unexpectedConsoleErrors, [])
  assert.deepEqual(unexpectedPageErrors, [])
  assert.ok(loads >= 9, `Expected repeated full reloads, observed ${loads} page loads.`)

  process.stdout.write(
    `${JSON.stringify({
      backend: 'rust',
      browser: 'chromium',
      fullReloads: loads - 1,
      expectedConsoleErrors: expectedConsoleErrors.length,
      expectedPageErrors: expectedPageErrors.length,
      metadataTransitions: ['reactive-to-plain', 'plain-to-reactive'],
      previewGenerationRotated: true,
      recoveredFromCompileError: true,
      recoveredFromDeleteRecreate: true,
      sourceMapSources: initialMain.map.sources.length,
    })}\n`,
  )
} finally {
  if (delayRequest) delayRequest.release.resolve()
  await browser?.close()
  await server?.close()
  await rm(fixtureRoot, { recursive: true, force: true })
}
