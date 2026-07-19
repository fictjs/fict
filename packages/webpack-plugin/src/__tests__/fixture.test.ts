import { readFile } from 'node:fs/promises'

import type { Stats } from 'webpack'

import { createBuildQueue, waitForWatchingReady } from './fixture'

describe('@fictjs/webpack-plugin build queue', () => {
  it('waits for requested files to enter the underlying watcher snapshot', async () => {
    const filename = '/fixture/hook.fict.meta.json'
    let snapshotReads = 0
    const watching = {
      closed: false,
      watcher: {
        getInfo: () => ({
          changes: null,
          removals: null,
          fileTimeInfoEntries: new Map<string, null>(
            ++snapshotReads >= 2 ? [[filename, null]] : [],
          ),
          contextTimeInfoEntries: new Map(),
        }),
      },
    } as unknown as Parameters<typeof waitForWatchingReady>[0]

    await waitForWatchingReady(watching, { files: [filename], timeoutMs: 100 })

    expect(snapshotReads).toBe(2)
  })

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

describe('@fictjs/webpack-plugin package entrypoints', () => {
  it('does not import the Node 22-only findPackageJSON API', async () => {
    const entries = await Promise.all(
      ['index.js', 'index.cjs'].map(filename =>
        readFile(new URL(`../../dist/${filename}`, import.meta.url), 'utf8'),
      ),
    )

    for (const entry of entries) expect(entry).not.toContain('findPackageJSON')
  })

  it('ships the native loader without Babel production dependencies', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    const dependencies = Object.keys(packageJson.dependencies ?? {})

    expect(dependencies.some(dependency => dependency.startsWith('@babel/'))).toBe(false)
    expect(dependencies).not.toContain('@fictjs/babel-preset')
    expect(dependencies).toEqual(['@fictjs/compiler'])
  })
})
