#!/usr/bin/env node

import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
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
const { createLogger, createServer } = await import(
  pathToFileURL(requireFromVitePlugin.resolve('vite')).href
)
const nativeCompilerPath = path.resolve(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(repositoryRoot, 'target', 'release', 'fict_compiler_napi.node'),
)
const fictEntry = path.join(repositoryRoot, 'packages', 'fict', 'dist', 'index.js')
const fictInternalEntry = path.join(repositoryRoot, 'packages', 'fict', 'dist', 'internal.js')
const runtimeEntry = path.join(repositoryRoot, 'packages', 'runtime', 'dist', 'index.js')
const runtimeAdvancedEntry = path.join(repositoryRoot, 'packages', 'runtime', 'dist', 'advanced.js')
const runtimeInternalEntry = path.join(repositoryRoot, 'packages', 'runtime', 'dist', 'internal.js')
const diagnosticsRoot = path.resolve(
  process.env.FICT_VITE_HMR_DIAGNOSTICS_DIR ??
    path.join(repositoryRoot, 'test-results', 'native-vite-hmr'),
)

// Chokidar 3 suppresses repeated same-path change events for 50 ms. The browser error
// overlay can appear before that server-side window expires, so it is not a safe barrier
// for the recovery write. Wait twice the dependency's throttle window from the event that
// Vite actually observed.
const watcherChangeQuietMs = 100
const traceStartedAt = performance.now()
const traceElapsedMs = () => Number((performance.now() - traceStartedAt).toFixed(3))

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

function serializeError(error, depth = 0) {
  if (!(error instanceof Error)) return { message: String(error) }
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause && depth < 3 ? { cause: serializeError(error.cause, depth + 1) } : {}),
  }
}

