import { DelegatedEvents } from './constants'
import {
  __fictEnableResumable,
  __fictEnsureScope,
  __fictGetSSRScope,
  __fictSetSSRState,
  __fictUseLexicalScope,
} from './resume'

export interface ResumableLoaderOptions {
  document?: Document
  snapshotScriptId?: string
  events?: string[]
}

const hydratedScopes = new Set<string>()

export function installResumableLoader(options: ResumableLoaderOptions = {}): void {
  const doc = options.document ?? window.document
  const scriptId = options.snapshotScriptId ?? '__FICT_SNAPSHOT__'

  const snapshotEl = doc.getElementById(scriptId)
  if (snapshotEl?.textContent) {
    try {
      const state = JSON.parse(snapshotEl.textContent)
      __fictSetSSRState(state)
    } catch {
      // ignore malformed snapshot
    }
  }

  __fictEnableResumable()

  const events = options.events ?? Array.from(DelegatedEvents)
  for (const eventName of events) {
    doc.addEventListener(eventName, handleResumableEvent, true)
  }
}

async function handleResumableEvent(event: Event): Promise<void> {
  const path =
    typeof event.composedPath === 'function' ? event.composedPath() : buildEventPath(event)
  for (const node of path) {
    if (!(node instanceof Element)) continue
    const qrl = node.getAttribute(`on:${event.type}`)
    if (!qrl) continue

    const host = node.closest('[data-fict-s]') as Element | null
    if (!host) continue
    const scopeId = host.getAttribute('data-fict-s')
    if (!scopeId) continue

    const snapshot = __fictGetSSRScope(scopeId)
    if (snapshot) {
      __fictEnsureScope(scopeId, host, snapshot)
    }

    const { url, exportName } = parseQrl(qrl)

    // Pre-emptively prevent default on navigations/forms while we await modules
    if (event.cancelable && (event.type === 'click' || event.type === 'submit')) {
      const tag = node.tagName.toLowerCase()
      if (tag === 'a' || tag === 'form') {
        event.preventDefault()
      }
    }

    const mod = await import(/* @vite-ignore */ url)
    const handler = (mod as Record<string, unknown>)[exportName]
    if (typeof handler === 'function') {
      await (handler as (scopeId: string, ev: Event, el: Element) => unknown)(scopeId, event, node)
    }

    if (!hydratedScopes.has(scopeId)) {
      const resumeQrl = host.getAttribute('data-fict-h')
      if (resumeQrl) {
        const { url: resumeUrl, exportName: resumeExport } = parseQrl(resumeQrl)
        const resumeMod = await import(/* @vite-ignore */ resumeUrl)
        const resumeFn = (resumeMod as Record<string, unknown>)[resumeExport]
        if (typeof resumeFn === 'function') {
          await (resumeFn as (scopeId: string, host: Element) => unknown)(scopeId, host)
          hydratedScopes.add(scopeId)
        }
      }
    }

    return
  }
}

function parseQrl(qrl: string): { url: string; exportName: string } {
  const [ref] = qrl.split('[')
  if (!ref) {
    return { url: '', exportName: 'default' }
  }
  const hashIndex = ref.lastIndexOf('#')
  if (hashIndex === -1) {
    return { url: ref, exportName: 'default' }
  }
  return { url: ref.slice(0, hashIndex), exportName: ref.slice(hashIndex + 1) }
}

function buildEventPath(event: Event): EventTarget[] {
  const path: EventTarget[] = []
  let node: EventTarget | null = event.target
  while (node) {
    path.push(node)
    node = (node as Node).parentNode
  }
  path.push(window)
  return path
}

// Re-export for handler authors (optional)
export { __fictUseLexicalScope } from './resume'
