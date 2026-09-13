import { afterEach, describe, expect, it, vi } from 'vitest'

import { hydrate, render, onCleanup, Suspense, ErrorBoundary, Fragment } from '../src/index'
import { reactive, createSignal } from '../src/advanced'
import { flush } from '../src/signal'
import type { FictNode } from '../src/types'

const disposers: (() => void)[] = []
afterEach(() => {
  for (const stop of disposers.splice(0).reverse()) stop()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})
const container = (html: string) => {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.append(root)
  return root
}
const view = (text: string): FictNode => ({ type: 'b', props: { children: text } })

describe('public eager hydration ownership', () => {
  it.each([false, true])(
    'keeps fragment DOM connected and preserves user input (VNode fragment=%s)',
    vnode => {
      let connections = 0,
        disconnections = 0
      const name = vnode ? 'fict-owned-fragment' : 'fict-owned-array'
      customElements.define(
        name,
        class extends HTMLElement {
          connectedCallback() {
            connections++
          }
          disconnectedCallback() {
            disconnections++
          }
        },
      )
      const root = container(`<${name}></${name}><input>`)
      const element = root.firstChild,
        input = root.querySelector('input')!
      input.value = 'user edit'
      input.focus()
      input.setSelectionRange(2, 5)
      const children: FictNode[] = [
        { type: name, props: {} },
        { type: 'input', props: {} },
      ]
      disposers.push(
        hydrate(() => (vnode ? { type: Fragment, props: { children } } : children), root, {
          strictHydration: true,
        }),
      )
      expect(root.firstChild).toBe(element)
      expect(root.lastChild).toBe(input)
      expect(document.activeElement).toBe(input)
      expect(input.value).toBe('user edit')
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5])
      expect([connections, disconnections]).toEqual([1, 0])
    },
  )
  it('unmounts its graph while retaining a replacement installed by cleanup', () => {
    const root = container('<b>server</b>')
    function App() {
      onCleanup(() => {
        disposers.push(render(() => view('replacement'), root))
      })
      return view('server')
    }
    const stop = hydrate(() => ({ type: App, props: {} }), root, { strictHydration: true })
    disposers.push(stop)
    stop()
    expect(root.textContent).toBe('replacement')
    stop()
    expect(root.textContent).toBe('replacement')
  })

  it("does not inherit another root's strict mode or issue handler during reentrant hydration", () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = container('<b>server</b>'),
      other = container('<b>other</b>')
    const issues: string[] = []
    expect(() =>
      hydrate(() => view('client'), root, {
        strictHydration: true,
        onHydrationIssue: issue => {
          issues.push(issue.code)
          disposers.push(hydrate(() => view('independent'), other))
        },
      }),
    ).toThrow(/text content does not match/)
    expect(issues).toEqual(['text_mismatch'])
    expect(other.textContent).toBe('independent')
  })

  it('does not treat strict hydration failure as an application error fallback', () => {
    const root = container(
      '<!--fict:error-boundary-start--><i>server</i><!--fict:error-boundary-->',
    )
    const fallback = vi.fn(() => view('fallback'))
    expect(() =>
      hydrate(
        () => ({ type: ErrorBoundary, props: { fallback, children: view('client') } }),
        root,
        {
          strictHydration: true,
          onHydrationIssue: () => {},
        },
      ),
    ).toThrow(/does not match/)
    expect(fallback).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'Suspense', Boundary: Suspense },
    { name: 'ErrorBoundary', Boundary: ErrorBoundary },
  ])('checks the entire claimed range for an empty $name view', ({ Boundary }) => {
    const suspense = Boundary === Suspense
    const markers = suspense
      ? ['fict:suspense-start', 'fict:suspense-end']
      : ['fict:error-boundary-start', 'fict:error-boundary']
    const root = container(`<!--${markers[0]}--><b>unexpected</b><!--${markers[1]}-->`)
    expect(() =>
      hydrate(() => ({ type: Boundary, props: { fallback: null, children: null } }), root, {
        strictHydration: true,
        onHydrationIssue: () => {},
      }),
    ).toThrow(/extra server-rendered nodes/)
  })

  it('repairs a malformed reactive child range in place without losing following siblings', () => {
    const root = container('<div><!--fict:child-start-->old<!--fict:child:bad--></div><p>tail</p>')
    const tail = root.lastChild
    const issues: string[] = []
    const value = createSignal('current')
    const stop = hydrate(
      () => [
        { type: 'div', props: { children: reactive(() => value()) } },
        { type: 'p', props: { children: 'tail' } },
      ],
      root,
      { onHydrationIssue: issue => issues.push(issue.code) },
    )
    disposers.push(stop)
    expect(root.firstElementChild?.textContent).toBe('current')
    expect(root.lastChild).toBe(tail)
    expect(issues).toEqual(['node_type_mismatch'])
    value('updated')
    flush()
    expect(root.firstElementChild?.textContent).toBe('updated')
  })
})
