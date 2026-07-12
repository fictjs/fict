import { parentPort } from 'node:worker_threads'

import { parseHTML } from 'linkedom'
import { installResumableLoader, waitForPendingHandlers } from '@fictjs/runtime/experimental/loader'

const decoder = new TextDecoder()

function setupClientEnvironment(html) {
  const { document, window } = parseHTML(
    `<!doctype html><html><head></head><body>${html}</body></html>`,
  )

  const globals = {
    window,
    document,
    self: window,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    Text: window.Text,
    Comment: window.Comment,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
  }

  const snapshot = Object.keys(globals).map(key => ({
    key,
    exists: Object.prototype.hasOwnProperty.call(globalThis, key),
    value: globalThis[key],
  }))

  for (const [key, value] of Object.entries(globals)) {
    if (value !== undefined) {
      globalThis[key] = value
    }
  }

  const cleanup = async () => {
    await waitForPendingHandlers()
    for (const entry of snapshot) {
      if (entry.exists) {
        globalThis[entry.key] = entry.value
      } else {
        delete globalThis[entry.key]
      }
    }
  }

  return { document, window, cleanup }
}

function installMutationObserverStub() {
  const original = globalThis.MutationObserver
  const observers = []

  class TestMutationObserver {
    constructor(callback) {
      this.callback = callback
      this.disconnected = false
      observers.push(this)
    }
    observe() {}
    disconnect() {
      this.disconnected = true
    }
  }

  globalThis.MutationObserver = TestMutationObserver

  const notify = nodes => {
    if (!nodes || nodes.length === 0) return
    for (const observer of observers) {
      if (!observer.disconnected) {
        observer.callback([{ addedNodes: nodes }], observer)
      }
    }
  }

  const restore = () => {
    if (original) {
      globalThis.MutationObserver = original
    } else {
      delete globalThis.MutationObserver
    }
  }

  return { notify, restore }
}

function applyStreamPatch(document, win, id) {
  const tpl = document.querySelector(`template[data-fict-suspense="${id}"]`)
  if (!tpl) return

  let start = null
  let end = null
  const showComment = win.NodeFilter?.SHOW_COMMENT ?? 128
  const walker = document.createTreeWalker(document, showComment)
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node.data === `fict:suspense-start:${id}`) start = node
    if (node.data === `fict:suspense-end:${id}`) end = node
    if (start && end) break
  }
  if (!start || !end || !end.parentNode) return

  let node = start.nextSibling
  while (node && node !== end) {
    const next = node.nextSibling
    node.parentNode?.removeChild(node)
    node = next
  }

  const fragment = tpl.content ?? document.createRange().createContextualFragment(tpl.innerHTML)
  end.parentNode.insertBefore(fragment, end)
  tpl.parentNode?.removeChild(tpl)
}

function dispatchClick(element, window) {
  const event = new window.Event('click', { bubbles: true, cancelable: true })
  element.dispatchEvent(event)
}

async function tick(count = 1) {
  await waitForPendingHandlers()
  for (let i = 0; i < count; i++) {
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    await Promise.resolve()
  }
}

let env = null
let notifyMutationObserver = null
let restoreMutationObserver = null

function appendChunk(html) {
  if (!env || !html) return
  const fragment = env.document.createRange().createContextualFragment(html)
  const addedNodes = Array.from(fragment.childNodes)
  env.document.body.appendChild(fragment)
  notifyMutationObserver?.(addedNodes)
  const templates = Array.from(env.document.querySelectorAll('template[data-fict-suspense]'))
  for (const template of templates) {
    const id = template.getAttribute('data-fict-suspense')
    if (id) {
      applyStreamPatch(env.document, env.window, id)
    }
  }
}

async function getButtonText(selector) {
  if (!env) return null
  const button = env.document.querySelector(selector)
  return button?.textContent ?? null
}

async function clickButton(selector) {
  if (!env) return null
  const button = env.document.querySelector(selector)
  if (!button) return null
  dispatchClick(button, env.window)
  await tick(3)
  return button.textContent ?? null
}

parentPort?.on('message', async message => {
  const { id, type, payload } = message ?? {}
  try {
    let result = null
    if (type === 'init') {
      const observerStub = installMutationObserverStub()
      notifyMutationObserver = observerStub.notify
      restoreMutationObserver = observerStub.restore
      if (payload?.manifest) {
        globalThis.__FICT_MANIFEST__ = payload.manifest
      }
      env = setupClientEnvironment(payload?.html ?? '')
      installResumableLoader({ document: env.document, events: ['click'] })
      result = true
    } else if (type === 'chunk') {
      appendChunk(payload?.html ?? '')
      result = true
    } else if (type === 'getText') {
      result = await getButtonText(payload?.selector ?? '')
    } else if (type === 'click') {
      result = await clickButton(payload?.selector ?? '')
    } else if (type === 'dispose') {
      restoreMutationObserver?.()
      await env?.cleanup?.()
      env = null
      result = true
    }
    parentPort?.postMessage({ id, ok: true, result })
  } catch (err) {
    parentPort?.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
})
