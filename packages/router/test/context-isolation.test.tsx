import { describe, expect, it, vi } from 'vitest'

import { untrack } from '@fictjs/runtime'
import { act, render } from '@fictjs/testing-library'

import { renderToDocument, renderToString } from '../../ssr/src/index'
import { useBeforeLeave, useLocation, useNavigate } from '../src/context'
import { createMemoryHistory } from '../src/history'
import { RouterProvider } from '../src/router-provider'

function RouterProbe(props: { id: string; next: string }) {
  const location = useLocation()
  const navigate = useNavigate()

  return (
    <section data-testid={`${props.id}-root`}>
      <span data-testid={`${props.id}-path`}>{location().pathname}</span>
      <button data-testid={`${props.id}-navigate`} onClick={() => navigate(props.next)}>
        navigate
      </button>
    </section>
  )
}

function GuardedRouterProbe(props: { id: string; next: string; onGuard: () => void }) {
  const onGuard = untrack(() => props.onGuard)
  useBeforeLeave(event => {
    onGuard()
    event.retry(true)
  })

  return <RouterProbe id={props.id} next={props.next} />
}

function OutsideProbe(props: { onGuard: () => void }) {
  const location = useLocation()
  const navigate = useNavigate()
  const onGuard = untrack(() => props.onGuard)
  useBeforeLeave(onGuard)

  return (
    <section>
      <span data-testid="outside-path">{location().pathname}</span>
      <button data-testid="outside-navigate" onClick={() => navigate('/outside-target')}>
        navigate
      </button>
    </section>
  )
}

function SsrLocationProbe() {
  const location = useLocation()
  return <span>{location().pathname}</span>
}

function ssrTextContent(html: string): string | null {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content.textContent
}

