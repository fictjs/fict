import { describe, expect, it } from 'vitest'

import { createEffect, createStore } from '../src/index'

const tick = () => Promise.resolve()

describe('createStore iteration tracking', () => {
  it('tracks ownKeys/for-in when keys change', async () => {
    const [state, setState] = createStore<{ foo?: string; bar?: string }>({ foo: 'a' })
    const seen: string[][] = []

    createEffect(() => {
      seen.push(Object.keys(state))
    })

    await tick()
    expect(seen[seen.length - 1]).toEqual(['foo'])

    setState(s => {
      ;(s as any).bar = 'b'
    })
    await tick()
    expect(seen[seen.length - 1]).toContain('bar')

    setState(s => {
      delete (s as any).foo
    })
    await tick()
    expect(seen[seen.length - 1]).toEqual(['bar'])
  })
})
