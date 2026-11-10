import { describe, expect, expectTypeOf, it } from 'vitest'

import { createPortal, createRoot, mergeProps, prop, type MergedProps } from '../src/index'
import { createSignal } from '../src/advanced'
import type { PropGetter } from '../src/props'

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve))

describe('public portal and props contracts', () => {
  for (const selector of [false, true]) {
    it(`renders, updates and disposes through the public portal signature (selector=${selector})`, async () => {
      const target = document.createElement('div')
      target.id = 'public-portal-target'
      document.body.appendChild(target)
      const label = createSignal('first')
      const root = createRoot(() =>
        createPortal(
          () => ({ type: 'span', props: { children: label() } }),
          selector ? '#public-portal-target' : target,
        ),
      )
      try {
        expect(target.textContent).toBe('first')
        label('second')
        await tick()
        expect(target.textContent).toBe('second')
        root.dispose()
        expect(target.childNodes.length).toBe(0)
        root.value.dispose()
      } finally {
        root.dispose()
        target.remove()
      }
    })
  }

  it('reports a missing selector before running portal children', () => {
    let calls = 0
    expect(() =>
      createPortal(() => {
        calls++
        return 'content'
      }, '#missing-portal-target'),
    ).toThrow('Portal target not found: #missing-portal-target')
    expect(calls).toBe(0)
  })

  it('preserves merged property types and later-source overrides', () => {
    const token = Symbol('token')
    const merged = mergeProps({ title: 'hello', value: 1 }, { value: 'two', [token]: true })
    expectTypeOf(merged.title).toEqualTypeOf<string>()
    expectTypeOf(merged.value).toEqualTypeOf<string>()
    expectTypeOf(merged[token]).toEqualTypeOf<boolean>()
    expectTypeOf<MergedProps<[{ name: string }, { count: number }]>>().toEqualTypeOf<{
      name: string
      count: number
    }>()
    const optional: { value?: boolean } = {}
    const defaults = mergeProps({ value: 1 }, optional, null, undefined)
    expectTypeOf(defaults.value).toEqualTypeOf<number | boolean | undefined>()
    expect(defaults.value).toBe(1)
    expect(merged.value).toBe('two')
    const sources: { name: string }[] = []
    const empty = mergeProps(...sources)
    expectTypeOf(empty.name).toEqualTypeOf<string | undefined>()
    expect(empty.name).toBeUndefined()

    const dynamic = mergeProps(prop(() => ({ label: 'dynamic' })))
    expectTypeOf(dynamic.label).toEqualTypeOf<PropGetter<string>>()
    expect(dynamic.label()).toBe('dynamic')
  })
})
