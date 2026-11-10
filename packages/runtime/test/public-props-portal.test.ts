import { describe, expect, expectTypeOf, it } from 'vitest'

import { createPortal, createRoot, mergeProps, prop, type MergedProps } from '../src/index'
import { createSignal } from '../src/advanced'
import { createPropsProxy, mergeProps as mergeSpread } from '../src/internal'
import { materializePropsForSnapshot } from '../src/props'

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
    expectTypeOf(defaults.value).toEqualTypeOf<number | boolean>()
    expect(defaults.value).toBe(1)
    expect(merged.value).toBe('two')
    const sources: { name: string }[] = []
    const empty = mergeProps(...sources)
    expectTypeOf(empty.name).toEqualTypeOf<string | undefined>()
    expect(empty.name).toBeUndefined()

    const dynamic = mergeProps(prop(() => ({ label: 'dynamic' })))
    expectTypeOf(dynamic.label).toEqualTypeOf<string>()
    expect(dynamic.label).toBe('dynamic')
  })
})

it('resolves undefined defaults lazily across strings, symbols, getters and dynamic sources', () => {
  const token = Symbol('token')
  const value = createSignal<string | null | undefined>(undefined)
  let fallbackReads = 0
  const fallback = prop(() => {
    fallbackReads++
    return 'fallback'
  })
  const dynamic = prop(() => ({ label: value(), [token]: value() }))
  const merged = mergeProps(
    { label: fallback, [token]: 'symbol', zero: 1, empty: 'filled' },
    dynamic,
    { zero: 0, empty: '' },
  )
  expect(fallbackReads).toBe(0)
  expectTypeOf(merged.label).toEqualTypeOf<string | null>()
  expect(merged.label).toBe('fallback')
  expect(merged[token]).toBe('symbol')
  expect(merged.zero).toBe(0)
  expect(merged.empty).toBe('')
  expect(fallbackReads).toBe(1)
  value('override')
  expect(merged.label).toBe('override')
  expect(merged[token]).toBe('override')
  expect(fallbackReads).toBe(1)
  value(null)
  expect(merged.label).toBeNull()
  value(undefined)
  expect(merged.label).toBe('fallback')
  expect(Object.getOwnPropertyDescriptor(merged, 'label')?.value).toBe('fallback')
  expect(materializePropsForSnapshot(merged).label).toBe('fallback')
  const spread = createPropsProxy(mergeSpread({ label: 'fallback' }, { label: undefined }))
  expect(spread.label).toBeUndefined()
  expect(materializePropsForSnapshot(spread).label).toBeUndefined()
})
