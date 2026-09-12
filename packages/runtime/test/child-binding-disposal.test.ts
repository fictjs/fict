import { describe, expect, it } from 'vitest'

import { batch, createEffect, onCleanup, render } from '../src/index'
import { createSignal, reactive } from '../src/advanced'
import { insert, insertBetween, createChildBinding, assign } from '../src/binding'
import { createElement } from '../src/dom'
import type { FictNode } from '../src/types'

describe('dynamic child binding disposal', () => {
  it.each([
    { mode: 'insert', phase: 'getter' },
    { mode: 'insert', phase: 'render' },
    { mode: 'children', phase: 'getter' },
    { mode: 'children', phase: 'render' },
    { mode: 'between', phase: 'getter' },
    { mode: 'between', phase: 'render' },
    { mode: 'assigned', phase: 'getter' },
    { mode: 'assigned', phase: 'render' },
  ])('releases the pending child when $mode destroys its host during $phase', ({ mode, phase }) => {
    const host = document.createElement('div')
    const source = createSignal(0)
    const version = createSignal(0)
    let runs = 0
    let cleanups = 0
    let stop = () => {}
    const Child = () => {
      createEffect(() => {
        source()
        runs++
      })
      onCleanup(() => {
        cleanups++
      })
      if (phase === 'render') stop()
      return { type: 'span', props: { children: 'child' } }
    }
    const value = (): FictNode => {
      if (version() === 0) return 'initial'
      if (phase === 'getter') stop()
      return { type: Child, props: {} }
    }
    stop = render(() => {
      const box = document.createElement('div')
      if (mode === 'insert') insert(box, value, createElement)
      else if (mode === 'children') createChildBinding(box, reactive(value), createElement)
      else if (mode === 'assigned') assign(box, { children: reactive(value) })
      else {
        const start = document.createComment('start')
        const end = document.createComment('end')
        box.append(start, end)
        insertBetween(start, end, value, createElement)
      }
      return box
    }, host)
    try {
      batch(() => version(1))
      expect(host.textContent).toBe('')
      expect(cleanups).toBe(runs)
      const before = runs
      batch(() => source(1))
      expect(runs).toBe(before)
    } finally {
      stop()
    }
  })
})
