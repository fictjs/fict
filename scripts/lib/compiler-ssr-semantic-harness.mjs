import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '../..')
const { JSDOM } = require('../../packages/runtime/node_modules/jsdom')
const internal = await import(
  pathToFileURL(path.join(repositoryRoot, 'packages/runtime/dist/internal.js'))
)
const loader = await import(
  pathToFileURL(path.join(repositoryRoot, 'packages/runtime/dist/experimental/loader.js'))
)
const ssr = await import(
  pathToFileURL(path.join(repositoryRoot, 'packages/ssr/dist/index.node.js'))
)

const DOM_GLOBALS = [
  'window',
  'document',
  'self',
  'navigator',
  'Node',
  'NodeFilter',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLFormElement',
  'SVGElement',
  'MathMLElement',
  'Text',
  'Comment',
  'Document',
  'DocumentFragment',
  'ShadowRoot',
  'MutationObserver',
  'Event',
  'InputEvent',
  'KeyboardEvent',
  'FocusEvent',
  'SubmitEvent',
  'CustomEvent',
]
const INTERNAL_ATTRIBUTE_NAMES = new Set(['data-fict-fine-grained', 'data-fict-h', 'data-fict-s'])

function installDom(dom) {
  const previous = new Map()
  for (const name of DOM_GLOBALS) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    const value = name === 'self' ? dom.window : dom.window[name]
    if (value !== undefined) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value,
        writable: true,
      })
    }
  }
  for (const [name, value] of [
    ['getComputedStyle', dom.window.getComputedStyle.bind(dom.window)],
    ['requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window)],
    ['cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window)],
  ]) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value, writable: true })
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
}

function publicAttributes(element) {
  return Array.from(element.attributes)
    .filter(
      attribute =>
        !INTERNAL_ATTRIBUTE_NAMES.has(attribute.name) && !attribute.name.startsWith('on:'),
    )
    .map(attribute => [attribute.name, attribute.value])
    .sort(([left], [right]) => left.localeCompare(right))
}

function snapshotNode(node) {
  if (node.nodeType === node.TEXT_NODE) return { type: 'text', value: node.data }
  if (node.nodeType !== node.ELEMENT_NODE) return null
  const element = node
  if (element.id === '__FICT_SNAPSHOT__') return null
  const result = {
    type: 'element',
    localName: element.localName,
    namespaceURI: element.namespaceURI,
    attributes: publicAttributes(element),
    children: snapshotChildren(element),
  }
  if (element.localName === 'input') {
    result.formState = {
      checked: element.checked,
      value: element.value,
    }
  }
  return result
}

function snapshotChildren(parent) {
  const children = []
  for (const node of parent.childNodes) {
    const snapshot = snapshotNode(node)
    if (!snapshot) continue
    const previous = children.at(-1)
    if (snapshot.type === 'text' && previous?.type === 'text') {
      previous.value += snapshot.value
    } else {
      children.push(snapshot)
    }
  }
  return children
}

function snapshotContainer(container) {
  return snapshotChildren(container)
}

function snapshotText(nodes) {
  return nodes
    .map(node => (node.type === 'text' ? node.value : snapshotText(node.children)))
    .join('')
}

function publicElements(container) {
  return [container, ...container.querySelectorAll('*')].filter(
    element => element.id !== '__FICT_SNAPSHOT__',
  )
}

function frameworkSummary(container) {
  const elements = [container, ...container.querySelectorAll('*')]
  const handlerAttributeCount = elements.reduce(
    (count, element) =>
      count +
      Array.from(element.attributes).filter(attribute => attribute.name.startsWith('on:')).length,
    0,
  )
  const snapshotScript = container.querySelector('#__FICT_SNAPSHOT__')
  const snapshot = snapshotScript ? JSON.parse(snapshotScript.textContent ?? '') : null
  return {
    fineGrainedRootCount: elements.filter(element => element.hasAttribute('data-fict-fine-grained'))
      .length,
    handlerAttributeCount,
    resumableHostCount: elements.filter(element => element.hasAttribute('data-fict-s')).length,
    snapshotScopeCount:
      snapshot && typeof snapshot.scopes === 'object' && snapshot.scopes !== null
        ? Object.keys(snapshot.scopes).length
        : 0,
    snapshotVersion: snapshot?.v ?? null,
  }
}

