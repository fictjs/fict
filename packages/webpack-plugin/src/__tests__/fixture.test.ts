import type { Stats } from 'webpack'

import { createBuildQueue } from './fixture'

describe('@fictjs/webpack-plugin build queue', () => {
  it('removes a timed-out matcher before the next build arrives', async () => {
    const builds = createBuildQueue()

    await expect(
      builds.nextMatching(() => false, {
        description: 'a test build',
        timeoutMs: 20,
      }),
    ).rejects.toThrow(
      'Timed out after 20ms waiting for a test build; observed 0 non-matching build(s).',
    )

    const nextBuild = builds.next()
    const stats = { hasErrors: () => false } as Stats
    builds.push(undefined, stats)
    await expect(nextBuild).resolves.toBe(stats)
  })

  it('propagates a matching build error immediately', async () => {
    const builds = createBuildQueue()
    const failure = new Error('watch build failed')
    const matching = builds.nextMatching(() => true, {
      description: 'a successful test build',
    })
    const rejection = expect(matching).rejects.toBe(failure)

    builds.push(failure, undefined)

    await rejection
  })
})
