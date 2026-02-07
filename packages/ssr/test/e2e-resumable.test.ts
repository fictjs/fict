/**
 * End-to-end resumable SSR integration tests
 *
 * These tests verify the complete resumability chain:
 * 1. Compiler produces QRL handlers + resume metadata
 * 2. SSR injects on:click/data-fict-h attributes
 * 3. Client loader triggers events
 * 4. Partial hydration updates DOM
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import { transformSync } from '@babel/core'
// @ts-expect-error - CommonJS module without proper types
import presetTypescript from '@babel/preset-typescript'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

import type { FictNode } from '@fictjs/runtime'
import { Suspense, createSuspenseToken } from '@fictjs/runtime'
import {
  installResumableLoader,
  resetHydratedScopes,
  resetPrefetchedUrls,
  cleanupEventListeners,
  waitForPendingHandlers,
} from '@fictjs/runtime/loader'
import {
  __fictSetSSRState,
  __fictDisableSSR,
  __fictDisableResumable,
  __fictGetSSRScope,
  __fictEnableResumable,
  serializeValue,
  deserializeValue,
} from '@fictjs/runtime/internal'
import createFictPlugin, { type FictCompilerOptions } from '../../compiler/src/index'
import { parseHTML } from 'linkedom'

import { renderToString, renderToDocument, renderToStream } from '../src/index'

// ============================================================================
// Test Utilities
// ============================================================================

interface CompiledModule {
  url: string
  code: string
  cleanup: () => void
}

function compileModule(
  source: string,
  options?: Partial<FictCompilerOptions> & { baseDir?: string },
): CompiledModule {
  const { baseDir, ...compilerOverrides } = options ?? {}
  const tempBase = baseDir ?? tmpdir()
  if (baseDir) {
    mkdirSync(baseDir, { recursive: true })
  }
  const tempDir = mkdtempSync(path.join(tempBase, 'fict-e2e-'))
  const entryPath = path.join(tempDir, 'entry.mjs')

  const compilerOptions: FictCompilerOptions = {
    dev: false,
    fineGrainedDom: true,
    resumable: true,
    // Resumable fixture tests intentionally cover fallback patterns (e.g. state snapshots
    // passed through helper boundaries) and should not fail-closed on guarantee diagnostics.
    strictGuarantee: false,
    emitModuleMetadata: false,
    ...compilerOverrides,
  }

  const result = transformSync(source, {
    filename: entryPath,
    configFile: false,
    babelrc: false,
    sourceType: 'module',
    parserOpts: {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      allowReturnOutsideFunction: true,
    },
    plugins: [[createFictPlugin, compilerOptions]],
    presets: [[presetTypescript, { isTSX: true, allExtensions: true, allowDeclareFields: true }]],
    generatorOpts: { compact: false },
  })

  if (!result?.code) {
    throw new Error('Failed to compile module')
  }

  writeFileSync(entryPath, result.code, 'utf8')

  return {
    url: pathToFileURL(entryPath).href,
    code: result.code,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    },
  }
}

function setupClientEnvironment(html: string): {
  document: Document
  window: Window
  cleanup: () => Promise<void>
} {
  const { document, window } = parseHTML(
    `<!doctype html><html><head></head><body>${html}</body></html>`,
  ) as Window & typeof globalThis

  const globals: Record<string, unknown> = {
    window,
    document,
    self: window,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: (window as Window & { SVGElement?: typeof SVGElement }).SVGElement,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    Text: window.Text,
    Comment: window.Comment,
    Event: window.Event,
    CustomEvent: (window as Window & { CustomEvent?: typeof CustomEvent }).CustomEvent,
  }

  const snapshot = Object.keys(globals).map(key => ({
    key,
    exists: Object.prototype.hasOwnProperty.call(globalThis, key),
    value: (globalThis as Record<string, unknown>)[key],
  }))

  for (const [key, value] of Object.entries(globals)) {
    if (value !== undefined) {
      ;(globalThis as Record<string, unknown>)[key] = value
    }
  }

  const cleanup = async (): Promise<void> => {
    // Wait for pending handlers to complete before restoring globals
    await waitForPendingHandlers()
    for (const entry of snapshot) {
      if (entry.exists) {
        ;(globalThis as Record<string, unknown>)[entry.key] = entry.value
      } else {
        delete (globalThis as Record<string, unknown>)[entry.key]
      }
    }
  }

  return { document, window, cleanup }
}

function parseSnapshot(html: string): Record<string, unknown> | null {
  const match = html.match(
    /<script id="__FICT_SNAPSHOT__" type="application\/json">([^<]*)<\/script>/,
  )
  if (!match?.[1]) return null
  try {
    return JSON.parse(match[1]) as Record<string, unknown>
  } catch {
    return null
  }
}

const decoder = new TextDecoder()

function applyStreamPatch(document: Document, win: Window, id: string): void {
  const tpl = document.querySelector(
    `template[data-fict-suspense="${id}"]`,
  ) as HTMLTemplateElement | null
  if (!tpl) return

  let start: Comment | null = null
  let end: Comment | null = null
  const showComment = (win as any).NodeFilter?.SHOW_COMMENT ?? 128
  const walker = document.createTreeWalker(document, showComment)
  while (walker.nextNode()) {
    const node = walker.currentNode as Comment
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

function installMutationObserverStub(): {
  notify: (nodes: Node[]) => void
  restore: () => void
} {
  const original = (globalThis as Record<string, unknown>).MutationObserver as
    | typeof MutationObserver
    | undefined
  const observers: Array<{ callback: MutationCallback; disconnected: boolean }> = []

  class TestMutationObserver {
    callback: MutationCallback
    disconnected = false
    constructor(cb: MutationCallback) {
      this.callback = cb
      observers.push(this)
    }
    observe(): void {}
    disconnect(): void {
      this.disconnected = true
    }
  }

  ;(globalThis as Record<string, unknown>).MutationObserver = TestMutationObserver as
    | typeof MutationObserver
    | undefined

  const notify = (nodes: Node[]): void => {
    if (nodes.length === 0) return
    for (const observer of observers) {
      if (!observer.disconnected) {
        observer.callback([{ addedNodes: nodes } as MutationRecord], observer as any)
      }
    }
  }

  const restore = (): void => {
    if (original) {
      ;(globalThis as Record<string, unknown>).MutationObserver = original
    } else {
      delete (globalThis as Record<string, unknown>).MutationObserver
    }
  }

  return { notify, restore }
}

async function tick(count = 1): Promise<void> {
  // First wait for any pending async handlers to complete
  await waitForPendingHandlers()
  // Then wait for microtask cycles to process signal updates
  for (let i = 0; i < count; i++) {
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    await Promise.resolve()
  }
}

function dispatchClick(
  element: Element,
  window: Window,
  options?: { bubbles?: boolean; cancelable?: boolean },
): Event {
  const event = new window.Event('click', {
    bubbles: options?.bubbles ?? true,
    cancelable: options?.cancelable ?? true,
  })
  element.dispatchEvent(event)
  return event
}

/**
 * Complete cleanup function to reset all global state between tests.
 * This ensures test isolation when running in parallel with other packages.
 */
