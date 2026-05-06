import { describe, expect, it } from 'vitest'

import { minimizeSourceByLines } from '../src'

describe('source regression minimizer', () => {
  it('removes irrelevant lines while preserving the repro predicate', async () => {
    const result = await minimizeSourceByLines({
      source: [
        "import { $state } from 'fict'",
        'const unused = 1',
        'export function App() {',
        '  const count = $state(0)',
        '  const ignored = unused + 1',
        '  return <div>{count}</div>',
        '}',
      ].join('\n'),
      test: candidate => candidate.includes('$state(0)') && candidate.includes('{count}'),
    })

    expect(result.changed).toBe(true)
    expect(result.removedLines).toBeGreaterThan(0)
    expect(result.source).toContain('$state(0)')
    expect(result.source).toContain('{count}')
    expect(result.source).not.toContain('ignored')
  })

  it('keeps preserved lines even when the predicate would allow deleting them', async () => {
    const result = await minimizeSourceByLines({
      source: ['// keep: repro id', 'const noise = 1', 'target()'].join('\n'),
      preserve: [/keep: repro id/],
      test: candidate => candidate.includes('target()'),
    })

    expect(result.source).toContain('// keep: repro id')
    expect(result.source).toContain('target()')
    expect(result.source).not.toContain('noise')
  })

  it('rejects inputs that do not reproduce before minimization', async () => {
    await expect(
      minimizeSourceByLines({
        source: 'const value = 1',
        test: candidate => candidate.includes('missing()'),
      }),
    ).rejects.toThrow(/does not reproduce/)
  })
})