function boundedText(value, limit = 8_000) {
  if (typeof value !== 'string' || value.length <= limit) return value
  return `${value.slice(0, limit)}\n<truncated ${value.length - limit} characters>`
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
let page
let baseUrl
let expectedFailurePhase = false
let currentPhase = 'fixture-setup'
let currentExpectation = null
let watcherSequence = 0

const watcherEvents = []
const watcherSubscribers = new Set()
const hmrUpdates = []
const viteLogs = []
const unexpectedConsoleErrors = []
const expectedConsoleErrors = []
const unexpectedPageErrors = []
const expectedPageErrors = []
const failedResponses = []

const normalizeWatcherPath = filename =>
  path.normalize(path.isAbsolute(filename) ? filename : path.resolve(fixtureRoot, filename))

function recordWatcherEvent(event, filename) {
  const entry = {
    sequence: ++watcherSequence,
    event,
    path: normalizeWatcherPath(filename),
    elapsedMs: traceElapsedMs(),
  }
  watcherEvents.push(entry)
  if (watcherEvents.length > 200) watcherEvents.shift()
  for (const subscriber of watcherSubscribers) subscriber(entry)
}

function waitForWatcherEvent({ filename, events, afterSequence, description }) {
  const expectedEvents = new Set(events)
  const expectedPath = normalizeWatcherPath(filename)
  const matches = entry =>
    entry.sequence > afterSequence && expectedEvents.has(entry.event) && entry.path === expectedPath
  const existing = watcherEvents.find(matches)
  if (existing) return Promise.resolve(existing)

  const pending = deferred()
  const subscriber = entry => {
    if (!matches(entry)) return
    watcherSubscribers.delete(subscriber)
    pending.resolve(entry)
  }
  watcherSubscribers.add(subscriber)
  return withTimeout(pending.promise, description).finally(() => {
    watcherSubscribers.delete(subscriber)
  })
}

async function writeAndObserve(filename, source, { events = ['change'], description } = {}) {
  const afterSequence = watcherSequence
  await writeFile(filename, source)
  return waitForWatcherEvent({
    filename,
    events,
    afterSequence,
    description: description ?? `${events.join('/')} for ${path.basename(filename)}`,
  })
}

async function waitForWatcherQuietPeriod(event) {
  while (true) {
    const remainingMs = event.elapsedMs + watcherChangeQuietMs - traceElapsedMs()
    if (remainingMs <= 0) return
    await new Promise(resolve => setTimeout(resolve, Math.ceil(remainingMs)))
  }
}

const viteLogger = createLogger('silent')
for (const level of ['info', 'warn', 'error']) {
  const original = viteLogger[level].bind(viteLogger)
  viteLogger[level] = (message, options) => {
    viteLogs.push({
      level,
      message: boundedText(message),
      elapsedMs: traceElapsedMs(),
      ...(options?.error ? { error: serializeError(options.error) } : {}),
    })
    if (viteLogs.length > 200) viteLogs.shift()
    original(message, options)
  }
}

const hmrTracePlugin = {
  name: 'fict-native-hmr-trace',
  hotUpdate(context) {
    hmrUpdates.push({
      file: normalizeWatcherPath(context.file),
      modules: context.modules.map(module => module.url),
      elapsedMs: traceElapsedMs(),
    })
    if (hmrUpdates.length > 200) hmrUpdates.shift()
  },
}

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

async function captureBrowserState() {
  if (!page) return { available: false }
  try {
    return await page.evaluate(() => {
      const overlay = document.querySelector('vite-error-overlay')
      const text = selector => document.querySelector(selector)?.textContent?.trim() ?? null
      return {
        available: true,
        url: location.href,
        loadCount: Number(sessionStorage.getItem('fict-native-hmr-loads') ?? 0),
        revision: text('#revision'),
        hookValue: text('#hook-value'),
        preview: text('#preview-handler'),
        overlayCount: document.querySelectorAll('vite-error-overlay').length,
        overlayText: (overlay?.shadowRoot?.textContent ?? overlay?.textContent ?? '')
          .trim()
          .slice(0, 8_000),
        bodyText: (document.body?.innerText ?? '').slice(0, 8_000),
        html: document.documentElement.outerHTML.slice(0, 20_000),
      }
    })
  } catch (error) {
    return { available: false, error: serializeError(error), url: page.url() }
  }
}

async function captureFixtureSources() {
  const entries = await Promise.all(
    [mainPath, hookPath, previewPath].map(async filename => {
      try {
        return [path.relative(fixtureRoot, filename), boundedText(await readFile(filename, 'utf8'))]
      } catch (error) {
        return [path.relative(fixtureRoot, filename), { error: serializeError(error) }]
      }
    }),
  )
  return Object.fromEntries(entries)
}

async function writeFailureDiagnostics(error) {
  await mkdir(diagnosticsRoot, { recursive: true })
  const screenshotPath = path.join(diagnosticsRoot, 'failure.png')
  let screenshot = path.relative(repositoryRoot, screenshotPath)
  if (!page) {
    screenshot = { unavailable: 'browser page was not created' }
  } else {
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true })
    } catch (screenshotError) {
      screenshot = { error: serializeError(screenshotError) }
    }
  }

  const browserState = await captureBrowserState()
  const report = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    phase: currentPhase,
    expectation: currentExpectation,
    error: serializeError(error),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      ci: Boolean(process.env.CI),
      githubActions: Boolean(process.env.GITHUB_ACTIONS),
    },
    paths: {
      fixtureRoot,
      diagnosticsRoot,
      screenshot,
    },
    browser: browserState,
    fixtureSources: await captureFixtureSources(),
    trace: {
      watcherEvents,
      hmrUpdates,
      viteLogs,
      expectedConsoleErrors: expectedConsoleErrors.map(value => boundedText(value)),
      unexpectedConsoleErrors: unexpectedConsoleErrors.map(value => boundedText(value)),
      expectedPageErrors: expectedPageErrors.map(value => boundedText(value)),
      unexpectedPageErrors: unexpectedPageErrors.map(value => boundedText(value)),
      failedResponses: failedResponses.map(response => ({
        ...response,
        ...(response.body ? { body: boundedText(response.body) } : {}),
      })),
    },
  }
  const reportPath = path.join(diagnosticsRoot, 'failure.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stderr.write(
    [
      `Native Vite HMR diagnostics: ${reportPath}`,
      `phase: ${currentPhase}`,
      `expectation: ${JSON.stringify(currentExpectation)}`,
      `browser: ${JSON.stringify(browserState)}`,
    ].join('\n') + '\n',
  )
}

