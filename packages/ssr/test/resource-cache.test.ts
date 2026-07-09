import { describe, expect, it, vi } from 'vitest'

import { resource } from 'fict/plus'

import { renderToString } from '../src/index'

describe('SSR resource cache isolation', () => {
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