async function flushRuntime() {
  await loader.waitForPendingHandlers()
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  await Promise.resolve()
}

async function resetRuntime() {
  await loader.waitForPendingHandlers()
  loader.cleanupEventListeners()
  loader.resetHydratedScopes()
  loader.resetPrefetchedUrls()
  internal.__fictDisableResumable()
  internal.__fictDisableSSR()
  internal.__fictSetSSRState(null)
  internal.__fictResetContext()
}

function materializeModule(code, artifacts, publicModuleId) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'fict-ssr-oracle-')))
  const nodeModules = path.join(directory, 'node_modules')
  mkdirSync(nodeModules)
  symlinkSync(
    path.join(repositoryRoot, 'packages/fict'),
    path.join(nodeModules, 'fict'),
    'junction',
  )

  const entryPath = path.join(directory, 'entry.mjs')
  const entryUrl = pathToFileURL(entryPath).href
  let materializedCode = code
  const manifest = {
    [entryUrl]: entryUrl,
    [publicModuleId]: entryUrl,
  }
  for (const artifact of artifacts ?? []) {
    assert.equal(artifact.kind, 'handlerModule', `${artifact.id}: artifact kind`)
    assert.ok(artifact.handler, `${artifact.id}: handler metadata`)
    const artifactPath = path.join(directory, `${artifact.id}.mjs`)
    const artifactUrl = pathToFileURL(artifactPath).href
    manifest[artifactUrl] = artifactUrl
    writeFileSync(artifactPath, artifact.code, 'utf8')
    materializedCode = materializedCode.replaceAll(artifact.handler.moduleSpecifier, artifactUrl)
  }
  assert.equal(materializedCode.includes('fict:compiler-artifact:'), false)
  writeFileSync(entryPath, materializedCode, 'utf8')
  return {
    cleanup: () => rmSync(directory, { force: true, recursive: true }),
    entryUrl,
    manifest,
  }
}

function assertFixture(fixture) {
  assert.equal(typeof fixture?.id, 'string')
  assert.ok(['ssr', 'hydrate', 'resume'].includes(fixture.mode), `${fixture.id}: mode`)
  assert.equal(typeof fixture.source, 'string', `${fixture.id}: source`)
  assert.equal(typeof fixture.props, 'object', `${fixture.id}: props`)
  assert.equal(typeof fixture.expectedInitialText, 'string', `${fixture.id}: expected initial text`)
  assert.ok(Array.isArray(fixture.steps ?? []), `${fixture.id}: steps`)
  for (const step of fixture.steps ?? []) {
    assert.equal(typeof step.expectedText, 'string', `${fixture.id}: expected step text`)
  }
}

async function executeSteps(module, container, dom, steps) {
  const trace = []
  for (const [index, step] of (steps ?? []).entries()) {
    const context = `SSR semantic step ${index} (${step.kind})`
    if (step.kind === 'click') {
      const element = container.querySelector(step.selector)
      assert.ok(element, `${context}: missing ${step.selector}`)
      element.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }))
    } else if (step.kind === 'call') {
      const callback = module[step.exportName]
      assert.equal(typeof callback, 'function', `${context}: missing ${step.exportName}`)
      callback(...structuredClone(step.arguments ?? []))
    } else {
      assert.fail(`${context}: unsupported step`)
    }
    await flushRuntime()
    const tree = snapshotContainer(container)
    assert.equal(snapshotText(tree), step.expectedText, `${context}: text`)
    trace.push({
      kind: step.kind,
      tree,
    })
  }
  return trace
}

