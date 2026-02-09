import { describe, expect, it } from 'vitest'

import { decodeSessionSnapshot, encodeSessionSnapshot } from '../src/server/share'
import type { PlaygroundSessionSnapshot } from '../src/server/types'

describe('playground share snapshot', () => {
  it('round-trips snapshot payloads', () => {
    const snapshot: PlaygroundSessionSnapshot = {
      version: 1,
      templateId: 'counter',
      entryFile: 'src/App.tsx',
      config: {
        profile: 'app-default',
        strictGuarantee: true,
        strictReactivity: false,
        lazyConditional: true,
        resumable: false,
        functionSplitting: false,
        devtools: false,
      },
      files: {
        'src/main.tsx': 'console.log(1)\n',
      },
    }

    const token = encodeSessionSnapshot(snapshot)
    expect(token.length).toBeGreaterThan(5)

    const decoded = decodeSessionSnapshot(token)
    expect(decoded).toEqual(snapshot)
  })

  it('throws on invalid payload', () => {
    expect(() => decodeSessionSnapshot('invalid-token')).toThrow()
  })
})
