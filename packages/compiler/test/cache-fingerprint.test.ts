import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { getCompilerCacheFingerprint } from '@fictjs/compiler'
import { describe, expect, it } from 'vitest'

describe('compiler cache fingerprint', () => {
  it('matches the loaded compiler artifact content', async () => {
    const compilerUrl = import.meta.resolve('@fictjs/compiler')
    const compilerPath = fileURLToPath(compilerUrl)
    const artifact = readFileSync(compilerPath, 'utf8')
    const expected = createHash('sha256')
      .update(['fict-compiler-cache-v2', artifact].join('|'))
      .digest('hex')

    expect(getCompilerCacheFingerprint()).toBe(expected)
  })
})
