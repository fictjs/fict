import { createHash } from 'node:crypto'

import { getCompilerCacheFingerprint } from '@fictjs/compiler/legacy'
import { describe, expect, it } from 'vitest'

import { readLoadedCompilerArtifact } from '../src/cache-fingerprint'

describe('compiler cache fingerprint', () => {
  it('matches the loaded compiler artifact content', async () => {
    const artifact = readLoadedCompilerArtifact()

    if (!artifact) {
      throw new Error('Expected loaded compiler artifact content')
    }

    const expected = createHash('sha256')
      .update(['fict-compiler-cache-v2', artifact].join('|'))
      .digest('hex')

    expect(getCompilerCacheFingerprint()).toBe(expected)
  })
})
