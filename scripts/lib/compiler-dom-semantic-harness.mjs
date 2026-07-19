import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '../..')
const { JSDOM } = require('../../packages/runtime/node_modules/jsdom')
const runtime = require(path.join(repositoryRoot, 'packages/runtime/dist/index.cjs'))
const internal = require(path.join(repositoryRoot, 'packages/runtime/dist/internal.cjs'))

const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'Node',
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

function normalize(value, ancestors = new Set()) {
  if (value === undefined) return { $type: 'undefined' }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $type: 'nan' }
    if (value === Infinity) return { $type: 'infinity' }
    if (value === -Infinity) return { $type: '-infinity' }
    if (Object.is(value, -0)) return { $type: '-0' }
    return value
  }
  if (typeof value === 'bigint') return { $type: 'bigint', value: value.toString() }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`DOM semantic oracle cannot normalize ${typeof value} values`)
  }
  if (ancestors.has(value)) throw new TypeError('DOM semantic oracle result contains a cycle')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return Array.from(value, entry => normalize(entry, ancestors))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== null && Object.prototype.toString.call(value) !== '[object Object]') {
      throw new TypeError(
        `DOM semantic oracle result contains unsupported ${prototype?.constructor?.name ?? 'object'}`,
      )
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, normalize(value[key], ancestors)]),
    )
  } finally {
    ancestors.delete(value)
  }
}

async function flushRuntime() {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

function installDom(dom) {
  const previous = new Map()
  for (const name of DOM_GLOBALS) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    if (name in dom.window) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value: dom.window[name],
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

function requireRuntime(request) {
  if (request === 'fict' || request === '@fictjs/runtime') return runtime
  if (
    request === 'fict/internal' ||
    request === '@fictjs/runtime/internal' ||
    request === 'fict/internal/list' ||
    request === '@fictjs/runtime/internal/list'
  ) {
    return internal
  }
  throw new Error(
    `DOM semantic oracle output requested unsupported module ${JSON.stringify(request)}`,
  )
}

function loadCommonJs(code) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', `"use strict";\n${code}`)(
    requireRuntime,
    module,
    module.exports,
  )
  return module.exports
}

function query(root, selector, context) {
  const element = root.querySelector(selector)
  assert.ok(element, `${context}: missing ${selector}`)
  return element
}

export async function executeDomCommonJs(code, scenario) {
  assert.equal(typeof code, 'string')
  assert.equal(typeof scenario?.mountExport, 'string')
  assert.equal(typeof scenario?.observeExport, 'string')
  assert.ok(Array.isArray(scenario.steps))

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  })
  const restoreDom = installDom(dom)
  const root = document.createElement('div')
  const portal = document.createElement('div')
  root.dataset.oracleRoot = 'root'
  portal.dataset.oracleRoot = 'portal'
  document.body.append(root, portal)
  internal.__fictResetContext()

  let dispose
  let disposed = false
  try {
    const module = loadCommonJs(code)
    const mount = module[scenario.mountExport]
    const observe = module[scenario.observeExport]
    assert.equal(typeof mount, 'function', `missing export ${scenario.mountExport}`)
    assert.equal(typeof observe, 'function', `missing export ${scenario.observeExport}`)
    dispose = mount(root, portal, structuredClone(scenario.props ?? null))
    assert.equal(typeof dispose, 'function', `${scenario.mountExport} cleanup`)
    await flushRuntime()

    const trace = []
    for (const [index, step] of scenario.steps.entries()) {
      const context = `DOM scenario step ${index} (${step.kind})`
      switch (step.kind) {
        case 'record':
          trace.push({ label: step.label, value: normalize(observe()) })
          continue
        case 'focus':
          query(root, step.selector, context).focus()
          break
        case 'blur':
          query(root, step.selector, context).blur()
          break
        case 'click':
          query(root, step.selector, context).click()
          break
        case 'dispatch': {
          const element = query(root, step.selector, context)
          for (const [property, value] of Object.entries(step.assign ?? {})) {
            element[property] = value
          }
          const EventConstructor = dom.window[step.constructor ?? 'Event']
          assert.equal(typeof EventConstructor, 'function', `${context}: event constructor`)
          const event = new EventConstructor(step.event, step.init ?? {})
          const accepted = element.dispatchEvent(event)
          if (step.label !== undefined) {
            trace.push({
              accepted,
              defaultPrevented: event.defaultPrevented,
              label: step.label,
            })
          }
          break
        }
        case 'call': {
          const callback = module[step.exportName]
          assert.equal(typeof callback, 'function', `${context}: missing ${step.exportName}`)
          callback(...structuredClone(step.arguments ?? []))
          break
        }
        case 'dispose':
          dispose()
          disposed = true
          break
        default:
          assert.fail(`${context}: unsupported step`)
      }
      await flushRuntime()
    }
    return normalize(trace)
  } finally {
    if (!disposed && typeof dispose === 'function') dispose()
    internal.__fictResetContext()
    root.remove()
    portal.remove()
    dom.window.close()
    restoreDom()
  }
}
