import { describe, expect, it } from 'vitest'

import { createSignal, reactive } from '../src/advanced'
import { createChildBinding } from '../src/binding'
import { createElement, hydrateComponent } from '../src/dom'
import { batch, createEffect, onCleanup, onMount, render } from '../src/index'
import type { FictNode, FictVNode } from '../src/types'

const dynamic = (read: () => FictNode) => reactive(read) as unknown as FictNode

describe('VNode reconciliation', () => {
  it('moves the current multi-root contents and cleans only removed instances', () => {
    const host = document.createElement('div')
    const rows = createSignal([1, 2])
    const states = new Map<number, ReturnType<typeof createSignal<number>>>()
    const cleaned: number[] = []
    const Row = (props: Record<string, unknown>): FictNode => {
      const id = props.id as number
      const count = createSignal(0)
      states.set(id, count)
      onCleanup(() => cleaned.push(id))
      return dynamic(() =>
        count() % 2
          ? [
              { type: 'b', props: { children: `${id}:b` } },
              { type: 'i', props: { children: `${id}:i` } },
            ]
          : { type: 'span', props: { children: `${id}:span` } },
      )
    }
    const stop = render(
      () => dynamic(() => rows().map(id => ({ type: Row, key: id, props: { id } }))),
      host,
    )
    batch(() => states.get(1)!(1))
    const [b, i, span] = Array.from(host.querySelectorAll('*'))
    batch(() => rows([2, 1]))
    expect(Array.from(host.querySelectorAll('*'))).toEqual([span, b, i])
    expect(cleaned).toEqual([])
    batch(() => rows([1]))
    expect(Array.from(host.querySelectorAll('*'))).toEqual([b, i])
    expect(cleaned).toEqual([2])
    stop()
    expect(host.childNodes.length).toBe(0)
    expect(cleaned).toEqual([2, 1])
  })

  it('retains authored sites across conditional siblings and matches repeated sites by occurrence', () => {
    const host = document.createElement('div')
    const version = createSignal(0)
    const scope = {}
    let next = 0
    const cleaned: number[] = []
    const component = (tag: string) => () => {
      const id = ++next
      onCleanup(() => cleaned.push(id))
      return { type: tag, props: { children: String(id) } }
    }
    const A = component('i')
    const B = component('b')
    const site = (type: FictVNode['type'], slot: number): FictVNode => ({
      type,
      __fictVNodeScope: scope,
      __fictVNodeSlot: slot,
    })
    const stop = render(
      () =>
        dynamic(() => [
          version() === 1 ? site('em', 1) : null,
          ...(version() < 2 ? [A, B] : [B, A]).map(type => site(type, 2)),
          site(A, 3),
        ]),
      host,
    )
    const initial = Array.from(host.children)
    batch(() => version(1))
    expect(Array.from(host.children).slice(1)).toEqual(initial)
    expect(next).toBe(3)
    expect(cleaned).toEqual([])
    batch(() => version(2))
    expect(host.textContent).toBe('453')
    expect(host.lastElementChild).toBe(initial[2])
    expect(cleaned).toEqual([1, 2])
    stop()
    expect(cleaned).toEqual([1, 2, 4, 5, 3])
  })

  it('updates added and removed component props without unwrapping manual accessors', () => {
    const host = document.createElement('div')
    const accessor = createSignal(7)
    const props = createSignal<Record<string, unknown>>({ label: 'first', value: accessor })
    let calls = 0
    const Child = (p: Record<string, unknown>): FictNode => {
      calls++
      return {
        type: 'span',
        props: { children: dynamic(() => `${p.label}:${p.extra ?? '-'}:${typeof p.value}`) },
      }
    }
    const stop = render(() => dynamic(() => ({ type: Child, key: 'one', props: props() })), host)
    const node = host.querySelector('span')
    batch(() => props({ label: 'second', extra: 'new', value: accessor }))
    expect(host.textContent).toBe('second:new:function')
    batch(() => props({ label: 'third', value: accessor }))
    expect(host.textContent).toBe('third:-:function')
    expect(host.querySelector('span')).toBe(node)
    expect(calls).toBe(1)
    stop()
  })

  it('updates frozen intrinsic prop sets, getters, refs and event handlers', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const count = createSignal(1)
    const version = createSignal(0)
    const refs: (Element | null)[] = []
    const ref = (el: Element | null) => refs.push(el)
    let clicked = ''
    const stop = render(
      () =>
        dynamic(() => ({
          type: 'button',
          key: 'one',
          props: Object.freeze(
            version() === 0
              ? {
                  ref,
                  title: reactive(() => `n${count()}`),
                  disabled: true,
                  'data-bool': false,
                  hidden: true,
                  style: { color: 'red' },
                  onClick: () => (clicked = 'old'),
                  children: 'first',
                }
              : {
                  ref,
                  title: reactive(() => `n${count()}`),
                  disabled: false,
                  'data-bool': true,
                  hidden: false,
                  onClick: () => (clicked = 'new'),
                  children: 'second',
                },
          ),
        })),
      host,
    )
    const button = host.querySelector('button')!
    expect(button.title).toBe('n1')
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('data-bool')).toBe('false')
    batch(() => {
      count(2)
      version(1)
    })
    expect(host.querySelector('button')).toBe(button)
    expect(button.title).toBe('n2')
    expect(button.disabled).toBe(false)
    expect(button.hidden).toBe(false)
    expect(button.getAttribute('data-bool')).toBe('true')
    expect(button.style.color).toBe('')
    expect(button.textContent).toBe('second')
    button.click()
    expect(clicked).toBe('new')
    expect(refs).toEqual([button])
    stop()
    expect(refs).toEqual([button, null])
    host.remove()
  })

  it('rolls back failed preparation while retaining committed rows', () => {
    const host = document.createElement('div')
    const rows = createSignal([1])
    const source = createSignal(0)
    const cleanups: number[] = []
    let effects = 0
    const Row = (props: Record<string, unknown>): FictNode => {
      const id = props.id as number
      createEffect(() => {
        source()
        effects++
      })
      onCleanup(() => cleanups.push(id))
      if (id === 3) throw new Error('rejected row')
      return { type: 'span', props: { children: id } }
    }
    const stop = render(
      () => dynamic(() => rows().map(id => ({ type: Row, key: id, props: { id } }))),
      host,
    )
    const original = host.querySelector('span')
    expect(() => batch(() => rows([1, 2, 3]))).toThrow('rejected row')
    expect(host.querySelector('span')).toBe(original)
    expect(host.textContent).toBe('1')
    expect(cleanups.sort()).toEqual([2, 3])
    const before = effects
    batch(() => source(1))
    expect(effects).toBe(before + 1)
    batch(() => rows([1, 2]))
    expect(host.querySelector('span')).toBe(original)
    expect(host.textContent).toBe('12')
    stop()
  })

  it('flushes nested mounts after the complete new range is inserted', () => {
    const host = document.createElement('div')
    const rows = createSignal([1])
    const placements: boolean[] = []
    const Child = (): FictNode => {
      const element = document.createElement('span')
      onMount(() => placements.push(host.contains(element)))
      return element
    }
    const Row = (): FictNode => dynamic(() => ({ type: Child, props: {} }))
    const stop = render(
      () => dynamic(() => rows().map(id => ({ type: Row, key: id, props: {} }))),
      host,
    )
    batch(() => rows([1, 2]))
    expect(placements).toEqual([true, true])
    stop()
  })

  it('finishes all instance disposal when one cleanup throws', () => {
    const host = document.createElement('div')
    const rows = createSignal([1, 2])
    const cleaned: number[] = []
    const Row = (props: Record<string, unknown>): FictNode => {
      const id = props.id as number
      onCleanup(() => {
        cleaned.push(id)
        if (id === 1) throw new Error('cleanup failure')
      })
      return { type: 'span', props: { children: id } }
    }
    const stop = render(
      () => dynamic(() => rows().map(id => ({ type: Row, key: id, props: { id } }))),
      host,
    )
    expect(() => batch(() => rows([]))).toThrow('cleanup failure')
    expect(cleaned).toEqual([1, 2])
    expect(host.textContent).toBe('')
    stop()
  })

  it('keeps numeric and string keys distinct, with deterministic duplicate occurrences', () => {
    const host = document.createElement('div')
    const nodes = createSignal<FictVNode[]>([
      { type: 'input', key: 1, props: {} },
      { type: 'input', key: '1', props: {} },
      { type: 'input', key: 1, props: {} },
    ])
    const stop = render(() => {
      const div = document.createElement('div')
      createChildBinding(div, nodes, createElement)
      return div
    }, host)
    const inputs = Array.from(host.querySelectorAll('input'))
    batch(() => nodes([nodes()[1]!, nodes()[0]!, nodes()[2]!]))
    expect(Array.from(host.querySelectorAll('input'))).toEqual([inputs[1], inputs[0], inputs[2]])
    stop()
  })
})

it('reports missing VNode hydration markers and repairs within the child range', () => {
  const host = document.createElement('div')
  const html = '<!--fict:child-start--><span>server</span><!--fict:child--><i>after</i>'
  const count = createSignal(0)
  const app = () =>
    createElement([
      dynamic(() => ({ type: 'span', props: { children: count() } })),
      { type: 'i', props: { children: 'after' } },
    ])
  host.innerHTML = html
  expect(() => hydrateComponent(app, host, { strictHydration: true })).toThrow(/VNode/)
  host.innerHTML = html
  const after = host.querySelector('i')
  const issues: string[] = []
  const stop = hydrateComponent(app, host, { onHydrationIssue: issue => issues.push(issue.code) })
  const span = host.querySelector('span')
  expect(issues).toEqual(['node_type_mismatch'])
  expect(host.textContent).toBe('0after')
  expect(host.querySelector('i')).toBe(after)
  batch(() => count(1))
  expect(host.querySelector('span')).toBe(span)
  expect(host.textContent).toBe('1after')
  stop()
})
