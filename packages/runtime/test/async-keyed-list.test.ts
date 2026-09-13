import { afterEach, expect, it } from 'vitest'
import { createAsyncMemo } from '../src/async-memo'
import { bindTextContent } from '../src/binding'
import { onCleanup, render, Suspense } from '../src/index'
import { createKeyedList } from '../src/list-helpers'
import { __resetReactiveState, flush, signal } from '../src/signal'
import type { FictNode } from '../src/types'

type Row = { id: number; label: string }
const disposers: (() => void)[] = []
afterEach(() => {
  while (disposers.length) disposers.pop()!()
  __resetReactiveState()
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}
const drain = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  flush()
}

it.each([false, true])(
  'a keyed list resumes in its parked parent (initial pending: %s)',
  async initialPending => {
    const container = document.createElement('div')
    document.body.append(container)
    disposers.push(() => container.remove())
    const initial = deferred<Row[]>()
    const refresh = deferred<Row[]>()
    const obsolete = deferred<Row[]>()
    const latest = deferred<Row[]>()
    const generation = signal(0)
    const rows: Row[] = [
      { id: 1, label: 'first' },
      { id: 2, label: 'second' },
    ]
    let setups = 0
    const created: number[] = []
    const cleaned: number[] = []
    const Child = () => {
      setups++
      const data = createAsyncMemo(() => {
        switch (generation()) {
          case 0:
            return initialPending ? initial.promise : rows
          case 1:
            return refresh.promise
          case 2:
            return obsolete.promise
          default:
            return latest.promise
        }
      })
      const parent = document.createElement('section')
      const start = document.createComment('start')
      const end = document.createComment('end')
      parent.append(start, end)
      const list = createKeyedList(
        () => data(),
        row => row.id,
        item => {
          const id = item().id
          created.push(id)
          onCleanup(() => {
            cleaned.push(id)
          })
          const span = document.createElement('span')
          span.dataset.id = String(id)
          bindTextContent(span, () => item().label)
          return [span]
        },
        false,
        start,
        end,
      )
      onCleanup(list.dispose)
      return parent
    }
    const stop = render(
      () => ({
        type: Suspense as unknown as (props: Record<string, unknown>) => FictNode,
        props: { fallback: 'loading', children: { type: Child, props: {} } },
      }),
      container,
    )
    disposers.push(stop)
    await drain()
    if (initialPending) {
      expect(container.textContent).toBe('loading')
      initial.resolve(rows)
      await drain()
    }
    expect(container.textContent).toBe('firstsecond')
    const section = container.querySelector('section')
    const first = container.querySelector('[data-id="1"]')
    generation(1)
    flush()
    expect(container.textContent).toBe('loading')
    expect(section?.isConnected).toBe(false)
    expect(cleaned).toEqual([])
    refresh.resolve([
      { id: 1, label: 'updated' },
      { id: 3, label: 'third' },
    ])
    await drain()
    expect(container.textContent).toBe('updatedthird')
    expect(container.querySelector('section')).toBe(section)
    expect(container.querySelector('[data-id="1"]')).toBe(first)
    expect(created).toEqual([1, 2, 3])
    expect(cleaned).toEqual([2])
    expect(setups).toBe(1)
    generation(2)
    flush()
    generation(3)
    flush()
    obsolete.resolve([{ id: 99, label: 'obsolete' }])
    await drain()
    expect(container.textContent).toBe('loading')
    expect(created).toEqual([1, 2, 3])
    stop()
    latest.resolve([{ id: 100, label: 'disposed' }])
    await drain()
    expect(container.childNodes).toHaveLength(0)
    expect(created).toEqual([1, 2, 3])
    expect(cleaned.sort()).toEqual([1, 2, 3])
  },
)
