import { describe, expect, it } from 'vitest'

import { minimizeSourceByLines } from '../src'

describe('source regression minimizer', () => {
  it.each(['rust', 'legacy'] as const)(
    'passes the selected %s compiler backend to every predicate evaluation',
    async backend => {
      const observed: string[] = []
      const result = await minimizeSourceByLines({
        source: ['target()', 'noise()'].join('\n'),
        backend,
        test: (candidate, context) => {
          observed.push(context.backend)
          return candidate.includes('target()')
        },
      })

      expect(result.source).toBe('target()')
      expect(new Set(observed)).toEqual(new Set([backend]))
    },
  )

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

  it('keeps preserved lines when preserve patterns are stateful regexes', async () => {
    for (const pattern of [/\/\/ keep/g, /\/\/ keep/y]) {
      const result = await minimizeSourceByLines({
        source: ['// keep: first', 'target()', '// keep: second'].join('\n'),
        preserve: [pattern],
        test: candidate => candidate.includes('target()'),
      })

      expect(result.source).toContain('// keep: first')
      expect(result.source).toContain('// keep: second')
      expect(result.source).toContain('target()')
    }
  })

  it('rejects inputs that do not reproduce before minimization', async () => {
    await expect(
      minimizeSourceByLines({
        source: 'const value = 1',
        test: candidate => candidate.includes('missing()'),
      }),
    ).rejects.toThrow(/does not reproduce/)
  })

  it('honors maxPasses: 0 without invoking the predicate', async () => {
    let calls = 0
    const source = ['target()', 'noise()'].join('\n')

    const result = await minimizeSourceByLines({
      source,
      maxPasses: 0,
      test: () => {
        calls += 1
        return true
      },
    })

    expect(calls).toBe(0)
    expect(result).toMatchObject({
      source,
      removedLines: 0,
      passes: 0,
      predicateCalls: 0,
      chunkPasses: 0,
      changed: false,
    })
  })

  it('counts the initial reproduction check against maxPasses', async () => {
    let calls = 0
    const source = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n')

    const result = await minimizeSourceByLines({
      source,
      maxPasses: 1,
      test: () => {
        calls += 1
        return true
      },
    })

    expect(calls).toBe(1)
    expect(result.source).toBe(source)
    expect(result.passes).toBe(1)
    expect(result.predicateCalls).toBe(1)
    expect(result.chunkPasses).toBe(0)
    expect(result.changed).toBe(false)
  })

  it('skips preserved ranges without spending predicate budget', async () => {
    const candidates: string[] = []

    const result = await minimizeSourceByLines({
      source: ['// keep: repro id', 'target()', 'noise()'].join('\n'),
      preserve: [/keep: repro id/],
      maxPasses: 2,
      test: candidate => {
        candidates.push(candidate)
        return true
      },
    })

    expect(candidates).toEqual([
      ['// keep: repro id', 'target()', 'noise()'].join('\n'),
      ['// keep: repro id', 'target()'].join('\n'),
    ])
    expect(result.source).toBe(['// keep: repro id', 'target()'].join('\n'))
    expect(result.predicateCalls).toBe(2)
    expect(result.chunkPasses).toBe(1)
  })

  it('retries successful removals from the same start within the predicate budget', async () => {
    const candidates: string[] = []

    const result = await minimizeSourceByLines({
      source: ['target()', 'noiseA()', 'noiseB()', '// keep'].join('\n'),
      preserve: [/\/\/ keep/],
      maxPasses: 5,
      test: candidate => {
        candidates.push(candidate)
        return candidate.includes('target()') && candidate.includes('// keep')
      },
    })

    expect(candidates).toEqual([
      ['target()', 'noiseA()', 'noiseB()', '// keep'].join('\n'),
      ['noiseB()', '// keep'].join('\n'),
      ['noiseA()', 'noiseB()', '// keep'].join('\n'),
      ['target()', 'noiseB()', '// keep'].join('\n'),
      ['target()', '// keep'].join('\n'),
    ])
    expect(result.source).toBe(['target()', '// keep'].join('\n'))
    expect(result.predicateCalls).toBe(5)
    expect(result.chunkPasses).toBe(2)
  })

  it('stops unstable predicates when the predicate budget is exhausted', async () => {
    let calls = 0
    const source = ['target()', 'noiseA()', 'noiseB()'].join('\n')

    const result = await minimizeSourceByLines({
      source,
      maxPasses: 2,
      test: () => {
        calls += 1
        return calls % 2 === 1
      },
    })

    expect(calls).toBe(2)
    expect(result.source).toBe(source)
    expect(result.passes).toBe(2)
    expect(result.predicateCalls).toBe(2)
    expect(result.chunkPasses).toBe(1)
    expect(result.changed).toBe(false)
  })
})