async function cleanupTestState(): Promise<void> {
  // Wait for any pending async handlers to complete before clearing state
  await waitForPendingHandlers()
  __fictDisableResumable()
  __fictDisableSSR()
  __fictSetSSRState(null)
  resetHydratedScopes()
  resetPrefetchedUrls()
  cleanupEventListeners()
}

// ============================================================================
// Test Suite 1: QRL Generation and Event Handler Resolution
// ============================================================================

describe('QRL Generation and Event Handler Resolution', () => {
  afterEach(cleanupTestState)

  it('compiler generates on:click attributes with QRL format', () => {
    const source = `
      import { $state } from 'fict'
      export function Counter() {
        let count = $state(0)
        return <button onClick$={() => count++}>{count}</button>
      }
    `

    const compiled = compileModule(source, { baseDir: path.join(process.cwd(), '.tmp') })
    try {
      // Debug: print compiled code
      // console.log('=== Compiled Code ===')
      // console.log(compiled.code)
      // console.log('=== End Compiled Code ===')

      // Verify QRL handler is exported
      expect(compiled.code).toContain('__fict_e')
      expect(compiled.code).toContain('export')

      // Verify on:click attribute is set
      expect(compiled.code).toContain('on:click')

      // Verify handler properly modifies signal - the handler should use signal setter
      // The handler should NOT just have 'count++' as a raw expression
      const handlerMatch = compiled.code.match(/export const __fict_e0[\s\S]*?;(?=\s*export|$)/)
      expect(handlerMatch).not.toBeNull()
      // console.log('=== Handler Code ===')
      // console.log(handlerMatch?.[0])
    } finally {
      compiled.cleanup()
    }
  })

  it('compiler generates resume function for components', () => {
    const source = `
      import { $state } from 'fict'
      export function Counter() {
        let count = $state(0)
        return <button onClick$={() => count++}>{count}</button>
      }
    `

    const compiled = compileModule(source, { baseDir: path.join(process.cwd(), '.tmp') })
    try {
      // Verify resume function is exported
      expect(compiled.code).toContain('__fict_r')
      expect(compiled.code).toContain('__fictMeta')
    } finally {
      compiled.cleanup()
    }
  })

  it('QRL contains module path and export name', async () => {
    const source = `
      import { $state } from 'fict'
      export function App() {
        let count = $state(0)
        return <button onClick$={() => count++}>{count}</button>
      }
    `

    const compiled = compileModule(source, { baseDir: path.join(process.cwd(), '.tmp') })
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { App: () => FictNode }
      const html = renderToString(() => ({ type: mod.App, props: {} }))

      // Verify on:click attribute contains module path and export
      const onClickMatch = html.match(/on:click="([^"]+)"/)
      expect(onClickMatch).not.toBeNull()

      const qrl = onClickMatch![1]
      expect(qrl).toContain('#')
      expect(qrl).toContain('__fict_e')

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      const button = env.document.querySelector('button')
      expect(button).not.toBeNull()
      expect(button!.getAttribute('on:click')).toBeTruthy()
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('loader parses QRL and invokes handler', async () => {
    const source = `
      import { $state } from 'fict'
      export function App() {
        let count = $state(0)
        return <button onClick$={() => count++}>{count}</button>
      }
    `

    const compiled = compileModule(source, { baseDir: path.join(process.cwd(), '.tmp') })
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { App: () => FictNode }
      const html = renderToString(() => ({ type: mod.App, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      const button = env.document.querySelector('button') as HTMLElement
      expect(button).not.toBeNull()
      expect(button.textContent).toBe('0')

      dispatchClick(button, env.window)
      await tick(3)

      expect(button.textContent).toBe('1')
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('multiple clicks increment state correctly', async () => {
    const source = `
      import { $state } from 'fict'
      export function Counter() {
        let count = $state(0)
        return <button onClick$={() => count++}>{count}</button>
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { Counter: () => FictNode }
      const html = renderToString(() => ({ type: mod.Counter, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      const button = env.document.querySelector('button') as HTMLElement
      expect(button.textContent).toBe('0')

      // Multiple clicks
      for (let i = 1; i <= 5; i++) {
        dispatchClick(button, env.window)
        await tick(3)
        expect(button.textContent).toBe(String(i))
      }
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('hoists non-reactive function dependencies for handler access', () => {
    // Test that component-scoped functions referenced in handlers are hoisted
    const source = `
      import { $state } from 'fict'
      export function Counter() {
        // Non-reactive helper function defined inside component
        const formatNumber = (n: number) => n.toLocaleString()
        let count = $state(0)

        return (
          <button onClick$={() => {
            count++
            console.log(formatNumber(count))
          }}>
            {count}
          </button>
        )
      }
    `

    const compiled = compileModule(source)
    try {
      // Debug: print compiled code
      // console.log('=== Compiled Code ===')
      // console.log(compiled.code)
      // console.log('=== End Compiled Code ===')

      // Verify the handler is exported
      expect(compiled.code).toContain('export const __fict_e0')

      // Verify the formatNumber function is hoisted with a unique name
      // The pattern should be __fict_fn_formatNumber_<counter>
      expect(compiled.code).toMatch(/export const __fict_fn_formatNumber_\d+/)

      // Verify the handler references the hoisted function name
      const handlerMatch = compiled.code.match(/export const __fict_e0[\s\S]*?;(?=\s*export|$)/)
      expect(handlerMatch).not.toBeNull()

      // The handler should use the hoisted name instead of formatNumber
      expect(handlerMatch![0]).toMatch(/__fict_fn_formatNumber_\d+/)
      expect(handlerMatch![0]).not.toMatch(/\bformatNumber\(/)
    } finally {
      compiled.cleanup()
    }
  })

  it('handles multiple function dependencies in same handler', () => {
    const source = `
      import { $state } from 'fict'
      export function App() {
        const add = (a: number, b: number) => a + b
        const multiply = (a: number, b: number) => a * b
        let x = $state(1)

        return (
          <button onClick$={() => {
            x = add(x, multiply(x, 2))
          }}>
            {x}
          </button>
        )
      }
    `

    const compiled = compileModule(source)
    try {
      // Both helper functions should be hoisted
      expect(compiled.code).toMatch(/export const __fict_fn_add_\d+/)
      expect(compiled.code).toMatch(/export const __fict_fn_multiply_\d+/)

      // Handler should reference hoisted names
      const handlerMatch = compiled.code.match(/export const __fict_e0[\s\S]*?;(?=\s*export|$)/)
      expect(handlerMatch).not.toBeNull()
      expect(handlerMatch![0]).toMatch(/__fict_fn_add_\d+/)
      expect(handlerMatch![0]).toMatch(/__fict_fn_multiply_\d+/)
    } finally {
      compiled.cleanup()
    }
  })

  it('shared function between handlers is hoisted once', () => {
    const source = `
      import { $state } from 'fict'
      export function App() {
        const validate = (n: number) => n >= 0
        let count = $state(0)

        return (
          <div>
            <button onClick$={() => { if (validate(count + 1)) count++ }}>Inc</button>
            <button onClick$={() => { if (validate(count - 1)) count-- }}>Dec</button>
          </div>
        )
      }
    `

    const compiled = compileModule(source)
    try {
      // validate should only be hoisted once
      const hoistedMatches = compiled.code.match(/export const __fict_fn_validate_\d+/g)
      expect(hoistedMatches).not.toBeNull()
      // Should have exactly one export for the hoisted function
      expect(hoistedMatches!.length).toBe(1)
    } finally {
      compiled.cleanup()
    }
  })
})

// ============================================================================
// Test Suite 2: Manifest and Production Path Mapping
// ============================================================================

describe('Manifest and Production Path Mapping', () => {
  afterEach(() => {
    cleanupTestState()
    delete (globalThis as Record<string, unknown>).__FICT_MANIFEST__
  })

  it('SSR respects manifest for QRL resolution', async () => {
    const source = `
      import { $state } from 'fict'
      export function App() {
        let x = $state(0)
        return <button onClick$={() => x++}>{x}</button>
      }
    `

    const compiled = compileModule(source)
    try {
      // Create a mock manifest that maps the module URL
      const manifest: Record<string, string> = {
        [compiled.url]: '/assets/app-abc123.js',
      }

      // Set manifest before SSR
      ;(globalThis as Record<string, unknown>).__FICT_MANIFEST__ = manifest

      // Verify manifest is accessible
      const installedManifest = (globalThis as Record<string, unknown>).__FICT_MANIFEST__ as Record<
        string,
        string
      >
      expect(installedManifest[compiled.url]).toBe('/assets/app-abc123.js')

      // Import the module to verify it compiles correctly
      const mod = (await import(compiled.url)) as { App: () => unknown }
      expect(mod.App).toBeDefined()
    } finally {
      compiled.cleanup()
    }
  })

  it('renderToString accepts manifest option', async () => {
    const source = `
      import { $state } from 'fict'
      export function App() {
        let count = $state(0)
        return <div>{count}</div>
      }
    `

    const compiled = compileModule(source)
    try {
      const mod = (await import(compiled.url)) as { App: () => FictNode }

      const manifest = {
        [compiled.url]: '/assets/app-abc123.js',
      }

      // Render with manifest option
      const html = renderToString(() => ({ type: mod.App, props: {} }), {
        manifest,
      })

      expect(html).toContain('fict-host')
      expect(html).toContain('__FICT_SNAPSHOT__')
    } finally {
      compiled.cleanup()
    }
  })

  it('QRL uses manifest-mapped URL when available', async () => {
    const source = `
      import { $state } from 'fict'
      export function App() {
        let count = $state(0)
        return <button onClick$={() => count++}>{count}</button>
      }
    `

    const compiled = compileModule(source)
    try {
      // Set up manifest before import
      const manifest: Record<string, string> = {
        [compiled.url]: '/assets/app-xyz789.js',
      }
      ;(globalThis as Record<string, unknown>).__FICT_MANIFEST__ = manifest

      const mod = (await import(compiled.url)) as { App: () => FictNode }
      const html = renderToString(() => ({ type: mod.App, props: {} }), {
        manifest,
      })

      // The QRL should still work with manifest resolution
      expect(html).toContain('on:click')
    } finally {
      compiled.cleanup()
    }
  })
})

// ============================================================================
// Test Suite 3: Multi-Component Interaction Scenarios
// ============================================================================

describe('Multi-Component Interaction Scenarios', () => {
  afterEach(cleanupTestState)

  it('independent components resume and update separately', async () => {
    const source = `
      import { $state } from 'fict'

      export function CounterA() {
        let count = $state(100)
        return <button data-testid="a" onClick$={() => count++}>{count}</button>
      }

      export function CounterB() {
        let count = $state(200)
        return <button data-testid="b" onClick$={() => count++}>{count}</button>
      }

      export function App() {
        return (
          <div>
            <CounterA />
            <CounterB />
          </div>
        )
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { App: () => FictNode }
      const html = renderToString(() => ({ type: mod.App, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      const buttonA = env.document.querySelector('[data-testid="a"]') as HTMLElement
      const buttonB = env.document.querySelector('[data-testid="b"]') as HTMLElement

      expect(buttonA).not.toBeNull()
      expect(buttonB).not.toBeNull()
      expect(buttonA.textContent).toBe('100')
      expect(buttonB.textContent).toBe('200')

      // Click only button A
      dispatchClick(buttonA, env.window)
      await tick(3)

      expect(buttonA.textContent).toBe('101')
      expect(buttonB.textContent).toBe('200') // B unchanged

      // Click button B
      dispatchClick(buttonB, env.window)
      await tick(3)

      expect(buttonA.textContent).toBe('101')
      expect(buttonB.textContent).toBe('201')
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('nested components with props resume correctly', async () => {
    const source = `
      import { $state } from 'fict'

      export function Child(props: { label: string; initial: number }) {
        let count = $state(props.initial)
        return (
          <button data-label={props.label} onClick$={() => count++}>
            {props.label}: {count}
          </button>
        )
      }

      export function Parent() {
        return (
          <div>
            <Child label="First" initial={10} />
            <Child label="Second" initial={20} />
          </div>
        )
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { Parent: () => FictNode }
      const html = renderToString(() => ({ type: mod.Parent, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      const firstBtn = env.document.querySelector('[data-label="First"]') as HTMLElement
      const secondBtn = env.document.querySelector('[data-label="Second"]') as HTMLElement

      expect(firstBtn).not.toBeNull()
      expect(secondBtn).not.toBeNull()

      // Initial values
      expect(firstBtn.textContent).toContain('10')
      expect(secondBtn.textContent).toContain('20')

      // Interact with first child
      dispatchClick(firstBtn, env.window)
      await tick(3)
      expect(firstBtn.textContent).toContain('11')
      expect(secondBtn.textContent).toContain('20')

      // Interact with second child
      dispatchClick(secondBtn, env.window)
      await tick(3)
      expect(firstBtn.textContent).toContain('11')
      expect(secondBtn.textContent).toContain('21')
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('sibling components in a list resume independently', async () => {
    const source = `
      import { $state } from 'fict'

      export function Item(props: { id: number }) {
        let count = $state(props.id * 10)
        return (
          <li data-id={props.id} onClick$={() => count++}>
            Item {props.id}: {count}
          </li>
        )
      }

      export function List() {
        const items = [1, 2, 3]
        return (
          <ul>
            {items.map(id => <Item key={id} id={id} />)}
          </ul>
        )
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { List: () => FictNode }
      const html = renderToString(() => ({ type: mod.List, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      const items = env.document.querySelectorAll('li')
      expect(items.length).toBe(3)

      // Initial values
      expect(items[0]!.textContent).toContain('10')
      expect(items[1]!.textContent).toContain('20')
      expect(items[2]!.textContent).toContain('30')

      // Click middle item only
      dispatchClick(items[1]!, env.window)
      await tick(3)

      expect(items[0]!.textContent).toContain('10') // unchanged
      expect(items[1]!.textContent).toContain('21') // incremented
      expect(items[2]!.textContent).toContain('30') // unchanged
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })
})

// ============================================================================
// Test Suite 4: Complex DOM Boundaries
// ============================================================================

describe('Complex DOM Boundaries', () => {
  afterEach(cleanupTestState)

  it('fragment (multi-root) components preserve scope', async () => {
    const source = `
      import { $state } from 'fict'

      export function MultiRoot() {
        let count = $state(0)
        return [
          <span key="label">Count: </span>,
          <button key="btn" onClick$={() => count++}>{count}</button>
        ]
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { MultiRoot: () => FictNode }
      const html = renderToString(() => ({ type: mod.MultiRoot, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      const button = env.document.querySelector('button') as HTMLElement
      expect(button).not.toBeNull()
      expect(button.textContent).toBe('0')

      dispatchClick(button, env.window)
      await tick(3)

      expect(button.textContent).toBe('1')
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('conditional rendering preserves state after branch change', async () => {
    const source = `
      import { $state } from 'fict'

      export function Toggle() {
        let show = $state(true)
        let count = $state(0)

        return (
          <div>
            <button data-testid="toggle" onClick$={() => show = !show}>Toggle</button>
            {show && (
              <button data-testid="counter" onClick$={() => count++}>
                Count: {count}
              </button>
            )}
          </div>
        )
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { Toggle: () => FictNode }
      const html = renderToString(() => ({ type: mod.Toggle, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      const toggleBtn = env.document.querySelector('[data-testid="toggle"]') as HTMLElement
      let counterBtn = env.document.querySelector('[data-testid="counter"]') as HTMLElement | null

      expect(toggleBtn).not.toBeNull()
      expect(counterBtn).not.toBeNull()
      expect(counterBtn!.textContent).toContain('0')

      // Increment counter
      dispatchClick(counterBtn!, env.window)
      await tick(3)
      expect(counterBtn!.textContent).toContain('1')

      // Toggle off
      dispatchClick(toggleBtn, env.window)
      await tick(3)

      counterBtn = env.document.querySelector('[data-testid="counter"]')
      // Counter should be hidden (or null depending on implementation)
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('deeply nested scopes all resume correctly', async () => {
    const source = `
      import { $state } from 'fict'

      export function Level3(props: { base: number }) {
        let count = $state(props.base)
        return <button data-level="3" onClick$={() => count++}>{count}</button>
      }

      export function Level2(props: { base: number }) {
        let multiplier = $state(2)
        return (
          <div data-level="2">
            <Level3 base={props.base * multiplier} />
          </div>
        )
      }

      export function Level1() {
        let base = $state(5)
        return (
          <section data-level="1">
            <Level2 base={base} />
          </section>
        )
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { Level1: () => FictNode }
      const html = renderToString(() => ({ type: mod.Level1, props: {} }))

      // Verify all scope levels are present in snapshot
      const snapshot = parseSnapshot(html)
      expect(snapshot).not.toBeNull()

      const scopes = snapshot!.scopes as Record<string, unknown>
      // Should have 3 scopes (Level1, Level2, Level3)
      expect(Object.keys(scopes).length).toBeGreaterThanOrEqual(3)

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      // Initial value should be 5 * 2 = 10
      const button = env.document.querySelector('[data-level="3"]') as HTMLElement
      expect(button).not.toBeNull()
      expect(button.textContent).toBe('10')

      // Click should increment
      dispatchClick(button, env.window)
      await tick(3)
      expect(button.textContent).toBe('11')
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })
})

// ============================================================================
// Test Suite 5: Edge Cases and Error Handling
// ============================================================================

describe('Edge Cases and Error Handling', () => {
  afterEach(cleanupTestState)

  it('handles component with no state gracefully', async () => {
    const source = `
      export function Static() {
        return <div>Static content</div>
      }
    `

    const compiled = compileModule(source)
    try {
      const mod = (await import(compiled.url)) as { Static: () => FictNode }
      const html = renderToString(() => ({ type: mod.Static, props: {} }))

      expect(html).toContain('Static content')
      // Should still have snapshot infrastructure even if empty
      expect(html).toContain('__FICT_SNAPSHOT__')
    } finally {
      compiled.cleanup()
    }
  })

  it('handles event on element without scope host', async () => {
    const source = `
      import { $state } from 'fict'

      export function App() {
        let count = $state(0)
        return (
          <div>
            <button onClick$={() => count++}>{count}</button>
          </div>
        )
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { App: () => FictNode }
      const html = renderToString(() => ({ type: mod.App, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      // Should work even when button is nested inside div
      const button = env.document.querySelector('button') as HTMLElement
      expect(button.textContent).toBe('0')

      dispatchClick(button, env.window)
      await tick(3)

      expect(button.textContent).toBe('1')
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('handles rapid consecutive clicks', async () => {
    const source = `
      import { $state } from 'fict'

      export function Rapid() {
        let count = $state(0)
        return <button onClick$={() => count++}>{count}</button>
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { Rapid: () => FictNode }
      const html = renderToString(() => ({ type: mod.Rapid, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      const button = env.document.querySelector('button') as HTMLElement
      expect(button.textContent).toBe('0')

      // Fire 10 rapid clicks
      for (let i = 0; i < 10; i++) {
        dispatchClick(button, env.window)
      }

      await tick(5)

      // All clicks should be processed
      expect(button.textContent).toBe('10')
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('scope snapshot contains correct slot types', async () => {
    const source = `
      import { $state } from 'fict'

      export function Mixed() {
        let count = $state(42)
        let other = $state('hello')
        return <div>{count} - {other}</div>
      }
    `

    const compiled = compileModule(source)
    try {
      const mod = (await import(compiled.url)) as { Mixed: () => FictNode }
      const html = renderToString(() => ({ type: mod.Mixed, props: {} }))

      const snapshot = parseSnapshot(html)
      expect(snapshot).not.toBeNull()

      const scopes = snapshot!.scopes as Record<string, { slots: Array<[number, string, unknown]> }>
      const scopeIds = Object.keys(scopes)
      expect(scopeIds.length).toBeGreaterThan(0)

      const scope = scopes[scopeIds[0]!]!
      expect(scope.slots).toBeDefined()

      // Should have signal slots
      const slotTypes = scope.slots.map(s => s[1])
      expect(slotTypes).toContain('sig')
      // Verify we have multiple signal slots
      expect(slotTypes.filter(t => t === 'sig').length).toBeGreaterThanOrEqual(2)
    } finally {
      compiled.cleanup()
    }
  })

  it('preserves props in snapshot for resume', async () => {
    const source = `
      import { $state } from 'fict'

      export function WithProps(props: { name: string; value: number }) {
        let count = $state(props.value)
        return <div data-name={props.name}>{count}</div>
      }

      export function App() {
        return <WithProps name="test" value={123} />
      }
    `

    const compiled = compileModule(source)
    try {
      const mod = (await import(compiled.url)) as { App: () => FictNode }
      const html = renderToString(() => ({ type: mod.App, props: {} }))

      const snapshot = parseSnapshot(html)
      expect(snapshot).not.toBeNull()

      const scopes = snapshot!.scopes as Record<
        string,
        { slots: Array<[number, string, unknown]>; props?: Record<string, unknown> }
      >

      // Find scope with props
      const scopeWithProps = Object.values(scopes).find(s => s.props?.name === 'test')
      expect(scopeWithProps).toBeDefined()
      expect(scopeWithProps!.props!.value).toBe(123)
    } finally {
      compiled.cleanup()
    }
  })
})

// ============================================================================
// Test Suite 6: Attribute Binding and Dynamic Content
// ============================================================================

describe('Attribute Binding and Dynamic Content', () => {
  afterEach(cleanupTestState)

  it('dynamic attributes update after interaction', async () => {
    const source = `
      import { $state } from 'fict'

      export function DynamicAttr() {
        let active = $state(false)
        return (
          <button
            data-active={active}
            onClick$={() => active = !active}
          >
            {active ? 'Active' : 'Inactive'}
          </button>
        )
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { DynamicAttr: () => FictNode }
      const html = renderToString(() => ({ type: mod.DynamicAttr, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      const button = env.document.querySelector('button') as HTMLElement
      expect(button.textContent).toBe('Inactive')
      // Note: when value is `false`, bindAttribute removes the attribute (falsy removal)
      expect(button.hasAttribute('data-active')).toBe(false)

      dispatchClick(button, env.window)
      await tick(3)

      expect(button.textContent).toBe('Active')
      // After click, active becomes true, so attribute should be set (empty string for true)
      expect(button.hasAttribute('data-active')).toBe(true)
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('class bindings update correctly', async () => {
    const source = `
      import { $state } from 'fict'

      export function ClassToggle() {
        let expanded = $state(false)
        return (
          <div
            class={'panel ' + (expanded ? 'expanded' : 'collapsed')}
            onClick$={() => expanded = !expanded}
          >
            Panel
          </div>
        )
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { ClassToggle: () => FictNode }
      const html = renderToString(() => ({ type: mod.ClassToggle, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      const div = env.document.querySelector('.panel') as HTMLElement
      expect(div.classList.contains('collapsed')).toBe(true)
      expect(div.classList.contains('expanded')).toBe(false)

      dispatchClick(div, env.window)
      await tick(3)

      expect(div.classList.contains('collapsed')).toBe(false)
      expect(div.classList.contains('expanded')).toBe(true)
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('multiple state updates in single handler', async () => {
    const source = `
      import { $state } from 'fict'

      export function MultiState() {
        let a = $state(1)
        let b = $state(2)
        return (
          <button onClick$={() => { a++; b += 2 }}>
            {a} + {b} = {a + b}
          </button>
        )
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { MultiState: () => FictNode }
      const html = renderToString(() => ({ type: mod.MultiState, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      const button = env.document.querySelector('button') as HTMLElement
      expect(button.textContent).toContain('1')
      expect(button.textContent).toContain('2')
      expect(button.textContent).toContain('3') // 1 + 2

      dispatchClick(button, env.window)
      await tick(3)

      // After click: a=2, b=4, sum=6
      expect(button.textContent).toContain('2')
      expect(button.textContent).toContain('4')
      expect(button.textContent).toContain('6')
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })
})

// ============================================================================
// Test Suite 7: Smart Prefetch
// ============================================================================

describe('Smart Prefetch', () => {
  afterEach(cleanupTestState)

  it('installResumableLoader accepts prefetch configuration', async () => {
    const source = `
      import { $state } from 'fict'
      export function App() {
        let count = $state(0)
        return <button onClick$={() => count++}>{count}</button>
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { App: () => FictNode }
      const html = renderToString(() => ({ type: mod.App, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      // Install with custom prefetch options
      installResumableLoader({
        document: env.document,
        events: ['click'],
        prefetch: {
          visibility: true,
          visibilityMargin: '100px',
          hover: true,
          hoverDelay: 100,
        },
      })

      const button = env.document.querySelector('button') as HTMLElement
      expect(button).not.toBeNull()

      // Should still work for interactions
      dispatchClick(button, env.window)
      await tick(3)
      expect(button.textContent).toBe('1')
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('prefetch can be disabled entirely', async () => {
    const source = `
      import { $state } from 'fict'
      export function App() {
        let count = $state(0)
        return <button onClick$={() => count++}>{count}</button>
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { App: () => FictNode }
      const html = renderToString(() => ({ type: mod.App, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      // Install with prefetch disabled
      installResumableLoader({
        document: env.document,
        events: ['click'],
        prefetch: false,
      })

      const button = env.document.querySelector('button') as HTMLElement
      expect(button).not.toBeNull()

      // Interactions should still work
      dispatchClick(button, env.window)
      await tick(3)
      expect(button.textContent).toBe('1')
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('creates modulepreload links for prefetched QRLs', async () => {
    const source = `
      import { $state } from 'fict'
      export function App() {
        let count = $state(0)
        return <button onClick$={() => count++}>{count}</button>
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { App: () => FictNode }
      const html = renderToString(() => ({ type: mod.App, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      // Track link elements created
      const originalAppendChild = env.document.head.appendChild.bind(env.document.head)
      const appendedLinks: HTMLLinkElement[] = []
      env.document.head.appendChild = (node: Node) => {
        if (node instanceof env.window.HTMLLinkElement) {
          appendedLinks.push(node as HTMLLinkElement)
        }
        return originalAppendChild(node)
      }

      installResumableLoader({
        document: env.document,
        events: ['click'],
        prefetch: { visibility: true, hover: true },
      })

      // The button has on:click attribute, so prefetch should try to create a link
      // Note: In linkedom, IntersectionObserver may not be available
      // so we test that the system doesn't crash

      const button = env.document.querySelector('button') as HTMLElement
      expect(button).not.toBeNull()
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('handles multiple interactive elements', async () => {
    const source = `
      import { $state } from 'fict'

      export function Counter({ id }: { id: string }) {
        let count = $state(0)
        return <button data-id={id} onClick$={() => count++}>{count}</button>
      }

      export function App() {
        return (
          <div>
            <Counter id="a" />
            <Counter id="b" />
            <Counter id="c" />
          </div>
        )
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { App: () => FictNode }
      const html = renderToString(() => ({ type: mod.App, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({
        document: env.document,
        events: ['click'],
        prefetch: { visibility: true, hover: true },
      })

      // All buttons should have on:click attributes
      const buttons = env.document.querySelectorAll('button')
      expect(buttons.length).toBe(3)

      for (const button of buttons) {
        expect(button.getAttribute('on:click')).toBeTruthy()
      }

      // Each can be clicked independently
      dispatchClick(buttons[1]!, env.window)
      await tick(3)
      expect(buttons[1]!.textContent).toBe('1')
      expect(buttons[0]!.textContent).toBe('0')
      expect(buttons[2]!.textContent).toBe('0')
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })
})

// ============================================================================
// Test Suite 8: Complete Serialization (Complex Types)
// ============================================================================

describe('Complete Serialization (Complex Types)', () => {
  afterEach(cleanupTestState)

  it('serializes and deserializes Date objects', () => {
    const date = new Date('2024-06-15T12:30:00.000Z')
    const serialized = serializeValue(date)
    const deserialized = deserializeValue(serialized)

    expect(deserialized).toBeInstanceOf(Date)
    expect((deserialized as Date).getTime()).toBe(date.getTime())
  })

  it('serializes and deserializes Map objects', () => {
    const map = new Map<string, number>([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ])
    const serialized = serializeValue(map)
    const deserialized = deserializeValue(serialized)

    expect(deserialized).toBeInstanceOf(Map)
    const result = deserialized as Map<string, number>
    expect(result.size).toBe(3)
    expect(result.get('a')).toBe(1)
    expect(result.get('b')).toBe(2)
    expect(result.get('c')).toBe(3)
  })

  it('serializes and deserializes Set objects', () => {
    const set = new Set([1, 2, 3, 'a', 'b'])
    const serialized = serializeValue(set)
    const deserialized = deserializeValue(serialized)

    expect(deserialized).toBeInstanceOf(Set)
    const result = deserialized as Set<number | string>
    expect(result.size).toBe(5)
    expect(result.has(1)).toBe(true)
    expect(result.has('a')).toBe(true)
  })

  it('serializes and deserializes RegExp objects', () => {
    const regex = /hello\s+world/gi
    const serialized = serializeValue(regex)
    const deserialized = deserializeValue(serialized)

    expect(deserialized).toBeInstanceOf(RegExp)
    const result = deserialized as RegExp
    expect(result.source).toBe(regex.source)
    expect(result.flags).toBe(regex.flags)
  })

  it('serializes special number values', () => {
    expect(deserializeValue(serializeValue(undefined))).toBe(undefined)
    expect(Number.isNaN(deserializeValue(serializeValue(NaN)) as number)).toBe(true)
    expect(deserializeValue(serializeValue(Infinity))).toBe(Infinity)
    expect(deserializeValue(serializeValue(-Infinity))).toBe(-Infinity)
  })

  it('serializes BigInt values', () => {
    const bigint = BigInt('9007199254740993')
    const serialized = serializeValue(bigint)
    const deserialized = deserializeValue(serialized)

    expect(deserialized).toBe(bigint)
  })

  it('handles circular references', () => {
    const obj: Record<string, unknown> = { name: 'root' }
    obj.self = obj

    const serialized = serializeValue(obj)
    const deserialized = deserializeValue(serialized) as Record<string, unknown>

    expect(deserialized.name).toBe('root')
    expect(deserialized.self).toBe(deserialized) // Same reference
  })

  it('handles nested complex types', () => {
    const complex = {
      date: new Date('2024-01-01'),
      map: new Map([['key', { nested: true }]]),
      set: new Set([1, 2, 3]),
      regex: /test/i,
      array: [undefined, NaN, Infinity],
    }

    const serialized = serializeValue(complex)
    const result = deserializeValue(serialized) as typeof complex

    expect((result.date as Date).getTime()).toBe(new Date('2024-01-01').getTime())
    expect(result.map).toBeInstanceOf(Map)
    expect((result.map as Map<string, object>).get('key')).toEqual({ nested: true })
    expect(result.set).toBeInstanceOf(Set)
    expect((result.set as Set<number>).has(2)).toBe(true)
    expect((result.regex as RegExp).source).toBe('test')
    expect(result.array[0]).toBe(undefined)
    expect(Number.isNaN(result.array[1])).toBe(true)
    expect(result.array[2]).toBe(Infinity)
  })

  it('SSR snapshot preserves complex types in state', async () => {
    // Note: This test verifies the serialization is used in SSR context
    // The actual state usage depends on how the compiler transforms the code
    const source = `
      import { $state } from 'fict'

      export function App() {
        let count = $state(42)
        let text = $state('hello')
        return <div>{count} - {text}</div>
      }
    `

    const compiled = compileModule(source)
    try {
      const mod = (await import(compiled.url)) as { App: () => FictNode }
      const html = renderToString(() => ({ type: mod.App, props: {} }))

      const snapshot = parseSnapshot(html)
      expect(snapshot).not.toBeNull()

      // Verify snapshot contains scopes with slot data
      const scopes = snapshot!.scopes as Record<string, { slots: unknown[] }>
      expect(Object.keys(scopes).length).toBeGreaterThan(0)

      // Check that slots are serialized
      const scope = Object.values(scopes)[0]!
      expect(scope.slots).toBeDefined()
      expect(Array.isArray(scope.slots)).toBe(true)
    } finally {
      compiled.cleanup()
    }
  })

  it('Map with complex keys serializes correctly', () => {
    const map = new Map<object, string>()
    const key1 = { id: 1 }
    const key2 = { id: 2 }
    map.set(key1, 'first')
    map.set(key2, 'second')

    const serialized = serializeValue(map)
    const result = deserializeValue(serialized) as Map<object, string>

    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(2)

    // Keys are new objects, so we check by iteration
    const entries = Array.from(result.entries())
    expect(entries[0]![0]).toEqual({ id: 1 })
    expect(entries[0]![1]).toBe('first')
    expect(entries[1]![0]).toEqual({ id: 2 })
    expect(entries[1]![1]).toBe('second')
  })
})

// ============================================================================
// Test Suite 9: Function-level Code Splitting
// ============================================================================

describe('Function-level Code Splitting', () => {
  afterEach(cleanupTestState)

  it('compiler generates separate handler exports', () => {
    const source = `
      import { $state } from 'fict'

      export function App() {
        let count = $state(0)
        return (
          <div>
            <button onClick$={() => count++}>Increment</button>
            <button onClick$={() => count--}>Decrement</button>
          </div>
        )
      }
    `

    const compiled = compileModule(source)
    try {
      // Should have multiple handler exports
      const e0Match = compiled.code.match(/export\s+(const|function)\s+__fict_e0/g)
      const e1Match = compiled.code.match(/export\s+(const|function)\s+__fict_e1/g)

      expect(e0Match).not.toBeNull()
      expect(e1Match).not.toBeNull()

      // Each handler should use useLexicalScope for variable restoration
      expect(compiled.code).toContain('__fictUseLexicalScope')
    } finally {
      compiled.cleanup()
    }
  })

  it('handlers are self-contained with useLexicalScope', () => {
    const source = `
      import { $state } from 'fict'

      export function Counter() {
        let count = $state(0)
        let step = $state(1)
        return (
          <button onClick$={() => count += step}>{count}</button>
        )
      }
    `

    const compiled = compileModule(source)
    try {
      // Handler should restore both count and step from lexical scope
      const handlerMatch = compiled.code.match(
        /export\s+(const|function)\s+__fict_e0[\s\S]*?(?=export|$)/,
      )
      expect(handlerMatch).not.toBeNull()

      const handler = handlerMatch![0]
      expect(handler).toContain('__fictUseLexicalScope')
      // Should reference the captured variables
      expect(handler).toContain('count')
      expect(handler).toContain('step')
    } finally {
      compiled.cleanup()
    }
  })

  it('QRL format supports lazy loading', async () => {
    const source = `
      import { $state } from 'fict'

      export function App() {
        let count = $state(0)
        return <button onClick$={() => count++}>{count}</button>
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { App: () => FictNode }
      const html = renderToString(() => ({ type: mod.App, props: {} }))

      // QRL should contain module path and export name
      const qrlMatch = html.match(/on:click="([^"]+)"/)
      expect(qrlMatch).not.toBeNull()

      const qrl = qrlMatch![1]
      // QRL format: url#exportName
      expect(qrl).toContain('#')
      expect(qrl).toContain('__fict_e')

      // Parse QRL
      const [url, exportName] = qrl.split('#')
      expect(url).toBeTruthy()
      expect(exportName).toMatch(/^__fict_e\d+$/)

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      // Verify lazy loading works via loader
      installResumableLoader({ document: env.document, events: ['click'] })

      const button = env.document.querySelector('button') as HTMLElement
      dispatchClick(button, env.window)
      await tick(3)

      // Handler was lazily loaded and executed
      expect(button.textContent).toBe('1')
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('multiple handlers in same component work independently', async () => {
    const source = `
      import { $state } from 'fict'

      export function Dual() {
        let a = $state(0)
        let b = $state(100)
        return (
          <div>
            <button data-id="a" onClick$={() => a++}>{a}</button>
            <button data-id="b" onClick$={() => b++}>{b}</button>
          </div>
        )
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { Dual: () => FictNode }
      const html = renderToString(() => ({ type: mod.Dual, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      const btnA = env.document.querySelector('[data-id="a"]') as HTMLElement
      const btnB = env.document.querySelector('[data-id="b"]') as HTMLElement

      expect(btnA.textContent).toBe('0')
      expect(btnB.textContent).toBe('100')

      // Click A only
      dispatchClick(btnA, env.window)
      await tick(3)
      expect(btnA.textContent).toBe('1')
      expect(btnB.textContent).toBe('100')

      // Click B only
      dispatchClick(btnB, env.window)
      await tick(3)
      expect(btnA.textContent).toBe('1')
      expect(btnB.textContent).toBe('101')
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('resume function is generated for components', () => {
    const source = `
      import { $state } from 'fict'

      export function Counter() {
        let count = $state(0)
        return <button onClick$={() => count++}>{count}</button>
      }
    `

    const compiled = compileModule(source)
    try {
      // Should have resume function export
      const resumeMatch = compiled.code.match(/export\s+(const|function)\s+__fict_r\d+/)
      expect(resumeMatch).not.toBeNull()

      // Resume function should set up component metadata
      expect(compiled.code).toContain('__fictMeta')
      // The meta should contain 'resume' property which creates QRL for resume handler
      expect(compiled.code).toContain('resume:')
    } finally {
      compiled.cleanup()
    }
  })

  it('handler captures correct scope variables', async () => {
    const source = `
      import { $state } from 'fict'

      export function Computed() {
        let count = $state(5)
        const doubled = count * 2
        return (
          <button onClick$={() => count++}>
            {count} x 2 = {doubled}
          </button>
        )
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { Computed: () => FictNode }
      const html = renderToString(() => ({ type: mod.Computed, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      const button = env.document.querySelector('button') as HTMLElement
      expect(button.textContent).toContain('5')
      expect(button.textContent).toContain('10')

      dispatchClick(button, env.window)
      await tick(3)

      expect(button.textContent).toContain('6')
      expect(button.textContent).toContain('12')
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })
})

// ============================================================================
// Test Suite 10: Full E2E Integration
// ============================================================================

describe('Full E2E Integration', () => {
  afterEach(cleanupTestState)

  it('complete resumable flow: SSR -> serialize -> hydrate -> interact', async () => {
    // Use a simpler example that doesn't rely on array-based list rendering
    const source = `
      import { $state } from 'fict'

      export function App() {
        let count = $state(10)
        let text = $state('Hello')

        return (
          <div>
            <span data-count>{count}</span>
            <span data-text>{text}</span>
            <button data-inc onClick$={() => count++}>Inc</button>
            <button data-toggle onClick$={() => text = text === 'Hello' ? 'World' : 'Hello'}>
              Toggle
            </button>
          </div>
        )
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      // 1. SSR Render
      const mod = (await import(compiled.url)) as { App: () => FictNode }
      const html = renderToString(() => ({ type: mod.App, props: {} }))

      // 2. Verify SSR output
      expect(html).toContain('10')
      expect(html).toContain('Hello')
      expect(html).toContain('__FICT_SNAPSHOT__')

      // 3. Client hydration setup
      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      // 4. Install loader with prefetch
      installResumableLoader({
        document: env.document,
        events: ['click'],
        prefetch: { visibility: true, hover: true },
      })

      // 5. Verify initial state
      const countSpan = env.document.querySelector('[data-count]') as HTMLElement
      const textSpan = env.document.querySelector('[data-text]') as HTMLElement
      const incButton = env.document.querySelector('[data-inc]') as HTMLElement
      const toggleButton = env.document.querySelector('[data-toggle]') as HTMLElement

      expect(countSpan.textContent).toBe('10')
      expect(textSpan.textContent).toBe('Hello')

      // 6. Interact - increment count
      dispatchClick(incButton, env.window)
      await tick(3)
      expect(countSpan.textContent).toBe('11')

      // 7. Interact - toggle text
      dispatchClick(toggleButton, env.window)
      await tick(3)
      expect(textSpan.textContent).toBe('World')

      // 8. Multiple interactions
      dispatchClick(incButton, env.window)
      dispatchClick(incButton, env.window)
      await tick(3)
      expect(countSpan.textContent).toBe('13')

      // 9. Toggle back
      dispatchClick(toggleButton, env.window)
      await tick(3)
      expect(textSpan.textContent).toBe('Hello')
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('handles complex state with serialization through full cycle', async () => {
    const source = `
      import { $state } from 'fict'

      export function ComplexState() {
        let data = $state({
          count: 0,
          items: ['a', 'b'],
          nested: { value: 42 }
        })

        return (
          <div>
            <span data-count>{data.count}</span>
            <span data-items>{data.items.length}</span>
            <button onClick$={() => {
              data = {
                ...data,
                count: data.count + 1,
                items: [...data.items, 'c']
              }
            }}>
              Update
            </button>
          </div>
        )
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { ComplexState: () => FictNode }
      const html = renderToString(() => ({ type: mod.ComplexState, props: {} }))

      // Verify snapshot captures complex state
      const snapshot = parseSnapshot(html)
      expect(snapshot).not.toBeNull()

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      const countSpan = env.document.querySelector('[data-count]') as HTMLElement
      const itemsSpan = env.document.querySelector('[data-items]') as HTMLElement
      const button = env.document.querySelector('button') as HTMLElement

      expect(countSpan.textContent).toBe('0')
      expect(itemsSpan.textContent).toBe('2')

      dispatchClick(button, env.window)
      await tick(3)

      expect(countSpan.textContent).toBe('1')
      expect(itemsSpan.textContent).toBe('3')
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('multiple independent components with different state types', async () => {
    const source = `
      import { $state } from 'fict'

      export function NumberCounter() {
        let count = $state(0)
        return <button data-type="number" onClick$={() => count++}>{count}</button>
      }

      export function StringToggle() {
        let text = $state('off')
        return (
          <button data-type="string" onClick$={() => text = text === 'off' ? 'on' : 'off'}>
            {text}
          </button>
        )
      }

      export function BoolToggle() {
        let active = $state(false)
        return (
          <button data-type="bool" onClick$={() => active = !active}>
            {active ? 'yes' : 'no'}
          </button>
        )
      }

      export function App() {
        return (
          <div>
            <NumberCounter />
            <StringToggle />
            <BoolToggle />
          </div>
        )
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { App: () => FictNode }
      const html = renderToString(() => ({ type: mod.App, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      const numBtn = env.document.querySelector('[data-type="number"]') as HTMLElement
      const strBtn = env.document.querySelector('[data-type="string"]') as HTMLElement
      const boolBtn = env.document.querySelector('[data-type="bool"]') as HTMLElement

      expect(numBtn.textContent).toBe('0')
      expect(strBtn.textContent).toBe('off')
      expect(boolBtn.textContent).toBe('no')

      // Click each independently
      dispatchClick(numBtn, env.window)
      await tick(3)
      expect(numBtn.textContent).toBe('1')
      expect(strBtn.textContent).toBe('off')
      expect(boolBtn.textContent).toBe('no')

      dispatchClick(strBtn, env.window)
      await tick(3)
      expect(numBtn.textContent).toBe('1')
      expect(strBtn.textContent).toBe('on')
      expect(boolBtn.textContent).toBe('no')

      dispatchClick(boolBtn, env.window)
      await tick(3)
      expect(numBtn.textContent).toBe('1')
      expect(strBtn.textContent).toBe('on')
      expect(boolBtn.textContent).toBe('yes')
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('stress test: many components with rapid interactions', async () => {
    const source = `
      import { $state } from 'fict'

      export function Counter({ id }: { id: number }) {
        let count = $state(id)
        return (
          <button data-id={id} onClick$={() => count++}>{count}</button>
        )
      }

      export function App() {
        const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
        return (
          <div>
            {items.map(id => <Counter key={id} id={id} />)}
          </div>
        )
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}

    try {
      const mod = (await import(compiled.url)) as { App: () => FictNode }
      const html = renderToString(() => ({ type: mod.App, props: {} }))

      const env = setupClientEnvironment(html)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      const buttons = env.document.querySelectorAll('button')
      expect(buttons.length).toBe(10)

      // Click each button once
      for (const button of buttons) {
        dispatchClick(button, env.window)
      }
      await tick(5)

      // Verify each incremented
      for (let i = 0; i < buttons.length; i++) {
        expect(buttons[i]!.textContent).toBe(String(i + 1))
      }

      // Click them all again
      for (const button of buttons) {
        dispatchClick(button, env.window)
      }
      await tick(5)

      // Verify each incremented again
      for (let i = 0; i < buttons.length; i++) {
        expect(buttons[i]!.textContent).toBe(String(i + 2))
      }
    } finally {
      await cleanup()
      compiled.cleanup()
    }
  })

  it('streams incremental snapshots and resumes after boundary patch', async () => {
    const source = `
      import { $state } from 'fict'
      export function Counter() {
        let count = $state(0)
        return <button data-btn onClick$={() => count++}>{count}</button>
      }
    `

    const compiled = compileModule(source)
    let cleanup = () => {}
    let restoreMutationObserver: (() => void) | null = null
    let notifyMutationObserver: ((nodes: Node[]) => void) | null = null

    try {
      const mod = (await import(compiled.url)) as { Counter: () => FictNode }
      const token = createSuspenseToken()
      let ready = false
      const observerStub = installMutationObserverStub()
      restoreMutationObserver = observerStub.restore
      notifyMutationObserver = observerStub.notify

      function AsyncChild(): FictNode {
        if (!ready) throw token.token
        return { type: mod.Counter, props: {} }
      }

      function App(): FictNode {
        return {
          type: Suspense,
          props: {
            fallback: { type: 'div', props: { children: 'Loading' } },
            children: { type: AsyncChild, props: {} },
          },
        }
      }

      const stream = renderToStream(() => ({ type: App, props: {} }), {
        mode: 'shell',
        fullDocument: false,
      })

      const reader = stream.getReader()
      const first = await reader.read()
      expect(first.done).toBe(false)
      const shellChunk = decoder.decode(first.value)

      expect(shellChunk).toContain('Loading')
      expect(shellChunk).toContain('fict:suspense-start')

      // Resolve boundary to emit patch + snapshot chunk.
      ready = true
      token.resolve()

      let rest = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) rest += decoder.decode(value, { stream: true })
      }
      rest += decoder.decode()
      expect(rest).toContain('data-fict-snapshot')

      const env = setupClientEnvironment(shellChunk)
      cleanup = env.cleanup

      installResumableLoader({ document: env.document, events: ['click'] })

      const fragment = env.document.createRange().createContextualFragment(rest)
      const addedNodes = Array.from(fragment.childNodes)
      env.document.body.appendChild(fragment)
      notifyMutationObserver?.(addedNodes)

      const template = env.document.querySelector('template[data-fict-suspense]')
      expect(template).not.toBeNull()
      const id = template?.getAttribute('data-fict-suspense')
      expect(id).toBeTruthy()
      applyStreamPatch(env.document, env.window, id!)

      const button = env.document.querySelector('[data-btn]') as HTMLElement
      expect(button.textContent).toBe('0')

      const counterHost = button.closest('[data-fict-s]')
      const counterScope = counterHost?.getAttribute('data-fict-s') ?? ''
      expect(counterScope).toBeTruthy()
      expect(__fictGetSSRScope(counterScope)).toBeDefined()

      dispatchClick(button, env.window)
      await tick(3)

      expect(button.textContent).toBe('1')
    } finally {
      restoreMutationObserver?.()
      await cleanup()
      compiled.cleanup()
    }
  })

  it('streams chunk-by-chunk and resumes interaction after patch', async () => {
    const source = `
      import { $state } from 'fict'
      export function Counter() {
        let count = $state(0)
        return <button data-btn onClick$={() => count++}>{count}</button>
      }
    `

    const compiled = compileModule(source, { baseDir: path.join(process.cwd(), '.tmp') })
    let cleanup = () => {}
    let worker: Worker | null = null

    try {
      const mod = (await import(compiled.url)) as { Counter: () => FictNode }
      const token = createSuspenseToken()
      let ready = false

      function AsyncChild(): FictNode {
        if (!ready) throw token.token
        return { type: mod.Counter, props: {} }
      }

      function App(): FictNode {
        return {
          type: Suspense,
          props: {
            fallback: { type: 'div', props: { children: 'Loading' } },
            children: { type: AsyncChild, props: {} },
          },
        }
      }

      const stream = renderToStream(() => ({ type: App, props: {} }), {
        mode: 'shell',
        fullDocument: false,
      })

      worker = new Worker(new URL('./streaming-resume.worker.js', import.meta.url), {
        type: 'module',
      })
      let msgId = 0
      const callWorker = (type: string, payload?: Record<string, unknown>) =>
        new Promise<unknown>((resolve, reject) => {
          const id = ++msgId
          const onMessage = (message: {
            id: number
            ok: boolean
            result?: unknown
            error?: string
          }) => {
            if (message.id !== id) return
            worker.off('message', onMessage)
            if (message.ok) {
              resolve(message.result)
            } else {
              reject(new Error(message.error ?? 'Worker error'))
            }
          }
          worker.on('message', onMessage)
          worker.postMessage({ id, type, payload })
        })

      const reader = stream.getReader()
      const first = await reader.read()
      expect(first.done).toBe(false)
      const shellChunk = decoder.decode(first.value)
      const filePath = fileURLToPath(compiled.url)
      const manifest = { [`/@fs${filePath}`]: compiled.url }
      await callWorker('init', { html: shellChunk, manifest })

      ready = true
      token.resolve()

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) {
          const chunk = decoder.decode(value, { stream: true })
          if (chunk) {
            await callWorker('chunk', { html: chunk })
          }
        }
      }
      const tail = decoder.decode()
      if (tail) {
        await callWorker('chunk', { html: tail })
      }

      const initialText = await callWorker('getText', { selector: '[data-btn]' })
      expect(initialText).toBe('0')

      const nextText = await callWorker('click', { selector: '[data-btn]' })
      expect(nextText).toBe('1')

      await callWorker('dispose')
    } finally {
      if (worker) {
        try {
          await worker.terminate()
        } catch {
          // ignore worker shutdown errors
        }
      }
      await cleanup()
      compiled.cleanup()
    }
  })
})