try {
  currentPhase = 'dependency-access-check'
  await Promise.all([
    access(nativeCompilerPath),
    access(fictEntry),
    access(fictInternalEntry),
    access(runtimeEntry),
    access(runtimeAdvancedEntry),
    access(runtimeInternalEntry),
  ])

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
    customLogger: viteLogger,
    plugins: [
      delayPlugin,
      hmrTracePlugin,
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
  for (const event of ['add', 'change', 'unlink']) {
    server.watcher.on(event, filename => recordWatcherEvent(event, filename))
  }
  await server.listen()
  const address = server.httpServer?.address()
  assert.ok(address && typeof address !== 'string', 'Vite did not expose a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()

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
  const waitForState = async ({ selector, text, afterLoads, description }) => {
    currentPhase = description
    currentExpectation = { selector, text, afterLoads }
    try {
      await page.waitForFunction(
        ({ selector: target, text: expected, afterLoads: previous }) => {
          const element = document.querySelector(target)
          const loads = Number(sessionStorage.getItem('fict-native-hmr-loads') ?? 0)
          return element?.textContent?.trim() === expected && loads > previous
        },
        { afterLoads, selector, text },
        { timeout: 15_000 },
      )
    } catch (error) {
      const observed = await captureBrowserState()
      throw new Error(`Failed waiting for ${description}. Observed: ${JSON.stringify(observed)}`, {
        cause: error,
      })
    }
    const observedLoads = await loadCount()
    currentExpectation = null
    return observedLoads
  }
  const writeAndWait = async (filename, source, selector, text) => {
    const before = await loadCount()
    const description = `${path.basename(filename)} to render ${selector}=${JSON.stringify(text)}`
    currentPhase = `write:${description}`
    const watcherEvent = await writeAndObserve(filename, source, {
      description: `change event for ${description}`,
    })
    const observedLoads = await waitForState({ afterLoads: before, selector, text, description })
    await waitForWatcherQuietPeriod(watcherEvent)
    return observedLoads
  }
  const waitForOverlayState = async (state, description) => {
    currentPhase = description
    currentExpectation = { overlay: state }
    try {
      await page.locator('vite-error-overlay').waitFor({ state, timeout: 15_000 })
    } catch (error) {
      const observed = await captureBrowserState()
      throw new Error(`Failed waiting for ${description}. Observed: ${JSON.stringify(observed)}`, {
        cause: error,
      })
    }
    currentExpectation = null
  }
  const waitForOverlay = description => waitForOverlayState('attached', description)
  const waitForOverlayGone = description => waitForOverlayState('detached', description)
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

  currentPhase = 'initial-page-load'
  currentExpectation = { selector: '#revision', text: 'main-one' }
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
  currentExpectation = null
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

  currentPhase = 'rapid-write-coalescing'
  const rapidBefore = loads
  const beforeRapidSequence = watcherSequence
  await writeFile(mainPath, mainSource('rapid-intermediate'))
  await writeFile(mainPath, mainSource('rapid-final'))
  const rapidChange = await waitForWatcherEvent({
    filename: mainPath,
    events: ['change'],
    afterSequence: beforeRapidSequence,
    description: 'the coalesced change event for rapid main-module writes',
  })
  loads = await waitForState({
    afterLoads: rapidBefore,
    selector: '#revision',
    text: 'rapid-final',
    description: 'rapid writes to settle on the final main revision',
  })
  await waitForWatcherQuietPeriod(rapidChange)
  assert.notEqual(await page.locator('#revision').textContent(), 'rapid-intermediate')

  expectedFailurePhase = true
  currentPhase = 'compile-error:write-invalid-main'
  const brokenChange = await writeAndObserve(mainPath, 'export const broken = ;', {
    description: 'change event for the deliberately invalid main module',
  })
  await waitForOverlay('the compile-error overlay to appear')
  await waitForWatcherQuietPeriod(brokenChange)
  const brokenLoads = await loadCount()
  currentPhase = 'compile-error:write-recovered-main'
  const recoveredChange = await writeAndObserve(mainPath, mainSource('recovered-main'), {
    description: 'change event for the recovered main module',
  })
  const compileErrorRecoveryWatcherGapMs = Number(
    (recoveredChange.elapsedMs - brokenChange.elapsedMs).toFixed(3),
  )
  assert.ok(
    compileErrorRecoveryWatcherGapMs >= watcherChangeQuietMs,
    `Expected the recovery change after the watcher quiet window, observed ${compileErrorRecoveryWatcherGapMs} ms.`,
  )
  loads = await waitForState({
    afterLoads: brokenLoads,
    selector: '#revision',
    text: 'recovered-main',
    description: 'the main module to recover from its compile error',
  })
  await waitForOverlayGone('the compile-error overlay to disappear')
  await new Promise(resolve => setTimeout(resolve, 100))
  expectedFailurePhase = false

  expectedFailurePhase = true
  currentPhase = 'delete-recreate:delete-hook'
  const beforeDeleteSequence = watcherSequence
  await unlink(hookPath)
  const deleteEvent = await waitForWatcherEvent({
    filename: hookPath,
    events: ['unlink'],
    afterSequence: beforeDeleteSequence,
    description: 'unlink event for the deleted hook module',
  })
  await waitForOverlay('the deleted-module overlay to appear')
  await waitForWatcherQuietPeriod(deleteEvent)
  const deletedLoads = await loadCount()
  currentPhase = 'delete-recreate:restore-hook'
  await writeAndObserve(hookPath, reactiveHookSource('hook-recreated'), {
    events: ['add', 'change'],
    description: 'add/change event for the recreated hook module',
  })
  loads = await waitForState({
    afterLoads: deletedLoads,
    selector: '#hook-value',
    text: 'hook-recreated',
    description: 'the recreated hook module to render',
  })
  await waitForOverlayGone('the deleted-module overlay to disappear')
  await new Promise(resolve => setTimeout(resolve, 100))
  expectedFailurePhase = false

  currentPhase = 'final-assertions'
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
      compileErrorRecoveryWatcherGapMs,
      watcherEvents: watcherEvents.length,
      hmrUpdates: hmrUpdates.length,
    })}\n`,
  )
} catch (error) {
  try {
    await writeFailureDiagnostics(error)
  } catch (diagnosticError) {
    process.stderr.write(
      `Failed to write native Vite HMR diagnostics: ${JSON.stringify(
        serializeError(diagnosticError),
      )}\n`,
    )
  }
  throw error
} finally {
  if (delayRequest) delayRequest.release.resolve()
  await browser?.close()
  await server?.close()
  await rm(fixtureRoot, { recursive: true, force: true })
}
