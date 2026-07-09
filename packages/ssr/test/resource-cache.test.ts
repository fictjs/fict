import { describe, expect, it, vi } from 'vitest'

import { Suspense } from '@fictjs/runtime'
import { resource } from 'fict/plus'

import { renderToString, renderToStringAsync } from '../src/index'

describe('SSR resource cache isolation', () => {
  it('waits for suspense-enabled resources in async string renders', async () => {
    let resolveFetch!: (value: string) => void
    const viewerResource = resource<string, string>({
      suspense: true,
      fetch: () =>
        new Promise(resolve => {
          resolveFetch = resolve
        }),
    })

    const View = () => {
      const viewer = viewerResource.read('current-user')
      return { type: 'span', props: { children: viewer.data } }
    }

    const htmlPromise = renderToStringAsync(
      () => ({
        type: Suspense as any,
        props: {
          fallback: { type: 'span', props: { children: 'loading user' } },
          children: { type: View, props: {} },
        },
      }),
      { includeSnapshot: false },
    )

    expect(resolveFetch).toBeTypeOf('function')
    resolveFetch('Alice')

    const html = await htmlPromise
    expect(html).toContain('Alice')
    expect(html).not.toContain('loading user')
  })

  it('keeps default resource data isolated across SSR requests', async () => {
    let currentUser = 'Alice'
    const fetcher = vi.fn(() => Promise.resolve(currentUser))
    const viewerResource = resource<string, string>(fetcher)

    const View = () => {
      const viewer = viewerResource.read('current-user')
      return {
        type: 'span',
        props: { children: viewer.data ?? `loading:${currentUser}` },
      }
    }

    const aliceHtml = renderToString(() => ({ type: View, props: {} }), {
      includeSnapshot: false,
    })
    expect(aliceHtml).toContain('loading:Alice')

    await Promise.resolve()
    await Promise.resolve()

    currentUser = 'Bob'
    const bobHtml = renderToString(() => ({ type: View, props: {} }), {
      includeSnapshot: false,
    })

    expect(bobHtml).toContain('loading:Bob')
    expect(bobHtml).not.toContain('Alice')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