describe('router context isolation', () => {
  it('keeps independent DOM roots bound to their own router and guard context', async () => {
    const firstHistory = createMemoryHistory({ initialEntries: ['/first'] })
    const secondHistory = createMemoryHistory({ initialEntries: ['/second'] })
    const firstGuard = vi.fn()
    const secondGuard = vi.fn()

    const first = render(() => (
      <RouterProvider history={firstHistory} routes={[]}>
        <GuardedRouterProbe id="first" next="/first-next" onGuard={firstGuard} />
      </RouterProvider>
    ))
    const second = render(() => (
      <RouterProvider history={secondHistory} routes={[]}>
        <GuardedRouterProbe id="second" next="/second-next" onGuard={secondGuard} />
      </RouterProvider>
    ))

    expect(first.getByTestId('first-path').textContent).toBe('/first')
    expect(second.getByTestId('second-path').textContent).toBe('/second')

    await act(async () => {
      first.getByTestId('first-navigate').click()
    })

    await vi.waitFor(() => expect(firstHistory.location.pathname).toBe('/first-next'))
    expect(secondHistory.location.pathname).toBe('/second')
    expect(firstGuard).toHaveBeenCalledOnce()
    expect(secondGuard).not.toHaveBeenCalled()

    await act(async () => {
      second.getByTestId('second-navigate').click()
    })

    await vi.waitFor(() => expect(secondHistory.location.pathname).toBe('/second-next'))
    expect(firstHistory.location.pathname).toBe('/first-next')
    expect(secondGuard).toHaveBeenCalledOnce()
  })

  it('uses the nearest nested router and before-leave provider', async () => {
    const outerHistory = createMemoryHistory({ initialEntries: ['/outer'] })
    const innerHistory = createMemoryHistory({ initialEntries: ['/inner'] })
    const outerGuard = vi.fn()
    const innerGuard = vi.fn()

    const view = render(() => (
      <RouterProvider history={outerHistory} routes={[]}>
        <GuardedRouterProbe id="outer" next="/outer-next" onGuard={outerGuard} />
        <RouterProvider history={innerHistory} routes={[]}>
          <GuardedRouterProbe id="inner" next="/inner-next" onGuard={innerGuard} />
        </RouterProvider>
      </RouterProvider>
    ))

    expect(view.getByTestId('outer-path').textContent).toBe('/outer')
    expect(view.getByTestId('inner-path').textContent).toBe('/inner')

    await act(async () => {
      view.getByTestId('inner-navigate').click()
    })

    await vi.waitFor(() => expect(innerHistory.location.pathname).toBe('/inner-next'))
    expect(outerHistory.location.pathname).toBe('/outer')
    expect(innerGuard).toHaveBeenCalledOnce()
    expect(outerGuard).not.toHaveBeenCalled()

    await act(async () => {
      view.getByTestId('outer-navigate').click()
    })

    await vi.waitFor(() => expect(outerHistory.location.pathname).toBe('/outer-next'))
    expect(outerGuard).toHaveBeenCalledOnce()
    expect(innerGuard).toHaveBeenCalledOnce()
  })

  it('keeps provider-less hooks on stable defaults while routers mount and unmount', async () => {
    const firstHistory = createMemoryHistory({ initialEntries: ['/first'] })
    const secondHistory = createMemoryHistory({ initialEntries: ['/second'] })
    const outsideGuard = vi.fn()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const first = render(() => (
      <RouterProvider history={firstHistory} routes={[]}>
        <RouterProbe id="first" next="/first-next" />
      </RouterProvider>
    ))
    const second = render(() => (
      <RouterProvider history={secondHistory} routes={[]}>
        <RouterProbe id="second" next="/second-next" />
      </RouterProvider>
    ))
    const outside = render(() => <OutsideProbe onGuard={outsideGuard} />)

    try {
      expect(outside.getByTestId('outside-path').textContent).toBe('/')

      await act(async () => {
        outside.getByTestId('outside-navigate').click()
      })

      expect(warning).toHaveBeenCalledWith(
        '[fict-router] No router found. Wrap your app in a <Router>',
      )
      expect(firstHistory.location.pathname).toBe('/first')
      expect(secondHistory.location.pathname).toBe('/second')
      expect(outsideGuard).not.toHaveBeenCalled()

      await act(async () => {
        secondHistory.push('/second-next')
      })

      expect(secondHistory.location.pathname).toBe('/second-next')
      expect(outsideGuard).not.toHaveBeenCalled()
      expect(outside.getByTestId('outside-path').textContent).toBe('/')

      first.unmount()
      expect(outside.getByTestId('outside-path').textContent).toBe('/')

      second.unmount()
      expect(outside.getByTestId('outside-path').textContent).toBe('/')
    } finally {
      warning.mockRestore()
    }
  })

  it('keeps overlapping SSR roots from becoming the provider-less default', () => {
    const firstHistory = createMemoryHistory({ initialEntries: ['/ssr-first'] })
    const secondHistory = createMemoryHistory({ initialEntries: ['/ssr-second'] })
    const firstRequest = renderToDocument(
      () => (
        <RouterProvider history={firstHistory} routes={[]}>
          <SsrLocationProbe />
        </RouterProvider>
      ),
      { includeSnapshot: false },
    )
    const secondRequest = renderToDocument(
      () => (
        <RouterProvider history={secondHistory} routes={[]}>
          <SsrLocationProbe />
        </RouterProvider>
      ),
      { includeSnapshot: false },
    )
    let secondDisposed = false

    try {
      expect(firstRequest.html).toContain('/ssr-first')
      expect(secondRequest.html).toContain('/ssr-second')
      expect(
        ssrTextContent(renderToString(() => <SsrLocationProbe />, { includeSnapshot: false })),
      ).toBe('/')

      secondRequest.dispose()
      secondDisposed = true
      expect(
        ssrTextContent(renderToString(() => <SsrLocationProbe />, { includeSnapshot: false })),
      ).toBe('/')
    } finally {
      if (!secondDisposed) secondRequest.dispose()
      firstRequest.dispose()
    }
  })
})