export async function executeSsrEsm(compiled, fixture, publicModuleId) {
  assertFixture(fixture)
  assert.equal(typeof compiled?.code, 'string')
  assert.equal(typeof publicModuleId, 'string')

  await resetRuntime()
  const materialized = materializeModule(compiled.code, compiled.artifacts, publicModuleId)
  const previousManifest = Object.getOwnPropertyDescriptor(globalThis, '__FICT_MANIFEST__')
  Object.defineProperty(globalThis, '__FICT_MANIFEST__', {
    configurable: true,
    value: materialized.manifest,
    writable: true,
  })
  let dom
  let restoreDom = () => {}
  let dispose = () => {}
  try {
    const module = await import(materialized.entryUrl)
    const App = module.App
    assert.equal(typeof App, 'function', `${fixture.id}: missing App export`)
    if (fixture.mode === 'resume') {
      const resumeKey = `${materialized.entryUrl}#__fict_r0`
      assert.equal(
        typeof internal.__fictGetResume(resumeKey),
        'function',
        `${fixture.id}: missing ${resumeKey}`,
      )
    }
    const html = ssr.renderToString(
      () => ({ type: App, props: structuredClone(fixture.props), key: undefined }),
      {
        includeSnapshot: fixture.mode === 'resume',
        manifest: materialized.manifest,
        scopeIdentifierPrefix: `oracle-${fixture.id}`,
      },
    )

    dom = new JSDOM(
      `<!doctype html><html><body><div id="oracle-root">${html}</div></body></html>`,
      {
        pretendToBeVisual: true,
        url: 'http://localhost/',
      },
    )
    restoreDom = installDom(dom)
    const container = dom.window.document.querySelector('#oracle-root')
    assert.ok(container)
    const initialElements = publicElements(container)
    const initial = {
      framework: frameworkSummary(container),
      tree: snapshotContainer(container),
    }
    assert.equal(snapshotText(initial.tree), fixture.expectedInitialText, `${fixture.id}: SSR text`)

    if (fixture.mode === 'resume') {
      assert.ok(initial.framework.handlerAttributeCount > 0, `${fixture.id}: resumable handler`)
      assert.ok(initial.framework.resumableHostCount > 0, `${fixture.id}: resumable host`)
      assert.ok(initial.framework.snapshotScopeCount > 0, `${fixture.id}: snapshot scope`)
      assert.equal(typeof initial.framework.snapshotVersion, 'number', `${fixture.id}: snapshot`)
    }

    if (fixture.mode === 'ssr') return { initial }

    const issues = []
    if (fixture.mode === 'hydrate') {
      const hydrationContainer =
        container.firstElementChild?.localName === 'fict-host'
          ? container.firstElementChild
          : container
      dispose = internal.hydrateComponent(
        () =>
          internal.createElement({
            type: App,
            props: structuredClone(fixture.props),
            key: undefined,
          }),
        hydrationContainer,
        {
          onHydrationIssue: issue =>
            issues.push({
              actual: issue.actual ?? null,
              code: issue.code,
              expected: issue.expected ?? null,
            }),
          strictHydration: true,
        },
      )
    } else {
      loader.installResumableLoader({
        document: dom.window.document,
        events: ['click'],
        onSnapshotIssue: issue =>
          issues.push({
            code: issue.code,
            eventType: issue.eventType ?? null,
            exportName: issue.exportName ?? null,
          }),
        prefetch: false,
      })
    }

    await flushRuntime()
    const claimedElements = publicElements(container)
    const claimed =
      claimedElements.length === initialElements.length &&
      claimedElements.every((element, index) => element === initialElements[index])
    const trace = await executeSteps(module, container, dom, fixture.steps)
    assert.equal(claimed, true, `${fixture.id}: existing DOM nodes were replaced`)
    assert.deepEqual(issues, [], `${fixture.id}: client issues`)
    return {
      initial,
      client: {
        claimed,
        issues,
        trace,
      },
    }
  } finally {
    dispose()
    await resetRuntime()
    restoreDom()
    dom?.window.close()
    if (previousManifest) {
      Object.defineProperty(globalThis, '__FICT_MANIFEST__', previousManifest)
    } else {
      delete globalThis.__FICT_MANIFEST__
    }
    materialized.cleanup()
  }
}

export function validateSsrSemanticFixture(fixture) {
  assertFixture(fixture)
}
