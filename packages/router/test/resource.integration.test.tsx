import { Suspense } from '@fictjs/runtime'
import { render, screen } from '@fictjs/testing-library'
import { describe, expect, it, vi } from 'vitest'

import { createResource } from '../src/data'

describe('createResource Suspense integration', () => {
  it('renders a fallback until the resource request resolves', async () => {
    let resolveRequest!: (value: string) => void
    const request = new Promise<string>(resolve => {
      resolveRequest = resolve
    })
    const resource = createResource(
      () => 'key',
      () => request,
      { suspense: true },
    )

    function ResourceView() {
      return <span data-testid="resource-value">{resource()}</span>
    }

    render(() => (
      <Suspense fallback={<span data-testid="resource-loading">loading</span>}>
        <ResourceView />
      </Suspense>
    ))

    expect(screen.getByTestId('resource-loading').textContent).toBe('loading')

    resolveRequest('ready')

    await vi.waitFor(() => {
      expect(screen.getByTestId('resource-value').textContent).toBe('ready')
    })
    expect(screen.queryByTestId('resource-loading')).toBeNull()
  })
})
